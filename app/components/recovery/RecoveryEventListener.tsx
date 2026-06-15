"use client";

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAtom } from "jotai";

import {
  RecoveryCheck,
  activeRecoveryCheckAtom,
} from "@/app/lib/global-atoms/recoveryAtoms";
import { checkRecoveryState, hasPendingRotation } from "@/app/lib/utils/recovery";
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
  useEffect(() => {
    if (current !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const check = await checkRecoveryState();
        if (cancelled) return;
        if (check.recommendedFlow !== "proceed") {
          setCheck(check);
        }
      } catch (err) {
        // Pre-auth invocations of the backend command error with
        // "no active account" — expected during early boot. Silent
        // skip so the live event listener still handles the wake.
        console.debug("[RecoveryEventListener] mount-time recovery probe skipped:", err);
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
