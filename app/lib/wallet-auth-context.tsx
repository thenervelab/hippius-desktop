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

import { useRouter } from "next/navigation";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTrayInit, clearLoginStatusCache } from "./hooks/useTraySync";
import { tryAutoInitSync } from "./hooks/useHcfsSync";
import { ensureSyncMnemonic } from "./helpers/ensureSyncMnemonic";
import { appStore } from "./store/jotaiStore";
import { migrationCheckAtom } from "./global-atoms/migrationAtoms";

/** Result from Rust login_with_mnemonic / unlock_with_passcode commands */
interface LoginResult {
  substrateAddress: string;
  ethAddress: string;
  userId: number | string | null;
  username: string;
  provider: string;
  token: string;
  tokenExpiry: number;
  isNew: boolean;
}

/** Result from Rust get_auth_session / get_last_auth_session commands */
interface AuthSession {
  authToken: string | null;
  tokenExpiry: number | null;
  userId: number | null;
  username: string | null;
  provider: string | null;
  substrateAddress: string | null;
  logoutTimeMinutes: number | null;
  lastLoginAt: string | null;
}

/** Result from Rust get_auth_token command */
interface ApiAuth {
  token: string;
  tokenExpiry: number;
  userId: number | null;
  username: string | null;
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
  polkadotAddress: string | null;
  isLoading: boolean;
  authType: "mnemonic" | "oauth" | null;
  oauthSession: import("@/app/lib/types/oAuth").OAuthSession | null;
  getMnemonic: () => Promise<string | null>;
  login: (mnemonic: string, referralCode?: string | null) => Promise<void>;
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

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletAuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [polkadotAddress, setPolkadotAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [authType, setAuthType] = useState<"mnemonic" | "oauth" | null>(null);
  const [oauthSession, setOAuthSessionState] = useState<
    import("@/app/lib/types/oAuth").OAuthSession | null
  >(null);
  const [sessionTimeRemaining, setSessionTimeRemaining] = useState<
    number | null
  >(null);

  const syncInitialized = useRef(false);
  const logoutTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Ref mirrors polkadotAddress so scheduleLogout's timer callback
  // always reads the current value (avoids stale closure).
  const polkadotAddressRef = useRef<string | null>(null);
  // Keep the login mnemonic in-memory so getMnemonic() can return it
  // even before a Drive is initialized (e.g. on a new device before
  // the user creates their first sync folder).
  const sessionMnemonicRef = useRef<string | null>(null);

  useEffect(() => {
    polkadotAddressRef.current = polkadotAddress;
  }, [polkadotAddress]);

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

        // Read from ref so timer callbacks get the current address
        const currentAddress = polkadotAddressRef.current;
        if (currentAddress) {
          await invoke("auth_logout", { accountId: currentAddress }).catch((err: unknown) =>
            console.warn("[WalletAuth] auth_logout failed:", err)
          );
        }

        // Clear OAuth session if present
        if (typeof window !== "undefined") {
          localStorage.removeItem("hippius_oauth_session");
          localStorage.removeItem("hippius_oauth_session_expiry");
          localStorage.removeItem("hippius_oauth_provider");
        }

        // NOTE: We intentionally do NOT clear sync progress data on logout.
        // The data is preserved in the Rust backend so the tray and sync
        // widget show the last-known state immediately after re-login.
        // New sync sessions naturally replace stale data.

        // Immediately invalidate login status cache so the tray watcher
        // picks up the logged-out state on its next 2-second tick.
        clearLoginStatusCache();
      } catch (error) {
        console.error("Failed to cleanup sync on logout:", error);
      }

      // Clear the logout timer if it exists
      if (logoutTimerRef.current) {
        clearTimeout(logoutTimerRef.current);
        logoutTimerRef.current = null;
      }

      setPolkadotAddress(null);
      setAuthType(null);
      setOAuthSessionState(null);
      setIsAuthenticated(false);
      setSessionTimeRemaining(null);
      syncInitialized.current = false;
      sessionMnemonicRef.current = null;

      if (redirectPath && typeof window !== "undefined") {
        router.push(redirectPath);
      }
    },
    [router]
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

  /** Start sync for the given account, called after any successful auth */
  function initSync(accountId: string, mnemonic?: string) {
    if (syncInitialized.current) return;
    syncInitialized.current = true;
    invoke("stop_sync").catch(() => { });
    tryAutoInitSync(accountId, mnemonic).catch((err) =>
      console.error("[WalletAuth] Failed to start sync:", err)
    );
    checkMigrationAfterLogin(accountId).catch((err) =>
      console.error("[WalletAuth] Migration check error:", err)
    );
  }

  // Boot: restore session from Rust DB or localStorage OAuth session
  useEffect(() => {
    const bootOnce = { done: false };

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
          const expiryTime = isNaN(Number(storedExpiry))
            ? new Date(storedExpiry).getTime()
            : parseInt(storedExpiry, 10);

          if (Date.now() < expiryTime) {
            try {
              const oauthSessionData = JSON.parse(storedSession);

              // Validate token via Rust if we have a substrate address
              if (oauthSessionData.substrateAddress) {
                const apiAuth = await invoke<ApiAuth | null>(
                  "get_auth_token",
                  { accountId: oauthSessionData.substrateAddress }
                );
                if (!apiAuth) {
                  console.log("[WalletAuth] Token expired in DB, clearing session");
                  localStorage.removeItem("hippius_oauth_session");
                  localStorage.removeItem("hippius_oauth_session_expiry");
                  await logout("/login");
                  return;
                }
              }

              console.log(
                "[WalletAuth] Restoring OAuth session:",
                oauthSessionData.username
              );

              setOAuthSessionState(oauthSessionData);
              setPolkadotAddress(oauthSessionData.substrateAddress || null);
              setAuthType(
                oauthSessionData.provider === "mnemonic" ? "mnemonic" : "oauth"
              );
              setIsAuthenticated(true);

              // OAuth sessions rely on server-side token expiry (30 days)
              // rather than a frontend logout timer. Token validity is
              // checked via get_auth_token on each boot.
              if (oauthSessionData.substrateAddress) {
                if (oauthSessionData.provider === "mnemonic") {
                  initSync(oauthSessionData.substrateAddress);
                } else {
                  try {
                    const mnemonic = await ensureSyncMnemonic(oauthSessionData.substrateAddress);
                    initSync(oauthSessionData.substrateAddress, mnemonic);
                  } catch (err) {
                    console.error("[WalletAuth] Failed to start sync for OAuth restore:", err);
                  }
                }
              }

              console.log("[WalletAuth] OAuth session restored");
              return;
            } catch (error) {
              console.error(
                "[WalletAuth] Failed to restore OAuth session:",
                error
              );
              localStorage.removeItem("hippius_oauth_session");
              localStorage.removeItem("hippius_oauth_session_expiry");
            }
          } else {
            console.log("[WalletAuth] OAuth session expired, clearing");
            localStorage.removeItem("hippius_oauth_session");
            localStorage.removeItem("hippius_oauth_session_expiry");
          }
        }
      }

      // Fall back to Rust DB session (mnemonic-based logins)
      const lastSession = await invoke<AuthSession | null>("get_last_auth_session");
      if (!lastSession || !lastSession.authToken) {
        setSessionTimeRemaining(null);
        return;
      }

      // Validate token expiry via Rust
      if (lastSession.tokenExpiry && lastSession.tokenExpiry < Date.now()) {
        console.log("[WalletAuth] Token expired for session, redirecting to login");
        if (lastSession.substrateAddress) {
          await invoke("clear_auth_session", { accountId: lastSession.substrateAddress }).catch((err: unknown) =>
            console.warn("[WalletAuth] Failed to clear expired auth session:", err)
          );
        }
        localStorage.removeItem("hippius_token");
        localStorage.removeItem("hippius_token_expiry");
        await logout("/login");
        return;
      }

      // Session exists with valid token — restore state.
      // Can't derive keypair without plaintext mnemonic, so just mark
      // authenticated. The user will get a passcode prompt for staking.
      setIsAuthenticated(true);
      if (lastSession.substrateAddress) {
        setPolkadotAddress(lastSession.substrateAddress);
      }
      setAuthType(lastSession.provider === "oauth" ? "oauth" : "mnemonic");

      const effMinutes = lastSession.logoutTimeMinutes ?? 1440;
      const timeRemaining = effMinutes === -1 ? Infinity : effMinutes * 60_000;
      setSessionTimeRemaining(timeRemaining === Infinity ? null : timeRemaining);
      scheduleLogout(timeRemaining);

      if (lastSession.substrateAddress) {
        initSync(lastSession.substrateAddress);
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
  // Rust handles the entire challenge-response flow — no frontend crypto needed.
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
      console.log("[WalletAuth] Auth token expired, attempting silent refresh");

      try {
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
    if (!polkadotAddress) return false;
    setIsLoading(true);
    try {
      const result = await invoke<LoginResult>("unlock_with_passcode", {
        accountId: polkadotAddress,
        passcode,
        logoutTimeMinutes: logoutTimeInMinutes ?? 1440,
      });

      sessionMnemonicRef.current = null; // Rust holds it now
      setPolkadotAddress(result.substrateAddress);
      setAuthType("mnemonic");
      setIsAuthenticated(true);

      const effMinutes = logoutTimeInMinutes ?? 1440;
      const timeRemaining = effMinutes === -1 ? Infinity : effMinutes * 60_000;
      setSessionTimeRemaining(timeRemaining === Infinity ? null : timeRemaining);
      scheduleLogout(timeRemaining);

      initSync(result.substrateAddress);

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
      // Validate mnemonic in Rust
      const valid = await invoke<boolean>("validate_mnemonic", { mnemonic: inputMnemonic });
      if (!valid) {
        console.error("[setSession] Invalid mnemonic");
        return false;
      }

      // Full login via Rust: derive keys + challenge-response + persist session
      const result = await invoke<LoginResult>("login_with_mnemonic", {
        mnemonic: inputMnemonic,
        logoutTimeMinutes: logoutTimeInMinutes ?? 1440,
      });

      setPolkadotAddress(result.substrateAddress);
      setAuthType("mnemonic");
      setIsAuthenticated(true);

      if (logoutTimerRef.current) {
        clearTimeout(logoutTimerRef.current);
        logoutTimerRef.current = null;
      }

      const effMinutes = logoutTimeInMinutes ?? 1440;
      const timeRemaining = effMinutes === -1 ? Infinity : effMinutes * 60_000;
      setSessionTimeRemaining(timeRemaining === Infinity ? null : timeRemaining);
      scheduleLogout(timeRemaining);

      initSync(result.substrateAddress, inputMnemonic);

      return true;
    } catch (err) {
      console.error("[setSession] ", err);
      setPolkadotAddress(null);
      setIsAuthenticated(false);
      return false;
    }
  };

  // Mnemonic login — all crypto happens in Rust
  const login = async (inputMnemonic: string, referralCode?: string | null): Promise<void> => {
    setIsLoading(true);
    sessionMnemonicRef.current = inputMnemonic;
    try {
      console.log("[WalletAuth] Starting mnemonic login via Rust");

      const result = await invoke<LoginResult>("login_with_mnemonic", {
        mnemonic: inputMnemonic,
        referralCode: referralCode ?? null,
        logoutTimeMinutes: -1,
      });

      console.log("[WalletAuth] Mnemonic login successful:", {
        substrate: result.substrateAddress,
        eth: result.ethAddress,
      });

      // Build an OAuthSession-compatible object for state consumers
      const session: import("@/app/lib/types/oAuth").OAuthSession = {
        token: result.token,
        userId: typeof result.userId === "number" ? result.userId : 0,
        username: result.username,
        provider: "mnemonic",
        expiresAt: new Date(result.tokenExpiry).toISOString(),
        substrateAddress: result.substrateAddress,
        isNew: result.isNew,
      };

      setPolkadotAddress(result.substrateAddress);
      setOAuthSessionState(session);
      setAuthType("mnemonic");
      setIsAuthenticated(true);

      initSync(result.substrateAddress, inputMnemonic);
    } catch (error) {
      console.error("[WalletAuth] Login failed:", error);
      setPolkadotAddress(null);
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

    // Validate token
    if (!session.token || session.token.trim() === "") {
      console.error("[WalletAuth] Invalid token, rejecting OAuth session");
      throw new Error("Token is invalid or expired");
    }

    // Persist to localStorage after validation
    if (typeof window !== "undefined") {
      localStorage.setItem("hippius_oauth_session", JSON.stringify(session));
      localStorage.setItem("hippius_oauth_session_expiry", session.expiresAt);
    }

    setOAuthSessionState(session);
    setPolkadotAddress(session.substrateAddress || null);
    setAuthType("oauth");
    setIsAuthenticated(true);

    console.log("[WalletAuth] OAuth session persisted and state updated");

    if (session.substrateAddress && !syncInitialized.current) {
      const mnemonic = await ensureSyncMnemonic(session.substrateAddress);
      initSync(session.substrateAddress, mnemonic);
    }
  };

  // Full reset: clear session + wallet storage
  const resetHippiusDesktop = async () => {
    await clearHippiusDesktopDB();
    await logout();
  };

  useTrayInit(isAuthenticated);

  return (
    <WalletContext.Provider
      value={{
        isAuthenticated,
        polkadotAddress,
        isLoading,
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
