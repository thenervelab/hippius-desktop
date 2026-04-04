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
import { logger } from "@/lib/utils/logger";

import { invoke } from "@tauri-apps/api/core";
import { useTrayInit, clearLoginStatusCache } from "./hooks/useTraySync";
import { tryAutoInitSync } from "./hooks/useHcfsSync";
import { appStore } from "./store/jotaiStore";
import { migrationCheckAtom } from "./global-atoms/migrationAtoms";
import { splashCompleteAtom } from "./global-atoms/splashAtoms";
import { useAtomValue } from "jotai";

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

/** Build an OAuthSession-compatible object from a login/unlock result. */
function buildOAuthSession(
  result: LoginResult,
  providerOverride?: string
): import("@/app/lib/types/oAuth").OAuthSession {
  return {
    token: result.token,
    userId: typeof result.userId === "number" ? result.userId : 0,
    username: result.username,
    provider: (providerOverride ?? result.provider ?? "mnemonic") as import("@/app/lib/types/oAuth").OAuthSession["provider"],
    expiresAt: new Date(result.tokenExpiry).toISOString(),
    substrateAddress: result.substrateAddress,
    isNew: result.isNew,
  };
}

/** Signal MigrationChecker to run the single authoritative check_migration call. */
function triggerMigrationCheck() {
  appStore.set(migrationCheckAtom, {
    checked: false,
    needsMigration: false,
    fileCount: 0,
    totalSize: 0,
    shouldCheck: true,
  });
}

interface WalletContextType {
  isAuthenticated: boolean;
  polkadotAddress: string | null;
  isLoading: boolean;
  authType: "mnemonic" | "oauth" | null;
  oauthSession: import("@/app/lib/types/oAuth").OAuthSession | null;
  getMnemonic: () => Promise<string | null>;
  login: (mnemonic: string, referralCode?: string | null) => Promise<string>;
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
  const pendingSyncInit = useRef<{ accountId: string; mnemonic?: string } | null>(null);
  const splashComplete = useAtomValue(splashCompleteAtom);
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
        // Single Rust call: stops sync, clears auth, clears progress data
        const currentAddress = polkadotAddressRef.current;
        await invoke("logout_full", { accountId: currentAddress || "" }).catch((err: unknown) =>
          console.warn("[WalletAuth] logout_full failed:", err)
        );

        // Clear browser-side OAuth session (Rust can't access localStorage)
        if (typeof window !== "undefined") {
          localStorage.removeItem("hippius_oauth_session");
          localStorage.removeItem("hippius_oauth_session_expiry");
          localStorage.removeItem("hippius_oauth_provider");
        }

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

  /** Start sync for the given account, called after any successful auth.
   *  Defers until the splash screen is done so sync doesn't race the loading screen. */
  function initSync(accountId: string, mnemonic?: string) {
    if (syncInitialized.current) return;
    // Store the mnemonic so getMnemonic() can return it later
    // (e.g. when migration needs it for OAuth users)
    if (mnemonic && !sessionMnemonicRef.current) {
      sessionMnemonicRef.current = mnemonic;
    }
    if (!splashComplete) {
      // Splash still showing — defer until it finishes
      pendingSyncInit.current = { accountId, mnemonic };
      return;
    }
    syncInitialized.current = true;
    pendingSyncInit.current = null;
    invoke("stop_sync").catch(() => { });
    tryAutoInitSync(accountId, mnemonic).catch((err) =>
      console.error("[WalletAuth] Failed to start sync:", err)
    );
    triggerMigrationCheck();
  }

  // Trigger deferred sync init once the splash screen finishes
  useEffect(() => {
    if (splashComplete && pendingSyncInit.current && !syncInitialized.current) {
      const { accountId, mnemonic } = pendingSyncInit.current;
      initSync(accountId, mnemonic);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splashComplete]);

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

      // Read localStorage (browser-only) and pass to Rust for validation
      const storedSession = typeof window !== "undefined"
        ? localStorage.getItem("hippius_oauth_session")
        : null;
      const storedExpiry = typeof window !== "undefined"
        ? localStorage.getItem("hippius_oauth_session_expiry")
        : null;

      const oauthExpiryMs = storedExpiry
        ? (isNaN(Number(storedExpiry)) ? new Date(storedExpiry).getTime() : parseInt(storedExpiry, 10))
        : null;

      // Single Rust call handles all validation, token checking, fallback
      const result = await invoke<{
        authenticated: boolean;
        substrateAddress: string | null;
        authType: string | null;
        oauthSession: Record<string, unknown> | null;
        logoutTimeMs: number | null;
        shouldClearOauth: boolean;
        needsSyncMnemonic: boolean;
        redirectTo: string | null;
      }>("restore_session", {
        oauthSessionJson: storedSession ?? null,
        oauthExpiryMs: oauthExpiryMs ?? null,
      });

      // Clear localStorage if Rust says so
      if (result.shouldClearOauth) {
        localStorage.removeItem("hippius_oauth_session");
        localStorage.removeItem("hippius_oauth_session_expiry");
      }

      if (!result.authenticated) {
        if (result.redirectTo === "/login") {
          await logout("/login");
        }
        setSessionTimeRemaining(null);
        return;
      }

      // Set React state from Rust result
      setIsAuthenticated(true);
      if (result.substrateAddress) {
        setPolkadotAddress(result.substrateAddress);
      }
      setAuthType(result.authType === "oauth" ? "oauth" : "mnemonic");
      if (result.oauthSession) {
        setOAuthSessionState(result.oauthSession as unknown as import("@/app/lib/types/oAuth").OAuthSession);
      }

      // Schedule logout timer (browser setTimeout — can't do in Rust)
      if (result.logoutTimeMs !== null) {
        setSessionTimeRemaining(result.logoutTimeMs);
        scheduleLogout(result.logoutTimeMs);
      }

      // Init sync
      if (result.substrateAddress) {
        if (result.needsSyncMnemonic) {
          try {
            const mnemonic = await invoke<string>("ensure_sync_mnemonic", { accountId: result.substrateAddress });
            initSync(result.substrateAddress, mnemonic);
          } catch (err) {
            console.error("[WalletAuth] Failed to get sync mnemonic:", err);
            initSync(result.substrateAddress);
          }
        } else {
          initSync(result.substrateAddress);
        }
      }

      if (result.redirectTo) {
        router.push(result.redirectTo);
      }
    };

    setupSessionTimeout();

    return () => {
      if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logout, router]);

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

      if (result.token) {
        setOAuthSessionState(buildOAuthSession(result, "mnemonic"));
      }

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

      if (result.token) {
        setOAuthSessionState(buildOAuthSession(result, "mnemonic"));
      }

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
  const login = async (inputMnemonic: string, referralCode?: string | null): Promise<string> => {
    setIsLoading(true);
    sessionMnemonicRef.current = inputMnemonic;
    try {
      logger.debug("[WalletAuth] Starting mnemonic login via Rust");

      const result = await invoke<LoginResult>("login_with_mnemonic", {
        mnemonic: inputMnemonic,
        referralCode: referralCode ?? null,
        logoutTimeMinutes: -1,
      });

      logger.debug("[WalletAuth] Mnemonic login successful:", {
        substrate: result.substrateAddress,
        eth: result.ethAddress,
      });

      const session = buildOAuthSession(result, "mnemonic");

      setPolkadotAddress(result.substrateAddress);
      setOAuthSessionState(session);
      setAuthType("mnemonic");
      setIsAuthenticated(true);

      initSync(result.substrateAddress, inputMnemonic);

      return result.substrateAddress;
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
    logger.debug("[WalletAuth] Setting OAuth session");

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

    logger.debug("[WalletAuth] OAuth session persisted and state updated");

    if (session.substrateAddress && !syncInitialized.current) {
      try {
        const mnemonic = await invoke<string>("ensure_sync_mnemonic", { accountId: session.substrateAddress });
        initSync(session.substrateAddress, mnemonic);
      } catch (err) {
        console.error("[WalletAuth] Failed to get sync mnemonic for OAuth:", err);
        initSync(session.substrateAddress);
      }
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
