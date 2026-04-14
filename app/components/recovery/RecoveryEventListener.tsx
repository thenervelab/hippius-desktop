"use client";

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAtom } from "jotai";

import {
  RecoveryCheck,
  activeRecoveryCheckAtom,
} from "@/app/lib/global-atoms/recoveryAtoms";

/**
 * Listens for the backend `oauth_recovery_check_needed` event and
 * activates the `AccountRecoveryDialog` with the payload. Mounted once
 * at the top of the pages layout — renders nothing.
 *
 * The backend only emits this event when OAuth completes, so this hook
 * never activates the dialog for mnemonic-login or session-restore
 * paths — matching the backend gate default (`Skipped`) for those.
 */
const RecoveryEventListener: React.FC = () => {
  const [current, setCheck] = useAtom(activeRecoveryCheckAtom);

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

  return null;
};

export default RecoveryEventListener;
