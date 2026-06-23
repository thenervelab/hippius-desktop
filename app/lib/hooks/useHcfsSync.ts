"use client";

import { useState, useCallback } from "react";
import { errorMessage } from "@/lib/utils/errorUtils";
import {
  getHcfsConfig,
  type InitSyncResult,
  type HcfsConfigResult,
} from "../utils/hcfsConfigUtils";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isNotReady } from "../utils/dispatchTauriError";
import { invokeWithTimeout } from "../utils/invokeWithTimeout";

export interface UseHcfsSyncResult {
  setupAndInitialize: (
    accountId: string,
    label: string,
    serverUrl: string,
    password: string,
    mnemonic?: string
  ) => Promise<InitSyncResult | null>;
  checkConfig: (accountId: string) => Promise<HcfsConfigResult>;
  isInitializing: boolean;
  mnemonicToBackup: string | null;
  clearMnemonicBackup: () => void;
  needsSetup: boolean;
  setNeedsSetup: (value: boolean) => void;
  error: string | null;
  clearError: () => void;
}

export function useHcfsSync(): UseHcfsSyncResult {
  const [isInitializing, setIsInitializing] = useState(false);
  const [mnemonicToBackup, setMnemonicToBackup] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkConfig = useCallback(async (accountId: string): Promise<HcfsConfigResult> => {
    try {
      return await getHcfsConfig(accountId);
    } catch (err) {
      console.error("[useHcfsSync] Failed to check config:", err);
      return { server_url: "", has_password: false };
    }
  }, []);

  /** Save HCFS config and initialize sync.
   *  Callers MUST call `invoke("stop_sync")` before this if a sync loop is already running. */
  const setupAndInitialize = useCallback(
    async (
      accountId: string,
      label: string,
      serverUrl: string,
      password: string,
      mnemonic?: string
    ): Promise<InitSyncResult | null> => {
      setError(null);
      setIsInitializing(true);

      try {
        // Single Rust call: saves config + persists mnemonic + initializes sync
        const result = await invoke<InitSyncResult>("setup_and_init_sync", {
          accountId,
          label,
          serverUrl,
          password,
          mnemonic: mnemonic ?? null,
        });

        // If a new mnemonic was generated, show backup dialog
        if (result.mnemonic) {
          setMnemonicToBackup(result.mnemonic);
        }

        setNeedsSetup(false);
        console.log("[useHcfsSync] Setup and init completed:", result.user_id);
        return result;
      } catch (err) {
        const errorMsg = errorMessage(err);
        console.error("[useHcfsSync] Setup failed:", errorMsg);
        setError(errorMsg);
        return null;
      } finally {
        setIsInitializing(false);
      }
    },
    []
  );

  const clearMnemonicBackup = useCallback(() => {
    setMnemonicToBackup(null);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    setupAndInitialize,
    checkConfig,
    isInitializing,
    mnemonicToBackup,
    clearMnemonicBackup,
    needsSetup,
    setNeedsSetup,
    error,
    clearError,
  };
}

interface AutoInitResult {
  anyInitialized: boolean;
  isConfigured: boolean;
  skippedReason: string | null;
}

/**
 * Standalone function for use outside React components (e.g., in wallet-auth-context).
 *
 * All business logic (migration lock, mnemonic persistence, path queries,
 * HCFS config check, path filtering, sequential init) lives in Rust.
 * This function is a thin wrapper that calls Rust and updates the
 * `isSyncConfigured` atom — per-drive sync status is mirrored from
 * Rust by `useDriveStatuses`.
 *
 * ## Retry behavior
 *
 * On slow systems the FE can invoke `auto_init_sync` before Rust has
 * finished writing `AuthInfo.mnemonic` from `rehydrate_full_session`.
 * Rust then returns `NotReady(MASTER_MNEMONIC_UNRECOVERABLE)` and every
 * drive fails. This wrapper handles the race with a 3-attempt ladder:
 *
 *   1. Fire immediately (covers the happy path where auth is already
 *      populated).
 *   2. If attempt 1 returned the mnemonic-unavailable error, race a
 *      750 ms backoff against the `hippius_auth_ready` event — whichever
 *      fires first triggers attempt 2. Covers the fast case where
 *      `rehydrate_full_session` is milliseconds away from finishing.
 *   3. If attempt 2 also failed, race up to 9.25 s of remaining budget
 *      (10 s total from the subscription) against the event again. Any
 *      additional event fired during earlier attempts is still captured
 *      because the listener is subscribed BEFORE attempt 1.
 *
 * ### Why the listener subscribes before attempt 1
 *
 * Previous versions installed `listen()` only after attempts 1 and 2
 * had returned. On slow-system cold starts where
 * `rehydrate_full_session` finishes during attempt 1 or the backoff,
 * Rust's `hippius_auth_ready` emit landed before the listener was
 * installed and the signal was silently lost — the FE then waited the
 * full 10 s for an event that had already fired, and eventually gave
 * up. Subscribing first guarantees we never miss the signal regardless
 * of which attempt is in flight when it arrives.
 *
 * Any error other than `MasterMnemonicUnrecoverable` (network,
 * validation, credits) is terminal and must not retry — those need
 * user action.
 */
export async function tryAutoInitSync(
  accountId: string
): Promise<boolean> {
  // `auto_init_sync` no longer takes a mnemonic argument. Rust reads the
  // active mnemonic from `AuthInfo` via `get_mnemonic_for_account` (stage
  // 1 of the fallback chain), which every login path — mnemonic, OAuth
  // via `ensure_sync_mnemonic`, and keychain-backed session restore —
  // populates before reaching this call. Passing the phrase from JS
  // offered no capability beyond keeping it alive in heap memory longer
  // than necessary.
  const attempt = async (): Promise<"retry" | boolean> => {
    try {
      // 15s wall-clock cap per attempt. `auto_init_sync_inner`
      // contains its own bounded operations (HCFS config read,
      // credit check, per-drive init fan-out), but a deadlock in
      // any one of those would otherwise leave this promise
      // pending forever — and the retry ladder ABOVE relies on
      // `attempt()` returning so it can decide whether to wait for
      // `hippius_auth_ready` and try again. With the cap, the worst
      // case is 3 timeouts (~45s) and a clean false return; without
      // it, the worst case is "never returns".
      const result = await invokeWithTimeout<AutoInitResult>(
        "auto_init_sync",
        { accountId, mnemonic: null },
        15_000,
      );

      // Per-drive Active status is emitted by Rust from `auto_init_sync`
      // for each successful drive init — useDriveStatuses picks them up
      // via the hcfs_drive_status_changed event, which feeds
      // hasConfiguredDrivesAtom (the source of truth for "configured?").

      return result.anyInitialized;
    } catch (err) {
      // Treat timeout the same as a retryable transient failure:
      // the next attempt may succeed if the underlying hang clears
      // (e.g. a Rust-side lock that was briefly held). Bail terminal
      // only after the full retry budget is exhausted.
      if (err instanceof Error && err.message.endsWith("timed out")) {
        console.warn("[AutoSync] auto_init_sync timed out — will retry");
        return "retry";
      }
      // `MasterMnemonicUnrecoverable` is the specific signal that auth
      // state hasn't been populated yet. Any other error (insufficient
      // credits, validation, network) is terminal and must not retry.
      if (isNotReady(err, "MASTER_MNEMONIC_UNRECOVERABLE")) {
        console.warn(
          "[AutoSync] mnemonic not yet recoverable — will retry when auth is ready"
        );
        return "retry";
      }
      console.error("[AutoSync] auto_init_sync failed:", err);
      return false;
    }
  };

  // ── Subscribe to `hippius_auth_ready` BEFORE attempt 1 ───────────
  //
  // `authReadyPromise` resolves the first time the event fires and
  // stays resolved thereafter, so any signal fired during attempt 1
  // or during the backoff wait is captured. Without this pre-
  // subscription, signals that land between attempts are silently
  // lost and the FE waits the full 10 s for an already-fired event.
  let unlisten: (() => void) | null = null;
  let resolveAuthReady: (() => void) | null = null;
  const authReadyPromise = new Promise<void>((resolve) => {
    resolveAuthReady = resolve;
  });

  try {
    unlisten = await listen("hippius_auth_ready", () => {
      if (resolveAuthReady) {
        resolveAuthReady();
        resolveAuthReady = null; // fire-once latch
      }
    });
  } catch (e) {
    console.error("[AutoSync] failed to subscribe to hippius_auth_ready", e);
    // Continue without the listener — the ladder degrades to pure
    // backoff waits, which still covers the common fast case.
  }

  // `waitFor` races the pre-subscribed auth-ready promise against a
  // sleep timer. If the event has already fired by the time this is
  // called, `authReadyPromise` is already resolved and `waitFor`
  // returns immediately — no lost signals.
  const waitFor = (ms: number): Promise<void> =>
    Promise.race([
      authReadyPromise,
      new Promise<void>((r) => setTimeout(r, ms)),
    ]);

  try {
    // Attempt 1: fire immediately. If auth is already ready, this
    // succeeds and we never hit the retry logic at all.
    const first = await attempt();
    if (first !== "retry") return first;

    // Attempt 2: race the 750 ms backoff against `hippius_auth_ready`.
    // Whichever fires first triggers the next attempt.
    await waitFor(750);
    const second = await attempt();
    if (second !== "retry") return second;

    // Attempt 3: wait up to 9.25 s more for auth ready (10 s total
    // budget from listener subscription). Whichever fires first
    // triggers the final attempt.
    await waitFor(9_250);
    const third = await attempt();
    if (third === "retry") {
      console.warn(
        "[AutoSync] mnemonic still not recoverable after 3 attempts; giving up"
      );
      return false;
    }
    return third;
  } finally {
    if (unlisten) unlisten();
  }
}
