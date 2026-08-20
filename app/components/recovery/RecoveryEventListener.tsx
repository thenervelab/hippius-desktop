"use client";

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAtom } from "jotai";

import {
  RecoveryCheck,
  activeRecoveryCheckAtom,
} from "@/app/lib/global-atoms/recoveryAtoms";
import { checkRecoveryState, hasPendingRotation } from "@/app/lib/utils/recovery";
import { isExpectedNoSessionError } from "@/app/lib/utils/errorUtils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import FinishRotationDialog from "./FinishRotationDialog";

/**
 * Listens for the backend `oauth_recovery_check_needed` event and
 * activates the `AccountRecoveryDialog` with the payload. Mounted once
 * at the top of the pages layout — renders nothing.
 *
 * Backend emits this event from two places: `complete_oauth_flow`
 * (first-time OAuth) and `session_restore` (returning-device OAuth when
 * the local mnemonic can't be decrypted without the recovery password).
 * The session-restore emit can fire BEFORE this listener mounts —
 * `OnBoardingGuard` gates the layout on `isAuthenticated`, and the
 * event lands during the auth-establishing window. To cover that race,
 * we also query `check_recovery_state` once on mount and adopt any
 * non-`proceed` flow, which idempotently recovers the missed emit.
 *
 * Additionally listens for the `recovery_rotation_pending` event
 * emitted when a prior recovery-password rotation succeeded on the
 * server but failed to rewrite the local encrypted blob. On mount it
 * also checks `hasPendingRotation()` to cover the case where the
 * backend emitted the event before this listener subscribed.
 */
const RecoveryEventListener: React.FC = () => {
  const [current, setCheck] = useAtom(activeRecoveryCheckAtom);
  const [finishRotationOpen, setFinishRotationOpen] = useState(false);
  const { authType } = useWalletAuth();

  // Latest authType for the once-per-mount probe below, without widening
  // that effect's deps (its once-only semantics are deliberate).
  const authTypeRef = useRef(authType);
  authTypeRef.current = authType;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen<RecoveryCheck>("oauth_recovery_check_needed", (e) => {
        // OAuthCallbackPage already populates the atom via an explicit
        // `check_recovery_state` invoke before navigating — that's the
        // primary path. This listener only fills the gap if the
        // callback failed to set the atom (e.g. network error). Skip
        // the write when the atom is already populated to avoid
        // overwriting a dialog that's mid-flow.
        if (current === null) {
          setCheck(e.payload);
        }
      });
    })();
    return () => {
      unlisten?.();
    };
  }, [current, setCheck]);

  // Self-heal for the session-restore race: if the backend emitted
  // `oauth_recovery_check_needed` during session_restore — before this
  // component mounted (gated on `isAuthenticated` by OnBoardingGuard) —
  // the event was lost. Query the current recovery state once on mount
  // and adopt any actionable flow. `proceed` is a no-op (local is
  // authoritative). `unlock`/`signup` pop their dialog; `unknown` pops
  // the connection-retry dialog — without adopting it here, a probe that
  // failed during the pre-mount window leaves the user with no UI and a
  // wedged recovery gate (the fresh-OAuth-device bug). Skip when the
  // atom is already populated to avoid racing the live listener above.
  //
  // `unknown` is adopted for OAUTH sessions only. A mnemonic user with an
  // undecryptable local master (locked/empty keychain) booting OFFLINE
  // also produces `unknown` now that `decide_recovery_flow` keeps that
  // shape Unknown — but their recovery is re-entering the seed phrase
  // (the reauth banner restore already raised), which needs no network;
  // trapping them behind the non-dismissable connection-retry modal
  // blocked the whole app for nothing (PR #124 review). `unlock`/`signup`
  // stay auth-type-blind: both are genuinely actionable for mnemonic
  // users too (an unlock password set in settings).
  useEffect(() => {
    if (current !== null) return;
    let cancelled = false;
    void (async () => {
      // One delayed second try for UNEXPECTED probe errors: the silent
      // catch assumed "no active account during early boot", but an IPC
      // failure for any other reason left zero recovery UI with the gate
      // parked Pending — the app looked healthy with sync silently off.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const check = await checkRecoveryState();
          if (cancelled) return;
          const adopt =
            check.recommendedFlow === "unlock" ||
            check.recommendedFlow === "signup" ||
            (check.recommendedFlow === "unknown" &&
              authTypeRef.current === "oauth");
          if (adopt) {
            // Functional write so a dialog opened AFTER mount but before
            // this probe resolved (the banner CTA, the live listener) is
            // never clobbered by the stale result — the effect-time
            // `current === null` check can't see those writes.
            setCheck((prev) => prev ?? check);
          }
          return;
        } catch (err) {
          if (isExpectedNoSessionError(err) || attempt === 1) {
            // Pre-auth boot gap (expected) or retry exhausted — leave the
            // wake to the live event listener.
            console.debug(
              "[RecoveryEventListener] mount-time recovery probe skipped:",
              err,
            );
            return;
          }
          await new Promise((r) => setTimeout(r, 5_000));
          if (cancelled) return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally runs once per mount; subsequent atom changes are
    // driven by the live listener and the dialog's own onDone/onRetry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        if (await hasPendingRotation()) {
          setFinishRotationOpen(true);
        }
      } catch (err) {
        // `hasPendingRotation` may fail if there isn't an active
        // session yet (the IPC needs a logged-in account). This is
        // expected during early boot — swallow so the listener below
        // still subscribes.
        console.warn("hasPendingRotation check failed:", err);
      }
      unlisten = await listen<string>("recovery_rotation_pending", () => {
        setFinishRotationOpen(true);
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  return (
    <FinishRotationDialog
      open={finishRotationOpen}
      onOpenChange={setFinishRotationOpen}
    />
  );
};

export default RecoveryEventListener;
