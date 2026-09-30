"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";
import { capturePermissionPaneAtom, captureRecordingAtom, captureSupportedAtom } from "@/app/lib/capture/captureFlow";
import { useStartCapture } from "@/app/lib/capture/useStartCapture";
import {
  getCaptureSupport,
  syncCaptureShortcut,
  type CaptureFailed,
  type CaptureKind,
  type CaptureMode,
  type CaptureShowInFolder,
} from "@/app/lib/tauri/capture";
import { BILLING_ROUTE, driveFolderRoute } from "@/app/lib/routes";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import CaptureDestinationDialog from "./CaptureDestinationDialog";
import CapturePermissionDialog from "./CapturePermissionDialog";

/**
 * Mounted once in the protected layout. Owns the capture dialogs and the
 * events that start or finish a capture, so every surface shares them: the
 * system-wide shortcut, the tray, and the preview card's "Show in folder"
 * and "Upgrade", which land here as a navigation to the drive's Captures
 * folder or to the plans.
 */
export default function CaptureHost() {
  const setSupported = useSetAtom(captureSupportedAtom);
  const setRecording = useSetAtom(captureRecordingAtom);
  const setPermissionPane = useSetAtom(capturePermissionPaneAtom);
  const startCapture = useStartCapture();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { polkadotAddress } = useWalletAuth();

  useEffect(() => {
    if (!SCREEN_CAPTURE_ENABLED) return;
    getCaptureSupport()
      .then((s) => {
        setSupported(s.supported);
        setRecording(s.recording);
        setPermissionPane(s.permissionPane);
        // The saved shortcut is registered once the signed-in app is up.
        if (s.supported) void syncCaptureShortcut().catch(() => undefined);
      })
      .catch(() => {
        setSupported(false);
        setRecording(false);
      });
  }, [setSupported, setRecording, setPermissionPane]);

  useEffect(() => {
    if (!SCREEN_CAPTURE_ENABLED) return;
    const unlisteners = [
      listen("capture_delivered", () => void notifyFilesMutated(queryClient, polkadotAddress)),
      // The preview card already shows a failure it is showing; a toast would say it twice.
      listen<CaptureFailed>("capture_failed", (e) => {
        if (!e.payload.cardShowing) toast.error(e.payload.message);
      }),
      listen<{ kind?: CaptureKind; mode?: CaptureMode }>("hippius:tray-capture", (e) => {
        void startCapture(e.payload.kind, e.payload.mode);
      }),
      // The system-wide shortcut opens the bar on whatever was used last.
      listen("capture_shortcut_pressed", () => void startCapture()),
      listen<CaptureShowInFolder>("capture_show_in_folder", (e) => {
        router.push(driveFolderRoute(e.payload.label, e.payload.remote, e.payload.subfolder));
      }),
      // The card's Upgrade (the plan is full): the plans, where every upgrade prompt goes.
      listen("capture_open_plans", () => router.push(BILLING_ROUTE)),
    ];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, [startCapture, queryClient, polkadotAddress, router]);

  if (!SCREEN_CAPTURE_ENABLED) return null;
  return (
    <>
      <CaptureDestinationDialog />
      <CapturePermissionDialog />
    </>
  );
}
