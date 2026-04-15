"use client";

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAtom } from "jotai";

import {
  RecoveryCheck,
  activeRecoveryCheckAtom,
} from "@/app/lib/global-atoms/recoveryAtoms";
import { hasPendingRotation } from "@/app/lib/utils/recovery";
import FinishRotationDialog from "./FinishRotationDialog";

/**
 * Listens for the backend `oauth_recovery_check_needed` event and
 * activates the `AccountRecoveryDialog` with the payload. Mounted once
 * at the top of the pages layout — renders nothing.
 *
 * The backend only emits this event when OAuth completes, so this hook
 * never activates the dialog for mnemonic-login or session-restore
 * paths — matching the backend gate default (`Skipped`) for those.
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
