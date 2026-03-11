/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import {
  clearHippiusDesktopDB,
} from "./helpers/hippiusDesktopDB";
import { clearAllData as clearSyncProgressData } from "./services/syncProgressService";

import { useRouter } from "next/navigation";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTrayInit } from "./hooks/useTraySync";
import { tryAutoInitSync } from "./hooks/useHcfsSync";
import { ensureSyncMnemonic } from "./helpers/ensureSyncMnemonic";
import { appStore } from "./store/jotaiStore";
import { migrationCheckAtom } from "./global-atoms/migrationAtoms";

/** Result from Rust login_with_mnemonic / unlock_with_passcode commands */
interface LoginResult {
  substrateAddress: string;
  ethAddress: string;
  userId: number;
  username: string;
  provider: string;
  token: string;
  tokenExpiry: number;
  isNew: boolean;
}

async function checkMigrationAfterLogin(accountId: string) {
  try {
    const result = await invoke<{
      needs_migration: boolean;
      file_count: number;
      total_size: number;
    }>("check_migration", { accountId });

    if (result.needs_migration) {
      appStore.set(migrationCheckAtom, {
        checked: true,
        needsMigration: true,
        fileCount: result.file_count,
        totalSize: result.total_size,
      });
    }
  } catch (err) {
    console.error("[WalletAuth] Migration check failed:", err);
  }
}

interface WalletContextType {
  isAuthenticated: boolean;
  address: string | null;
  polkadotAddress: string | null;
  isLoading: boolean;
  walletManager: {
    polkadotPair: any;
  } | null;
  authType: "mnemonic" | "oauth" | null;
  oauthSession: import("@/app/lib/types/oAuth").OAuthSession | null;
  getMnemonic: () => Promise<string | null>;
  login: (mnemonic: string) => Promise<void>;
  setOAuthSession: (
    session: import("@/app/lib/types/oAuth").OAuthSession
  ) => Promise<void>;
  setSession: (
    mnemonic: string,
    logoutTimeInMinutes?: number
  ) => Promise<boolean>;
  unlockWithPasscode: (
    passcode: string,
    logoutTimeInMinutes?: number
  ) => Promise<boolean>;
  logout: (redirectPath?: string) => Promise<void>;
  resetHippiusDesktop: () => Promise<void>;
  sessionTimeRemaining: number | null;
}
const MAX_DELAY = 2_147_483_647; // ~24.8 days

// Helper function to validate token
const isTokenValid = (token: string | null | undefined, expiresAt?: string): boolean => {
  if (!token || token.trim() === "") {
    return false;
  }

  if (expiresAt) {
    try {
      const expirationTime = new Date(expiresAt).getTime();
      const currentTime = Date.now();

      if (currentTime >= expirationTime) {
        console.log("[WalletAuth] Token has expired");
        return false;
      }
    } catch (err) {
      console.error("[WalletAuth] Failed to parse expiration date:", err);
      return false;
    }
  }

  return true;
};

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletAuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [polkadotAddress, setPolkadotAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [walletManager, setWalletManager] = useState<{
    polkadotPair: any;
  } | null>(null);
  const [authType, setAuthType] = useState<"mnemonic" | "oauth" | null>(null);
  const [oauthSession, setOAuthSessionState] = useState<
    import("@/app/lib/types/oAuth").OAuthSession | null
  >(null);
  const [sessionTimeRemaining, setSessionTimeRemaining] = useState<
    number | null
  >(null);

  const syncInitialized = useRef(false);
  const logoutTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Keep the login mnemonic in-memory so getMnemonic() can return it
  // even before a Drive is initialized (e.g. on a new device before
  // the user creates their first sync folder).
  const sessionMnemonicRef = useRef<string | null>(null);

  const ensureTempAuthKey = useCallback(
    async (accountId?: string | null, token?: string | null) => {
      if (!accountId || !token) return;
      try {
        await invoke("save_temp_auth_key_command", {
          accountId,
          tempAuthKey: token,
        });
      } catch (err) {
        console.error("[WalletAuth] Failed to persist temp auth key:", err);
      }
    },
    []
  );

  const getMnemonic = useCallback(async (): Promise<string | null> => {
    // 1. Try the Rust Drive backend (master mnemonic on disk)
    try {
      if (polkadotAddress) {
        const result = await invoke<string>("get_drive_mnemonic", { accountId: polkadotAddress });
        if (result) return result;
      }
    } catch {
      // Drive not initialized or password unavailable — fall through
    }
    // 2. Fall back to the in-memory login mnemonic. This covers the
    //    case where the user logged in on a new device but hasn't
    //    created a sync folder yet (no Drive on disk).
    return sessionMnemonicRef.current;
  }, [polkadotAddress]);

  const logout = useCallback(
    async (redirectPath?: string) => {
      try {
        console.log("[WalletAuth] Starting sync cleanup...");
        await invoke("stop_sync").catch(() => { });
        console.log("[WalletAuth] Sync cleanup completed");

        // Clear auth session in Rust DB (preserves logout_time_minutes preference)
        if (polkadotAddress) {
          await invoke("clear_auth_session", { accountId: polkadotAddress }).catch((err: unknown) =>
            console.error("[WalletAuth] Failed to clear auth session:", err)
          );
        }

        // Clear OAuth session and token if present
        if (typeof window !== "undefined") {
          localStorage.removeItem("hippius_oauth_session");
          localStorage.removeItem("hippius_oauth_session_expiry");
          localStorage.removeItem("hippius_token");
          localStorage.removeItem("hippius_token_expiry");
        }

        // Clear sync progress state to prevent stale data on next login
        console.log("[WalletAuth] Clearing sync progress state...");
        clearSyncProgressData();
      } catch (error) {
        console.error("Failed to cleanup sync on logout:", error);
      }

      // Clear the logout timer if it exists
      if (logoutTimerRef.current) {
        clearTimeout(logoutTimerRef.current);
        logoutTimerRef.current = null;
      }

      setAddress(null);
      setPolkadotAddress(null);
      setWalletManager(null);
      setAuthType(null);
      setOAuthSessionState(null);
      setIsAuthenticated(false);
      setSessionTimeRemaining(null);
      syncInitialized.current = false; // Reset sync flag for next login
      sessionMnemonicRef.current = null;

      // Optionally redirect after logout
      if (redirectPath && typeof window !== "undefined") {
        router.push(redirectPath);
      }
    },
    [router, polkadotAddress]
  );

  function scheduleLogout(ms: number) {
    if (ms === Infinity) return; // keep me logged in

    const delay = Math.min(Math.max(ms, 0), MAX_DELAY);
    logoutTimerRef.current = setTimeout(() => {
      if (ms > MAX_DELAY) {
        scheduleLogout(ms - MAX_DELAY); // chain next chunk
      } else {
        logout();
      }
    }, delay);
  }

  useEffect(() => {
    const bootOnce = { done: false }; // local guard

    const setupSessionTimeout = async () => {
      if (bootOnce.done) return;
      bootOnce.done = true;

      if (logoutTimerRef.current) {
        clearTimeout(logoutTimerRef.current);
        logoutTimerRef.current = null;
      }

      // First, check for OAuth session in localStorage
      if (typeof window !== "undefined") {
        const storedSession = localStorage.getItem("hippius_oauth_session");
        const storedExpiry = localStorage.getItem(
          "hippius_oauth_session_expiry"
        );

        if (storedSession && storedExpiry) {
          // Parse expiry - handle both ISO string and timestamp formats
          const expiryTime = isNaN(Number(storedExpiry))
            ? new Date(storedExpiry).getTime()
            : parseInt(storedExpiry, 10);

          // Check if session is still valid
          if (Date.now() < expiryTime) {
            try {
              const oauthSessionData = JSON.parse(storedSession);

              // Validate token before restoring session
              if (!isTokenValid(oauthSessionData.token, oauthSessionData.expiresAt)) {
                console.log("[WalletAuth] Token is invalid or expired, clearing session");
                localStorage.removeItem("hippius_oauth_session");
                localStorage.removeItem("hippius_oauth_session_expiry");
                localStorage.removeItem("hippius_token");
                localStorage.removeItem("hippius_token_expiry");
                await logout("/login");
                return;
              }

              console.log(
                "[WalletAuth] Restoring OAuth session:",
                oauthSessionData.username
              );

              // Restore OAuth session state
              setOAuthSessionState(oauthSessionData);
              setPolkadotAddress(oauthSessionData.substrateAddress || null);
              setAuthType(
                oauthSessionData.provider === "mnemonic" ? "mnemonic" : "oauth"
              );
              setIsAuthenticated(true);
              await ensureTempAuthKey(
                oauthSessionData.substrateAddress,
                oauthSessionData.token
              );

              // For mnemonic-based auth on boot restore: don't derive keypair
              // from plaintext. walletManager stays null until user performs a
              // staking action (passcode prompt). Sync init doesn't need the
              // mnemonic — Rust fetches it from the encrypted Drive.
              if (oauthSessionData.provider === "mnemonic") {
                if (
                  oauthSessionData.substrateAddress &&
                  !syncInitialized.current
                ) {
                  try {
                    syncInitialized.current = true;
                    await invoke("stop_sync").catch(() => { });
                    tryAutoInitSync(
                      oauthSessionData.substrateAddress
                    ).catch((err) =>
                      console.error("[WalletAuth] Failed to start sync for mnemonic restore:", err)
                    );
                    checkMigrationAfterLogin(oauthSessionData.substrateAddress).catch((err) =>
                      console.error("[WalletAuth] Migration check error:", err)
                    );
                  } catch (err) {
                    console.error("[WalletAuth] Failed to start sync for mnemonic restore:", err);
                  }
                }
                console.log(
                  "[WalletAuth] Mnemonic session restored (keypair deferred)"
                );
              } else if (
                // For pure OAuth sessions, generate/retrieve mnemonic and initialize sync
                oauthSessionData.substrateAddress &&
                !syncInitialized.current
              ) {
                try {
                  syncInitialized.current = true;
                  await invoke("stop_sync").catch(() => { });
                  const mnemonic = await ensureSyncMnemonic(oauthSessionData.substrateAddress);
                  tryAutoInitSync(oauthSessionData.substrateAddress, mnemonic).catch((err) =>
                    console.error("[WalletAuth] Failed to start sync for OAuth restore:", err)
                  );
                  checkMigrationAfterLogin(oauthSessionData.substrateAddress).catch((err) =>
                    console.error("[WalletAuth] Migration check error:", err)
                  );
                } catch (err) {
                  console.error("[WalletAuth] Failed to start sync for OAuth restore:", err);
                }
              }

              console.log("[WalletAuth] OAuth session restored");
              return; // Skip mnemonic-only session check
            } catch (error) {
              console.error(
                "[WalletAuth] Failed to restore OAuth session:",
                error
              );
              // Clear invalid session data
              localStorage.removeItem("hippius_oauth_session");
              localStorage.removeItem("hippius_oauth_session_expiry");
              localStorage.removeItem("hippius_token");
              localStorage.removeItem("hippius_token_expiry");
            }
          } else {
            console.log("[WalletAuth] OAuth session expired, clearing");
            localStorage.removeItem("hippius_oauth_session");
            localStorage.removeItem("hippius_oauth_session_expiry");
            localStorage.removeItem("hippius_token");
            localStorage.removeItem("hippius_token_expiry");
          }
        }
      }

      // Check for persisted auth session in Rust DB
      let lastSession: {
        authToken: string | null;
        tokenExpiry: number | null;
        userId: number | null;
        username: string | null;
        provider: string | null;
        substrateAddress: string | null;
        logoutTimeMinutes: number | null;
        lastLoginAt: string | null;
      } | null = null;
      try {
        lastSession = await invoke("get_last_auth_session");
      } catch {
        // DB not ready yet — fall through
      }

      if (!lastSession || !lastSession.authToken) {
        setSessionTimeRemaining(null);
        return;
      }

      // Validate token expiry
      if (lastSession.tokenExpiry && lastSession.tokenExpiry < Date.now()) {
        console.log("[WalletAuth] Token expired for session, redirecting to login");
        if (lastSession.substrateAddress) {
          await invoke("clear_auth_session", { accountId: lastSession.substrateAddress }).catch(() => {});
        }
        localStorage.removeItem("hippius_token");
        localStorage.removeItem("hippius_token_expiry");
        await logout("/login");
        return;
      }

      // Session exists with valid token — restore state.
      // Can't derive keypair without plaintext mnemonic, so just mark
      // authenticated. The user will get a passcode prompt for staking.
      if (lastSession.substrateAddress) {
        setPolkadotAddress(lastSession.substrateAddress);
      }
      setIsAuthenticated(true);

      const effMinutes = lastSession.logoutTimeMinutes ?? 1440;
      if (effMinutes === -1) {
        // "Keep me logged in" — no timeout
      } else {
        const timeRemaining = effMinutes * 60_000;
        setSessionTimeRemaining(Math.max(timeRemaining, 0));
        scheduleLogout(timeRemaining);
      }

      router.push("/");
    };

    setupSessionTimeout();

    return () => {
      if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logout, router]);

  // Silently refresh the auth token when the sync server returns 401.
  // Only works for mnemonic-based auth (we have the mnemonic in the encrypted drive).
  // Cooldown prevents retry storms when the auth API itself is down.
  const refreshingTokenRef = useRef(false);
  const lastRefreshAttemptRef = useRef(0);
  const TOKEN_REFRESH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    listen<{ label: string }>("hcfs_auth_token_expired", async () => {
      const now = Date.now();
      const elapsed = now - lastRefreshAttemptRef.current;
      if (
        refreshingTokenRef.current ||
        !isAuthenticated ||
        !polkadotAddress ||
        elapsed < TOKEN_REFRESH_COOLDOWN_MS
      ) {
        return;
      }
      refreshingTokenRef.current = true;
      lastRefreshAttemptRef.current = now;
      console.log("[WalletAuth] Auth token expired, attempting silent refresh via Rust");

      try {
        // Rust handles: fetch mnemonic from Drive → derive keys → challenge-response → update token
        await invoke("refresh_auth_token", { accountId: polkadotAddress });
        console.log("[WalletAuth] Auth token refreshed successfully");
      } catch (err) {
        console.error("[WalletAuth] Silent token refresh failed:", err);
      } finally {
        refreshingTokenRef.current = false;
      }
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isAuthenticated, polkadotAddress]);

  const unlockWithPasscode = async (
    passcode: string,
    logoutTimeInMinutes?: number
  ): Promise<boolean> => {
    setIsLoading(true);
    try {
      // Rust handles: verify passcode → decrypt mnemonic → derive keys →
      // challenge-response → persist session
      const result = await invoke<LoginResult>("unlock_with_passcode", {
        accountId: polkadotAddress || "",
        passcode,
        logoutTimeMinutes: logoutTimeInMinutes,
      });

      setPolkadotAddress(result.substrateAddress);
      setWalletManager(null); // Keypair lives in Rust AUTH_STATE
      setAuthType("mnemonic");
      setIsAuthenticated(true);

      const effMinutes = logoutTimeInMinutes ?? 1440;
      const timeRemaining = effMinutes === -1 ? Infinity : effMinutes * 60_000;
      setSessionTimeRemaining(timeRemaining === Infinity ? null : timeRemaining);
      scheduleLogout(timeRemaining);

      if (!syncInitialized.current) {
        syncInitialized.current = true;
        await invoke("stop_sync").catch(() => { });
        tryAutoInitSync(result.substrateAddress).catch((err) =>
          console.error("[WalletAuth] Failed to start sync from unlock:", err)
        );
        checkMigrationAfterLogin(result.substrateAddress).catch((err) =>
          console.error("[WalletAuth] Migration check error:", err)
        );
      }

      return true;
    } catch (err) {
      if (err instanceof Error && err.message !== "Incorrect passcode") {
        console.error("[unlockWithPasscode] ", err);
      }
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const setSession = async (
    inputMnemonic: string,
    logoutTimeInMinutes?: number
  ): Promise<boolean> => {
    sessionMnemonicRef.current = inputMnemonic;
    try {
      // Validate mnemonic via Rust
      const valid = await invoke<boolean>("validate_mnemonic", { mnemonic: inputMnemonic });
      if (!valid) {
        console.error("[setSession] Invalid mnemonic");
        return false;
      }

      // Full login via Rust (derive keys + challenge-response + persist)
      const result = await invoke<LoginResult>("login_with_mnemonic", {
        mnemonic: inputMnemonic,
        logoutTimeMinutes: logoutTimeInMinutes ?? 1440,
      });

      setPolkadotAddress(result.substrateAddress);
      setWalletManager(null); // Keypair lives in Rust AUTH_STATE

      if (logoutTimerRef.current) {
        clearTimeout(logoutTimerRef.current);
        logoutTimerRef.current = null;
      }

      setIsAuthenticated(true);

      const effMinutes = logoutTimeInMinutes ?? 1440;
      const timeRemaining = effMinutes === -1 ? Infinity : effMinutes * 60_000;
      setSessionTimeRemaining(timeRemaining === Infinity ? null : timeRemaining);
      scheduleLogout(timeRemaining);

      if (!syncInitialized.current) {
        syncInitialized.current = true;
        await invoke("stop_sync").catch(() => { });
        tryAutoInitSync(result.substrateAddress, inputMnemonic).catch((err) =>
          console.error("[WalletAuth] Failed to start sync from setSession:", err)
        );
        checkMigrationAfterLogin(result.substrateAddress).catch((err) =>
          console.error("[WalletAuth] Migration check error:", err)
        );
      }

      return true;
    } catch (err) {
      console.error("[setSession] ", err);
      setPolkadotAddress(null);
      setWalletManager(null);
      setIsAuthenticated(false);
      return false;
    }
  };

  // Mnemonic login — all crypto happens in Rust
  const login = async (inputMnemonic: string): Promise<void> => {
    setIsLoading(true);
    sessionMnemonicRef.current = inputMnemonic;
    try {
      console.log("[WalletAuth] Starting mnemonic login via Rust");

      // Rust handles: validate mnemonic → derive keys → challenge-response → persist session
      const result = await invoke<LoginResult>("login_with_mnemonic", {
        mnemonic: inputMnemonic,
        logoutTimeMinutes: -1,
      });

      console.log("[WalletAuth] Mnemonic login successful:", result.substrateAddress);

      // Build OAuthSession-compatible object for components that read it
      const session = {
        token: result.token,
        userId: result.userId,
        username: result.username,
        substrateAddress: result.substrateAddress,
        provider: "mnemonic" as const,
        expiresAt: new Date(result.tokenExpiry).toISOString(),
        isNew: result.isNew,
      };

      // Store in localStorage for backward compatibility with tray menu etc.
      if (typeof window !== "undefined") {
        localStorage.setItem("hippius_oauth_session", JSON.stringify(session));
        localStorage.setItem("hippius_oauth_session_expiry", session.expiresAt);
      }

      setPolkadotAddress(result.substrateAddress);
      setWalletManager(null); // Keypair now lives in Rust AUTH_STATE
      setOAuthSessionState(session);
      setAuthType("mnemonic");
      setIsAuthenticated(true);

      // Initialize sync with the mnemonic (only if sync path & HCFS config exist)
      if (!syncInitialized.current) {
        syncInitialized.current = true;
        await invoke("stop_sync").catch(() => { });
        tryAutoInitSync(result.substrateAddress, inputMnemonic).catch((err) =>
          console.error("[WalletAuth] Failed to start sync from login:", err)
        );
        checkMigrationAfterLogin(result.substrateAddress).catch((err) =>
          console.error("[WalletAuth] Migration check error:", err)
        );
      }
    } catch (error) {
      console.error("[WalletAuth] Login failed:", error);
      setPolkadotAddress(null);
      setWalletManager(null);
      setAuthType(null);
      setIsAuthenticated(false);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Set OAuth session from external OAuth flow
  const setOAuthSession = async (
    session: import("@/app/lib/types/oAuth").OAuthSession
  ) => {
    console.log("[WalletAuth] Setting OAuth session");

    // Validate token before setting session
    if (!isTokenValid(session.token, session.expiresAt)) {
      console.error("[WalletAuth] Invalid or expired token, rejecting OAuth session");
      throw new Error("Token is invalid or expired");
    }

    // Persist auth token before setting authenticated state so that
    // components mounting after login can find the token in the DB.
    await ensureTempAuthKey(session.substrateAddress, session.token);

    // Persist auth session in Rust DB
    if (session.substrateAddress) {
      await invoke("save_auth_session", {
        accountId: session.substrateAddress,
        authToken: session.token,
        tokenExpiry: session.expiresAt ? new Date(session.expiresAt).getTime() : null,
        userId: session.userId ?? null,
        username: session.username ?? null,
        provider: session.provider ?? "oauth",
        substrateAddress: session.substrateAddress,
        logoutTimeMinutes: -1,
      });
    }

    setOAuthSessionState(session);
    setPolkadotAddress(session.substrateAddress || null);
    setAuthType("oauth");
    setIsAuthenticated(true);

    console.log("[WalletAuth] OAuth session persisted and state updated");

    // Kick off sync for OAuth login if not already started (only if sync path & config exist)
    if (session.substrateAddress && !syncInitialized.current) {
      syncInitialized.current = true;
      await invoke("stop_sync").catch(() => { });
      const mnemonic = await ensureSyncMnemonic(session.substrateAddress);
      tryAutoInitSync(session.substrateAddress, mnemonic).catch((err) =>
        console.error("[WalletAuth] Failed to start sync from OAuth login:", err)
      );
      checkMigrationAfterLogin(session.substrateAddress).catch((err) =>
        console.error("[WalletAuth] Migration check error:", err)
      );
    }
  };

  // Full reset: clear session + wallet storage
  const resetHippiusDesktop = async () => {
    await clearHippiusDesktopDB();
    await logout();
  };

  useTrayInit();

  return (
    <WalletContext.Provider
      value={{
        isAuthenticated,
        address,
        polkadotAddress,
        isLoading,
        walletManager,
        authType,
        oauthSession,
        getMnemonic,
        login,
        setOAuthSession,
        setSession,
        unlockWithPasscode,
        logout,
        resetHippiusDesktop,
        sessionTimeRemaining,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWalletAuth() {
  const ctx = useContext(WalletContext);
  if (!ctx)
    throw new Error("useWalletAuth must be used within WalletAuthProvider");
  return ctx;
}
