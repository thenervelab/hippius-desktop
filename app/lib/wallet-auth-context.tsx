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
import { Keyring } from "@polkadot/keyring";
import {
  getWalletRecord,
  clearHippiusDesktopDB,
} from "./helpers/hippiusDesktopDB";
import {
  saveSession,
  getSession,
  clearSession,
  clearApiAuth,
  getApiAuth,
} from "./helpers/sessionStore";
import { clearAllData as clearSyncProgressData } from "./services/syncProgressService";

import { useRouter } from "next/navigation";

import { hashPasscode, decryptMnemonic } from "./helpers/crypto";
import { isMnemonicValid } from "./helpers/validateMnemonic";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTrayInit } from "./hooks/useTraySync";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { tryAutoInitSync } from "./hooks/useHcfsSync";
import { ensureSyncMnemonic } from "./helpers/ensureSyncMnemonic";

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
    try {
      // Retrieve mnemonic from encrypted Drive via Rust — never from session DB
      if (!polkadotAddress) return null;
      return await invoke<string>("get_drive_mnemonic", { accountId: polkadotAddress });
    } catch {
      return null;
    }
  }, [polkadotAddress]);

  const logout = useCallback(
    async (redirectPath?: string) => {
      try {
        console.log("[WalletAuth] Starting sync cleanup...");
        await invoke("stop_sync").catch(() => { });
        console.log("[WalletAuth] Sync cleanup completed");

        await clearSession();
        await clearApiAuth();

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

      // Optionally redirect after logout
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

      // Check for session timeout data (no mnemonic stored)
      const session = await getSession();
      if (!session) {
        setSessionTimeRemaining(null);
        return;
      }

      // Validate token from API auth if it exists
      const apiAuth = await getApiAuth();

      if (!apiAuth?.token || (apiAuth.tokenExpiry && apiAuth.tokenExpiry < Date.now())) {
        console.log("[WalletAuth] No token or token expired for session, redirecting to login");
        await clearApiAuth();
        localStorage.removeItem("hippius_token");
        localStorage.removeItem("hippius_token_expiry");
        await logout("/login");
        return;
      }

      const timeRemaining = session.logoutTimeStamp - Date.now();
      setSessionTimeRemaining(Math.max(timeRemaining, 0));

      if (timeRemaining <= 0 && !isAuthenticated) {
        await logout();
        return;
      }

      // Session exists with valid token — this is a legacy mnemonic session
      // that still has timeout data. We can't derive the keypair without
      // plaintext, so just mark authenticated and schedule logout.
      // The user will get a passcode prompt if they try to stake.
      setIsAuthenticated(true);

      const effMinutes = session.logoutTimeInMinutes;
      scheduleLogout(effMinutes === -1 ? Infinity : timeRemaining);

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
      console.log("[WalletAuth] Auth token expired, attempting silent refresh");

      try {
        const mnemonic = await getMnemonic();
        if (!mnemonic) {
          console.warn("[WalletAuth] Cannot refresh token: no mnemonic available");
          return;
        }

        await cryptoWaitReady();
        const { mnemonicToAccount } = await import("viem/accounts");
        const ethAccount = mnemonicToAccount(mnemonic);
        const { authService } = await import("./services/authService");

        const challengeData = await authService.requestChallenge(
          ethAccount.address,
          polkadotAddress,
        );
        const signature = await ethAccount.signMessage({
          message: challengeData.message,
        });
        await authService.verifySignature({
          signature,
          address: ethAccount.address,
          substrateAddress: polkadotAddress,
          referralCode: null,
        });

        const session = authService.getSession();
        if (!session?.token) {
          console.error("[WalletAuth] Token refresh failed: no session after verify");
          return;
        }

        await invoke("update_sync_bearer_token", {
          accountId: polkadotAddress,
          bearerToken: session.token,
        });

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
  }, [isAuthenticated, polkadotAddress, getMnemonic]);

  const unlockWithPasscode = async (
    passcode: string,
    logoutTimeInMinutes?: number
  ): Promise<boolean> => {
    setIsLoading(true);
    try {
      const record = await getWalletRecord();
      if (!record) throw new Error("No wallet record found");

      if (hashPasscode(passcode) !== record.passcodeHash)
        throw new Error("Incorrect passcode");
      await cryptoWaitReady();
      const mnemonic = decryptMnemonic(record.encryptedMnemonic, passcode);
      if (!isMnemonicValid(mnemonic)) throw new Error("Decryption failed");

      // Derive keypair in memory, persist session timeout (not mnemonic)
      const sessionOk = await setSession(mnemonic, logoutTimeInMinutes);
      if (!sessionOk) throw new Error("Session setup failed");

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
    if (!isMnemonicValid(inputMnemonic)) {
      console.error("[setSession] Invalid mnemonic");
      return false;
    }
    await cryptoWaitReady();
    try {
      const keyring = new Keyring({ type: "sr25519" });
      const pair = keyring.addFromMnemonic(inputMnemonic);

      setPolkadotAddress(pair.address);
      setWalletManager({ polkadotPair: pair });
      setIsAuthenticated(true);

      if (logoutTimerRef.current) {
        clearTimeout(logoutTimerRef.current);
        logoutTimerRef.current = null;
      }

      // Persist session timeout only — no mnemonic
      const logoutTimeStamp = await saveSession(logoutTimeInMinutes);

      // Validate API token if it exists
      const apiAuth = await getApiAuth();
      if (!apiAuth?.token || (apiAuth.tokenExpiry && apiAuth.tokenExpiry < Date.now())) {
        console.error("[setSession] No token or token expired");
        await clearApiAuth();
        localStorage.removeItem("hippius_token");
        localStorage.removeItem("hippius_token_expiry");
        setPolkadotAddress(null);
        setWalletManager(null);
        setIsAuthenticated(false);
        return false;
      }

      const timeRemaining = +logoutTimeStamp - Date.now();
      setSessionTimeRemaining(timeRemaining);

      // If minutes === -1, we won't schedule; else schedule in safe chunks
      const effMinutes =
        logoutTimeInMinutes ??
        (await getSession())?.logoutTimeInMinutes ??
        1440;

      scheduleLogout(effMinutes === -1 ? Infinity : timeRemaining);

      if (!syncInitialized.current) {
        syncInitialized.current = true;
        await invoke("stop_sync").catch(() => { });
        // Fire-and-forget: sync init runs in background so login isn't blocked.
        tryAutoInitSync(pair.address, inputMnemonic).catch((err) =>
          console.error("[WalletAuth] Failed to start sync from setSession:", err)
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

  // Mnemonic login with challenge-based authentication
  const login = async (inputMnemonic: string): Promise<void> => {
    setIsLoading(true);
    try {
      console.log("[WalletAuth] Starting mnemonic login with challenge");

      // Wait for crypto WASM to be ready
      await cryptoWaitReady();

      // Import viem for Ethereum account
      const { mnemonicToAccount } = await import("viem/accounts");

      // Create Polkadot account
      const keyring = new Keyring({ type: "sr25519" });
      const polkadotPair = keyring.addFromMnemonic(inputMnemonic);
      const polkadotAddr = polkadotPair.address;

      // Create Ethereum account
      const ethAccount = mnemonicToAccount(inputMnemonic);
      const ethAddress = ethAccount.address;

      console.log("[WalletAuth] Derived addresses:", {
        eth: ethAddress,
        polkadot: polkadotAddr,
      });

      // Import auth service dynamically
      const { authService } = await import("./services/authService");

      // Request challenge
      const challengeData = await authService.requestChallenge(
        ethAddress,
        polkadotAddr
      );
      console.log("[WalletAuth] Got challenge:", challengeData.message);

      // Sign challenge
      const signature = await ethAccount.signMessage({
        message: challengeData.message,
      });
      console.log("[WalletAuth] Generated signature");

      // Verify signature and get session
      await authService.verifySignature({
        signature,
        address: ethAddress,
        substrateAddress: polkadotAddr,
        referralCode: null,
      });
      console.log("[WalletAuth] Signature verified");

      // Get session from auth service (already stored)
      const session = authService.getSession();
      if (!session) {
        throw new Error("Session not stored properly after verification");
      }

      console.log("[WalletAuth] Mnemonic login successful");

      // Update state
      setPolkadotAddress(polkadotAddr);
      setWalletManager({ polkadotPair });
      setOAuthSessionState(session);
      setAuthType("mnemonic");
      setIsAuthenticated(true);
      await saveSession(-1);

      // Initialize sync with the mnemonic (only if sync path & HCFS config exist)
      if (!syncInitialized.current) {
        syncInitialized.current = true;
        await invoke("stop_sync").catch(() => { });
        tryAutoInitSync(polkadotAddr, inputMnemonic).catch((err) =>
          console.error("[WalletAuth] Failed to start sync from login:", err)
        );
      }

      // Ensure temp auth key is stored for S3 access if no master token yet
      await ensureTempAuthKey(polkadotAddr, session.token);
    } catch (error) {
      console.error("[WalletAuth] Login failed:", error);
      // Clear sensitive data on error
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

    setOAuthSessionState(session);
    setPolkadotAddress(session.substrateAddress || null);
    setAuthType("oauth");
    setIsAuthenticated(true);

    console.log("[WalletAuth] OAuth session persisted and state updated");

    // Ensure temp auth key is stored for S3 access if no master token yet
    await ensureTempAuthKey(session.substrateAddress, session.token);

    // Kick off sync for OAuth login if not already started (only if sync path & config exist)
    if (session.substrateAddress && !syncInitialized.current) {
      syncInitialized.current = true;
      await invoke("stop_sync").catch(() => { });
      const mnemonic = await ensureSyncMnemonic(session.substrateAddress);
      tryAutoInitSync(session.substrateAddress, mnemonic).catch((err) =>
        console.error("[WalletAuth] Failed to start sync from OAuth login:", err)
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
