"use client";

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSetAtom } from "jotai";

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
  const setCheck = useSetAtom(activeRecoveryCheckAtom);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen<RecoveryCheck>("oauth_recovery_check_needed", (e) => {
        // `proceed` still comes through so the dialog auto-skips via
        // ProceedBranch and confirms the gate state. Backend has already
        // set the gate correctly; this is belt-and-braces for the case
        // where the gate was set before any waiter existed.
        setCheck(e.payload);
      });
    })();
    return () => {
      unlisten?.();
    };
  }, [setCheck]);

  return null;
};

export default RecoveryEventListener;
