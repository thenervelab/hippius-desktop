"use client";

import { useCallback } from "react";
import { useSetAtom } from "jotai";
import { toast } from "sonner";
import { startCapture, type CaptureMode } from "@/app/lib/tauri/capture";
import { captureDialogAtom, classifyCaptureRefusal } from "./captureFlow";

/**
 * Start a screenshot, and answer a refusal with the dialog that resolves it.
 *
 * Every surface calls this rather than `startCapture` directly, so a first
 * capture from the tray asks for a drive exactly as one from the Drive header
 * does.
 */
export function useStartCapture(): (mode: CaptureMode) => Promise<void> {
  const setDialog = useSetAtom(captureDialogAtom);
  return useCallback(
    async (mode: CaptureMode) => {
      try {
        await startCapture("screenshot", mode);
      } catch (error) {
        const refusal = classifyCaptureRefusal(error);
        if (refusal.next === "choose-destination") {
          setDialog({ kind: "destination", resumeMode: mode });
        } else if (refusal.next === "grant-permission") {
          setDialog({ kind: "permission" });
        } else {
          toast.error(refusal.message);
        }
      }
    },
    [setDialog],
  );
}
