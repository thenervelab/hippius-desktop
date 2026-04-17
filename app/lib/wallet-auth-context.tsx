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
import { migrationCheckAtom, DEFAULT_MIGRATION_CHECK_STATE } from "./global-atoms/migrationAtoms";
import { splashCompleteAtom } from "./global-atoms/splashAtoms";
import { syncRequiresReauthAtom } from "./global-atoms/unpinAtoms";
import { scheduleOAuthSyncInit } from "./auth/scheduleOAuthSyncInit";
import { isMasterMnemonicUnrecoverable } from "./utils/dispatchTauriError";
import { useAtomValue } from "jotai";

/** Result from Rust login_with_mnemonic command */
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
  appStore.set(migrationCheckAtom, { ...DEFAULT_MIGRATION_CHECK_STATE, shouldCheck: true });
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
  const pendingSyncInit = useRef<{ accountId: string } | null>(null);
  const splashComplete = useAtomValue(splashCompleteAtom);
  const logoutTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Ref mirrors polkadotAddress so scheduleLogout's timer callback
  // always reads the current value (avoids stale closure).
  const polkadotAddressRef = useRef<string | null>(null);

  useEffect(() => {
    polkadotAddressRef.current = polkadotAddress;
  }, [polkadotAddress]);

  /**
   * Return the active BIP-39 mnemonic if — and ONLY if — the user is
   * about to see it (recovery-phrase reveal dialog). For every other
   * caller this deliberately returns `null` so the seed phrase never
   * round-trips through JavaScript memory.
   *
   * Historical context: this helper used to fall back to an in-memory
   * `sessionMnemonicRef` so that downstream callers could pass the
   * phrase to Rust IPCs like `initialize_sync` / `auto_init_sync` /
   * `resume_drive`. Every one of those commands already resolves the
   * mnemonic from `AuthInfo` (via `get_mnemonic_for_account`), so the
   * FE roundtrip was pure pass-through. The fallback has been removed.
   * Callers that pass the result into a Rust IPC should pass `null`
   * instead — Rust will read the cached mnemonic from `AuthInfo`.
   *
   * The one legitimate consumer is the `RecoveryPhraseSettings` reveal
   * flow, which displays the phrase to the user after an explicit
   * click. It calls `get_drive_mnemonic` directly; this helper just
   * forwards the same call for callers that haven't migrated yet.
   */
  const getMnemonic = useCallback(async (): Promise<string | null> => {
    if (!polkadotAddress) return null;
    try {
      const result = await invoke<string>("get_drive_mnemonic", { accountId: polkadotAddress });
      return result || null;
    } catch {
      return null;
    }
  }, [polkadotAddress]);

  const logout = useCallback(
    async (redirectPath?: string) => {
      // Clear the logout timer first to prevent re-entrant calls
      if (logoutTimerRef.current) {
        clearTimeout(logoutTimerRef.current);
        logoutTimerRef.current = null;
      }

      try {
        // Single Rust call: stops sync, clears auth, clears progress data.
        // Awaited so sync teardown completes before we clear local state.
        const currentAddress = polkadotAddressRef.current;
        await invoke("logout_full", { accountId: currentAddress || "" });
      } catch (err) {
        console.warn("[WalletAuth] logout_full failed:", err);
      }

      // Clear browser-side OAuth session (Rust can't access localStorage)
      if (typeof window !== "undefined") {
        localStorage.removeItem("hippius_oauth_session");
        localStorage.removeItem("hippius_oauth_session_expiry");
        localStorage.removeItem("hippius_oauth_provider");
      }

      // Immediately invalidate login status cache so the tray watcher
      // picks up the logged-out state on its next 2-second tick.
      clearLoginStatusCache();

      setPolkadotAddress(null);
      setAuthType(null);
      setOAuthSessionState(null);
      setIsAuthenticated(false);
      setSessionTimeRemaining(null);
      syncInitialized.current = false;
      // Clear the reauth banner on logout so a brand-new login
      // session starts with a clean slate.
      appStore.set(syncRequiresReauthAtom, false);

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
   *  Defers until the splash screen is done so sync doesn't race the loading screen.
   *
   *  No longer takes a mnemonic argument — Rust's `auto_init_sync` resolves
   *  the mnemonic from `AuthInfo` via the 5-stage `get_mnemonic_for_account`
   *  fallback chain, and `login_with_mnemonic` / `ensure_sync_mnemonic`
   *  populate `AuthInfo` before this is called. Passing the phrase through
   *  JavaScript added no capability and kept it alive in heap memory longer
   *  than necessary. */
  function initSync(accountId: string) {
    if (syncInitialized.current) return;
    if (!splashComplete) {
      // Splash still showing — defer until it finishes
      pendingSyncInit.current = { accountId };
      return;
    }
    syncInitialized.current = true;
    pendingSyncInit.current = null;
    invoke("stop_sync")
      .catch(() => { })
      .then(() => {
        tryAutoInitSync(accountId).catch((err) =>
          console.error("[WalletAuth] Failed to start sync:", err)
        );
      });
    triggerMigrationCheck();
  }

  // Trigger deferred sync init once the splash screen finishes
  useEffect(() => {
    if (splashComplete && pendingSyncInit.current && !syncInitialized.current) {
      const { accountId } = pendingSyncInit.current;
      initSync(accountId);
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
        /** True when the OS keychain didn't contain the mnemonic on
         *  restore, so sync is wedged until the user re-enters their
         *  seed phrase. Surfaces the <SyncReauthRequiredAlert /> banner. */
        syncRequiresReauth: boolean;
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
        // Not authenticated → banner state is irrelevant, clear it.
        appStore.set(syncRequiresReauthAtom, false);
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
      // Write the reauth banner atom from Rust's authoritative answer.
      // True only for mnemonic users where the OS keychain didn't
      // return the seed phrase on restore — the only recovery is to
      // re-enter the mnemonic via the login form.
      appStore.set(syncRequiresReauthAtom, result.syncRequiresReauth ?? false);

      // Schedule logout timer (browser setTimeout — can't do in Rust)
      if (result.logoutTimeMs !== null) {
        setSessionTimeRemaining(result.logoutTimeMs);
        scheduleLogout(result.logoutTimeMs);
      }

      // Init sync
      if (result.substrateAddress) {
        if (result.needsSyncMnemonic) {
          try {
            // Rust caches the mnemonic in AuthInfo; we don't read it back.
            await invoke<void>("ensure_sync_mnemonic", { accountId: result.substrateAddress });
          } catch (err) {
            console.error("[WalletAuth] ensure_sync_mnemonic failed:", err);
            // Rust refuses to mint a fresh mnemonic when encrypted
            // state already exists on disk — returning
            // `NotReady(MasterMnemonicUnrecoverable)`. Flip the
            // reauth banner so the user can recover via re-entering
            // their seed phrase, instead of silently falling through
            // to `initSync` which would surface as the opaque
            // `Crypto: decryption failed` error on the next drive
            // resume.
            if (isMasterMnemonicUnrecoverable(err)) {
              appStore.set(syncRequiresReauthAtom, true);
            }
          }
        }
        initSync(result.substrateAddress);
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

  const setSession = async (
    inputMnemonic: string,
    logoutTimeInMinutes?: number
  ): Promise<boolean> => {
    try {
      // Validate mnemonic in Rust
      const valid = await invoke<boolean>("validate_mnemonic", { mnemonic: inputMnemonic });
      if (!valid) {
        console.error("[setSession] Invalid mnemonic");
        return false;
      }

      // Full login via Rust: derive keys + challenge-response + persist session.
      // The mnemonic stays inside this try block and is dropped as soon as
      // the login_with_mnemonic IPC returns — Rust now owns it via
      // AuthInfo.mnemonic and the OS keychain, so the FE never needs to
      // hold it again.
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

      // Clear the reauth banner on successful mnemonic login. Rust's
      // login_with_mnemonic populates both `AuthInfo.mnemonic` AND
      // the OS keychain, so any subsequent restore_session will land
      // in `AlreadyWritten` and sync will unlock normally.
      appStore.set(syncRequiresReauthAtom, false);

      if (logoutTimerRef.current) {
        clearTimeout(logoutTimerRef.current);
        logoutTimerRef.current = null;
      }

      const effMinutes = logoutTimeInMinutes ?? 1440;
      const timeRemaining = effMinutes === -1 ? Infinity : effMinutes * 60_000;
      setSessionTimeRemaining(timeRemaining === Infinity ? null : timeRemaining);
      scheduleLogout(timeRemaining);

      initSync(result.substrateAddress);

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
      // `AccessKeyLoginForm` reaches this function (not `setSession`) via
      // the reauth banner's "Re-enter seed phrase" CTA. Clearing the
      // atom here is what makes the banner disappear after a successful
      // seed-phrase re-entry — without it, the banner lingers until the
      // next restore_session or page reload, defeating the recovery
      // flow.
      appStore.set(syncRequiresReauthAtom, false);

      initSync(result.substrateAddress);

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
    // Belt-and-braces: OAuth users never land in the Restored-capability
    // state (rehydrate_or_restored returns OAuthOnly for them), so
    // syncRequiresReauthAtom should already be false. Clear explicitly
    // so a future refactor that changes OAuth capability mapping can't
    // leak a stale `true` from an earlier mnemonic session.
    appStore.set(syncRequiresReauthAtom, false);

    logger.debug("[WalletAuth] OAuth session persisted and state updated");

    if (session.substrateAddress && !syncInitialized.current) {
      // Fire-and-forget: `ensure_sync_mnemonic` parks on the recovery
      // gate when `complete_oauth_flow` set it to `Pending` (fresh-
      // device Unlock). Awaiting inline would block the OAuth callback
      // page — preventing navigation into `(pages)` where the recovery
      // dialog mounts, which is the only way the gate ever resolves.
      // See `scheduleOAuthSyncInit` for the detached sequencing.
      void scheduleOAuthSyncInit(session.substrateAddress, initSync);
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
