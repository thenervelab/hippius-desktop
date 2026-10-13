"use client";

import { useCallback } from "react";
import { useSetAtom } from "jotai";
import { toast } from "sonner";
import { startCapture, upgradeFromRecordingLimit, type CaptureKind, type CaptureMode } from "@/app/lib/tauri/capture";
import { openAppWindow } from "@/app/lib/tray/trayWindowActions";
import { captureDialogAtom, classifyCaptureRefusal } from "./captureFlow";

/**
 * Open the capture bar, and answer a refusal with the dialog that resolves it.
 *
 * `kind` and `mode` preselect the bar (a Capture menu item); left out, it opens
 * on whatever was used last (the tray). `instant` is the shortcut's one-step
 * area screenshot, with no bar.
 *
 * Every surface calls this rather than `startCapture` directly, so a refusal
 * from the shortcut is answered exactly as one from the Drive header is. The
 * dialogs live in the main window, which may be hidden when
 * the shortcut fires from another app, so a refusal brings it forward first.
 */
export function useStartCapture(): (kind?: CaptureKind, mode?: CaptureMode, instant?: boolean) => Promise<void> {
  const setDialog = useSetAtom(captureDialogAtom);
  const start = useCallback(
    async function run(kind?: CaptureKind, mode?: CaptureMode, instant?: boolean): Promise<void> {
      try {
        await startCapture(kind, mode, instant);
      } catch (error) {
        const refusal = classifyCaptureRefusal(error);
        if (refusal.next === "grant-permission") {
          await openAppWindow();
          setDialog({ kind: "permission" });
        } else if (refusal.next === "recording-limit") {
          // A Record start on a free plan whose recordings are used up:
          // nothing opened, so the main window says why.
          await openAppWindow();
          setDialog({ kind: "recordingLimit" });
        } else if (refusal.next === "plan") {
          // Nothing was captured: the plan could not be read (Retry starts
          // the same capture again) or the account has no Drive storage
          // (Upgrade has Rust open the plans, as every upgrade prompt does).
          // Rust's words either way.
          await openAppWindow();
          toast.error(refusal.message, {
            action:
              refusal.action === "retry"
                ? { label: "Retry", onClick: () => void run(kind, mode, instant) }
                : { label: "Upgrade", onClick: () => void upgradeFromRecordingLimit().catch(() => undefined) },
          });
        } else {
          toast.error(refusal.message);
        }
      }
    },
    [setDialog],
  );
  return start;
}
