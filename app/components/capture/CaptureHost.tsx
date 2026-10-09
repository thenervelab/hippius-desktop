"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";
import {
  captureDialogAtom,
  captureModesAtom,
  capturePermissionPaneAtom,
  captureRecordingAtom,
  captureRecordingNoteAtom,
  captureSupportedAtom,
  captureSurfacesAtom,
} from "@/app/lib/capture/captureFlow";
import { disabledRecordingNote, supportedModesOf } from "@/app/lib/capture/modes";
import { useStartCapture } from "@/app/lib/capture/useStartCapture";
import {
  CAPTURE_DRIVE_SETUP_NEEDED_EVENT,
  getCaptureSupport,
  syncCaptureShortcut,
  type CaptureFailed,
  type CaptureKind,
  type CaptureShortcutStart,
  type CaptureMode,
  type CaptureShowInFolder,
} from "@/app/lib/tauri/capture";
import { BILLING_ROUTE, capturesRoute, driveFolderRoute } from "@/app/lib/routes";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import { openAppWindow, TRAY_CAPTURE_DRIVE_EVENT, TRAY_CAPTURE_EVENT } from "@/app/lib/tray/trayWindowActions";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import CaptureDriveDialog from "./CaptureDriveDialog";
import CapturePermissionDialog from "./CapturePermissionDialog";
import RecordingLimitDialog from "./RecordingLimitDialog";

/**
 * Mounted once in the protected layout. Owns the capture dialogs and the
 * events that start or finish a capture, so every surface shares them: the
 * system-wide shortcut, the tray, and the preview card's "Show in folder"
 * and "Upgrade", which land here as a navigation to the Captures page (or
 * the drive an older capture went to) or to the plans. It also asks where
 * captures go when Rust says a capture is waiting for that answer.
 */
export default function CaptureHost() {
  const setSupported = useSetAtom(captureSupportedAtom);
  const setRecording = useSetAtom(captureRecordingAtom);
  const setRecordingNote = useSetAtom(captureRecordingNoteAtom);
  const setPermissionPane = useSetAtom(capturePermissionPaneAtom);
  const setModes = useSetAtom(captureModesAtom);
  const setSurfaces = useSetAtom(captureSurfacesAtom);
  const setDialog = useSetAtom(captureDialogAtom);
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
        setRecordingNote(s.recording ? null : disabledRecordingNote(s));
        setPermissionPane(s.permissionPane);
        setModes(supportedModesOf(s));
        setSurfaces(s);
        // The saved shortcut is registered once the signed-in app is up.
        if (s.supported) void syncCaptureShortcut().catch(() => undefined);
      })
      .catch(() => {
        setSupported(false);
        setRecording(false);
        setRecordingNote(null);
      });
  }, [setSupported, setRecording, setRecordingNote, setPermissionPane, setModes, setSurfaces]);

  useEffect(() => {
    if (!SCREEN_CAPTURE_ENABLED) return;
    const unlisteners = [
      listen("capture_delivered", () => void notifyFilesMutated(queryClient, polkadotAddress)),
      // The preview card already shows a failure it is showing; a toast would say it twice.
      listen<CaptureFailed>("capture_failed", (e) => {
        if (!e.payload.cardShowing) toast.error(e.payload.message);
      }),
      listen<{ kind?: CaptureKind; mode?: CaptureMode }>(TRAY_CAPTURE_EVENT, (e) => {
        void startCapture(e.payload.kind, e.payload.mode);
      }),
      // The popover's "Captures folder…": the dialog is this window's.
      listen(TRAY_CAPTURE_DRIVE_EVENT, () => {
        void openAppWindow().then(() => setDialog({ kind: "captureDrive" }));
      }),
      // A capture is waiting for the user to say where captures go. Rust has
      // brought this window forward and kept the capture safe meanwhile.
      listen(CAPTURE_DRIVE_SETUP_NEEDED_EVENT, () => setDialog({ kind: "captureDrive" })),
      // The system-wide shortcuts: what Rust says each starts (the one-step
      // area screenshot, or the capture bar on Record).
      listen<CaptureShortcutStart>("capture_shortcut_pressed", (e) =>
        void startCapture(e.payload?.kind, undefined, e.payload?.instant ?? false),
      ),
      listen<CaptureShowInFolder>("capture_show_in_folder", (e) => {
        const file = e.payload.fileName || undefined;
        router.push(
          e.payload.capturesDrive
            ? capturesRoute(e.payload.label, e.payload.remote, file)
            : driveFolderRoute(e.payload.label, e.payload.remote, e.payload.subfolder, file),
        );
      }),
      // The card's Upgrade (the plan is full): the plans, where every upgrade prompt goes.
      listen("capture_open_plans", () => router.push(BILLING_ROUTE)),
    ];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, [startCapture, queryClient, polkadotAddress, router, setDialog]);

  if (!SCREEN_CAPTURE_ENABLED) return null;
  return (
    <>
      <CaptureDriveDialog />
      <CapturePermissionDialog />
      <RecordingLimitDialog />
    </>
  );
}
