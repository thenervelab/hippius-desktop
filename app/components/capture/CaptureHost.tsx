"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";
import { captureRecordingAtom, captureSupportedAtom } from "@/app/lib/capture/captureFlow";
import { useStartCapture } from "@/app/lib/capture/useStartCapture";
import { getCaptureSupport, type CaptureKind, type CaptureMode } from "@/app/lib/tauri/capture";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import CaptureDestinationDialog from "./CaptureDestinationDialog";
import CapturePermissionDialog from "./CapturePermissionDialog";

/**
 * Mounted once in the protected layout. Owns the capture dialogs and the
 * events that finish a capture, so every surface that starts one shares them.
 */
export default function CaptureHost() {
  const setSupported = useSetAtom(captureSupportedAtom);
  const setRecording = useSetAtom(captureRecordingAtom);
  const startCapture = useStartCapture();
  const queryClient = useQueryClient();
  const { polkadotAddress } = useWalletAuth();

  useEffect(() => {
    if (!SCREEN_CAPTURE_ENABLED) return;
    getCaptureSupport()
      .then((s) => {
        setSupported(s.supported);
        setRecording(s.recording);
      })
      .catch(() => {
        setSupported(false);
        setRecording(false);
      });
  }, [setSupported, setRecording]);

  useEffect(() => {
    if (!SCREEN_CAPTURE_ENABLED) return;
    const unlisteners = [
      listen("capture_delivered", () => void notifyFilesMutated(queryClient, polkadotAddress)),
      listen<{ message: string }>("capture_failed", (e) => {
        toast.error(e.payload.message);
      }),
      listen<{ kind?: CaptureKind; mode: CaptureMode }>("hippius:tray-capture", (e) => {
        void startCapture(e.payload.kind ?? "screenshot", e.payload.mode);
      }),
    ];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, [startCapture, queryClient, polkadotAddress]);

  if (!SCREEN_CAPTURE_ENABLED) return null;
  return (
    <>
      <CaptureDestinationDialog />
      <CapturePermissionDialog />
    </>
  );
}
