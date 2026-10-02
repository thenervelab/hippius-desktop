"use client";

import { useCallback } from "react";
import { useSetAtom } from "jotai";
import { toast } from "sonner";
import { startCapture, type CaptureKind, type CaptureMode } from "@/app/lib/tauri/capture";
import { openAppWindow } from "@/app/lib/tray/trayWindowActions";
import { captureDialogAtom, classifyCaptureRefusal } from "./captureFlow";

/**
 * Open the capture bar, and answer a refusal with the dialog that resolves it.
 *
 * `kind` and `mode` preselect the bar (a Capture menu item); left out, it opens
 * on whatever was used last (the shortcut, the tray).
 *
 * Every surface calls this rather than `startCapture` directly, so a first
 * capture from the shortcut asks for a drive exactly as one from the Drive
 * header does. The dialogs live in the main window, which may be hidden when
 * the shortcut fires from another app, so a refusal brings it forward first.
 */
export function useStartCapture(): (kind?: CaptureKind, mode?: CaptureMode) => Promise<void> {
  const setDialog = useSetAtom(captureDialogAtom);
  return useCallback(
    async (kind?: CaptureKind, mode?: CaptureMode) => {
      try {
        await startCapture(kind, mode);
      } catch (error) {
        const refusal = classifyCaptureRefusal(error);
        if (refusal.next === "choose-destination") {
          await openAppWindow();
          setDialog({ kind: "destination", resume: { kind, mode } });
        } else if (refusal.next === "grant-permission") {
          await openAppWindow();
          setDialog({ kind: "permission" });
        } else {
          toast.error(refusal.message);
        }
      }
    },
    [setDialog],
  );
}
