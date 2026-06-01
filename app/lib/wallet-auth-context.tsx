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
import { invokeWithTimeout } from "./utils/invokeWithTimeout";
import { useTrayInit, clearLoginStatusCache } from "./hooks/useTraySync";
import { tryAutoInitSync } from "./hooks/useHcfsSync";
import { appStore } from "./store/jotaiStore";
import { migrationCheckAtom, DEFAULT_MIGRATION_CHECK_STATE } from "./global-atoms/migrationAtoms";
import { splashCompleteAtom } from "./global-atoms/splashAtoms";
import { syncRequiresReauthAtom } from "./global-atoms/unpinAtoms";
import { resetSyncSession } from "./store/resetSyncSession";
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
      syncInitialized.current = false;
      // Reset ALL session-scoped sync atoms (drive statuses, failed files,
      // conflicts, credits banner, health, loaded-latch, reauth) so the
      // previous account's state can't leak into the next login — these atoms
      // live in the root appStore and survive the logout navigation.
      resetSyncSession();

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
   *
   *  No longer takes a mnemonic argument — Rust's `auto_init_sync` resolves
   *  the mnemonic from `AuthInfo` via the 5-stage `get_mnemonic_for_account`
   *  fallback chain, and `login_with_mnemonic` / `ensure_sync_mnemonic`
   *  populate `AuthInfo` before this is called. Passing the phrase through
   *  JavaScript added no capability and kept it alive in heap memory longer
   *  than necessary.
   *
   *  Previously this gated on `splashCompleteAtom` to "defer sync init
   *  until the splash screen finishes." The gate stranded init forever
   *  on cold starts where the splash bailed early (the update-dialog
   *  branch in `splash-screen/index.tsx:174` returns from
   *  `runSetupPhases` without ever calling `setSplashComplete(true)`),
   *  so `auto_init_sync` was never invoked, `runner.drives` stayed
   *  empty, and every user upload sat on the 60 s
   *  `upload_processing` watchdog because `trigger_sync` found no
   *  drives. The gate is unnecessary anyway: `auto_init_sync` runs in
   *  the Rust backend and doesn't render UI, and the splash component
   *  renders over its children (`isReady && children`) until it's
   *  ready — so backend sync events can't visibly "race the loading
   *  screen". */
  function initSync(accountId: string) {
    if (syncInitialized.current) return;
    syncInitialized.current = true;
    pendingSyncInit.current = null;
    // Wrap `stop_sync` in a wall-clock timeout so a Rust-side hang
    // (poisoned mutex, deadlocked sync loop, etc.) can't strand
    // login. `stop_sync` is normally <500ms (GRACEFUL_SHUTDOWN +
    // abort fallback in lifecycle.rs), so 8s is roomy. Whatever the
    // outcome (success / Rust error / timeout) we proceed to
    // `tryAutoInitSync` — fresh login should never block on
    // teardown of state that may not even exist yet.
    invokeWithTimeout<void>("stop_sync", undefined, 8_000)
      .catch((err) => {
        console.warn("[WalletAuth] stop_sync failed or timed out:", err);
      })
      .then(() => {
        tryAutoInitSync(accountId).catch((err) =>
          console.error("[WalletAuth] Failed to start sync:", err)
        );
      });
    triggerMigrationCheck();
  }

  // Backward-compat: a previous version deferred init via
  // `pendingSyncInit.current` when the splash wasn't ready. The gate
  // is gone now, but this effect stays as a safety net — if any
  // legacy code path stashes a pending init, fire it once
  // `splashComplete` flips. In the steady state, `pendingSyncInit`
  // is always null and this is a no-op.
  useEffect(() => {
    if (splashComplete && pendingSyncInit.current && !syncInitialized.current) {
      const { accountId } = pendingSyncInit.current;
      initSync(accountId);
    }
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

      // Single Rust call handles all validation, token checking, fallback.
      // 15s wall-clock cap protects the boot flow from a Rust-side hang
      // (DB pool starvation, blockchain subscription init blocked on
      // network, keychain access hanging). Without the cap a stuck
      // `restore_session` would leave the entire auth context in its
      // initial state forever — no login UI, no sync, no error.
      const result = await invokeWithTimeout<{
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
      }>(
        "restore_session",
        {
          oauthSessionJson: storedSession ?? null,
          oauthExpiryMs: oauthExpiryMs ?? null,
        },
        15_000,
      );

      // Clear localStorage if Rust says so
      if (result.shouldClearOauth) {
        localStorage.removeItem("hippius_oauth_session");
        localStorage.removeItem("hippius_oauth_session_expiry");
      }

      if (!result.authenticated) {
        if (result.redirectTo === "/login") {
          await logout("/login");
        }
        // Not authenticated → clear all session-scoped sync state (covers the
        // boot path where redirectTo isn't "/login" so logout() didn't run).
        resetSyncSession();
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
        scheduleLogout(result.logoutTimeMs);
      }

      // Init sync.
      //
      // `ensure_sync_mnemonic` parks on Rust's recovery gate
      // (`sync/mnemonic.rs::await_recovery_resolved`) when the gate
      // is `Pending` — set by `session_restore.rs:311` for OAuth
      // users whose recommended recovery flow is anything other
      // than `Proceed`. Awaiting this IPC before `initSync` meant
      // any stall in the recovery dialog (it never renders, the
      // user dismisses it without resolving, the event listener
      // missed `oauth_recovery_check_needed`) stranded `initSync`
      // forever — auto_init_sync was never invoked,
      // `runner.drives` stayed empty, every upload hit the 60s
      // `upload_processing` watchdog.
      //
      // Fix: fire `ensure_sync_mnemonic` in the background and call
      // `initSync` immediately. Rust's `auto_init_sync` already has
      // a retry ladder gated on the `hippius_auth_ready` event
      // (subscribed BEFORE its first attempt, see
      // `useHcfsSync.ts::tryAutoInitSync`). Both success paths of
      // `ensure_sync_mnemonic` now emit `hippius_auth_ready` so
      // when the mnemonic finally lands in `AuthInfo` (either from
      // the cache hit, the recovery branch, or the freshly
      // generated branch), the next retry picks it up. If
      // `ensure_sync_mnemonic` fails with
      // `MasterMnemonicUnrecoverable` (encrypted state exists but
      // can't be decrypted), the catch flips the reauth banner —
      // same UX as before, just without the gate.
      if (result.substrateAddress) {
        if (result.needsSyncMnemonic) {
          // Fire-and-forget. NOT awaited.
          void (async () => {
            try {
              await invoke<void>("ensure_sync_mnemonic", {
                accountId: result.substrateAddress,
              });
            } catch (err) {
              console.error("[WalletAuth] ensure_sync_mnemonic failed:", err);
              if (isMasterMnemonicUnrecoverable(err)) {
                appStore.set(syncRequiresReauthAtom, true);
              }
            }
          })();
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
