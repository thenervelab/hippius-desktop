"use client";

import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Camera, ScanEye, VideoOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";
import {
  captureDialogAtom,
  captureRecordingAtom,
  captureRecordingNoteAtom,
  captureSupportedAtom,
  captureSurfacesAtom,
} from "@/app/lib/capture/captureFlow";
import { listen } from "@tauri-apps/api/event";
import {
  CAPTURE_DRIVE_CHANGED_EVENT,
  getCaptureDriveStatus,
  type CaptureDriveStatus,
} from "@/app/lib/tauri/capture";
import EditedImageSetting from "./EditedImageSetting";
import CaptureShortcutSetting from "./CaptureShortcutSetting";
import CaptureOptionsSetting from "./CaptureOptionsSetting";

const ROW =
  "flex flex-wrap items-center justify-between gap-4 rounded-[8px] border border-grey-dark-100 bg-white px-4 py-3 dark:border-black-300 dark:bg-black-600";

/**
 * Settings › Screenshots & Recording: every capture setting in one tab. In
 * order: the screenshot shortcut, the recording shortcut (where this
 * computer records), where captures are kept (asked on the first capture,
 * moved here), what the screenshot editor's Save does, and the capture
 * bar's options that carry over from one capture to the next (copy a link,
 * open it, the recording countdown, system audio). Rust validates,
 * registers and stores all of it; each row only shows and sends. Hidden
 * where capture is not available. Where this computer could record with
 * another build or a newer OS, a row says why in Rust's words; where the
 * desktop's own tool takes screenshots (Wayland), a row says so.
 */
export default function CaptureSettings() {
  const supported = useAtomValue(captureSupportedAtom);
  const recordingWorks = useAtomValue(captureRecordingAtom);
  const recordingNote = useAtomValue(captureRecordingNoteAtom);
  const surfaces = useAtomValue(captureSurfacesAtom);
  const setDialog = useSetAtom(captureDialogAtom);
  const [drive, setDrive] = useState<CaptureDriveStatus | null>(null);

  const reload = useCallback(() => {
    getCaptureDriveStatus()
      .then(setDrive)
      .catch(() => setDrive(null));
  }, []);

  useEffect(() => {
    if (SCREEN_CAPTURE_ENABLED && supported) reload();
  }, [supported, reload]);

  // Set up or moved elsewhere (the dialog, a first capture): show where now.
  useEffect(() => {
    if (!SCREEN_CAPTURE_ENABLED || !supported) return;
    const unlisten = listen(CAPTURE_DRIVE_CHANGED_EVENT, () => reload());
    return () => void unlisten.then((fn) => fn()).catch(() => undefined);
  }, [supported, reload]);

  if (!SCREEN_CAPTURE_ENABLED || !supported) return null;

  return (
    <div className="flex flex-col gap-3">
      <CaptureShortcutSetting kind="screenshot" support={surfaces?.shortcut ?? null} rowClassName={ROW} />

      {recordingWorks && (
        <CaptureShortcutSetting kind="record" support={surfaces?.recordShortcut ?? null} rowClassName={ROW} />
      )}

      <div className={ROW}>
        <div className="flex min-w-0 items-start gap-3">
          <Camera className="mt-0.5 size-[18px] flex-shrink-0 text-primary-50 dark:text-primary-brand-dark" strokeWidth={2} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-grey-10 dark:text-white">Capture folder</p>
            <p data-testid="capture-destination-line" className="mt-1 text-sm text-[#7D7D7D] dark:text-grey-dark-600">
              {captureDriveLine(drive)}
            </p>
          </div>
        </div>
        <Button variant="defaultStable" size="sm" onClick={() => setDialog({ kind: "captureDrive" })}>
          {drive?.state === "ready" ? "Change" : drive?.state === "pending" ? "Try again" : "Set up"}
        </Button>
      </div>

      <EditedImageSetting rowClassName={ROW} />

      <CaptureOptionsSetting
        rowClassName={ROW}
        recording={recordingWorks}
        recordCountdown={surfaces?.recordCountdown ?? true}
        systemAudio={surfaces?.systemAudio ?? false}
      />

      {recordingNote && (
        <div className={ROW}>
          <div className="flex min-w-0 items-start gap-3">
            <VideoOff className="mt-0.5 size-[18px] flex-shrink-0 text-grey-50 dark:text-grey-dark-600" strokeWidth={2} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-grey-10 dark:text-white">Screen recording</p>
              <p className="mt-1 text-sm text-[#7D7D7D] dark:text-grey-dark-600">
                {recordingNote} Screenshots still work.
              </p>
            </div>
          </div>
        </div>
      )}

      {surfaces?.systemPickerNote && (
        <div className={ROW}>
          <div className="flex min-w-0 items-start gap-3">
            <ScanEye className="mt-0.5 size-[18px] flex-shrink-0 text-primary-50 dark:text-primary-brand-dark" strokeWidth={2} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-grey-10 dark:text-white">Screenshots</p>
              <p className="mt-1 text-sm text-[#7D7D7D] dark:text-grey-dark-600">{surfaces.systemPickerNote}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The Capture folder row's sentence for where the captures drive stands. */
export function captureDriveLine(drive: CaptureDriveStatus | null): string {
  if (!drive) return "Screenshots and recordings are kept in a Hippius Captures folder of their own.";
  if (drive.state === "ready") {
    return drive.location
      ? `Screenshots and recordings are saved in ${drive.location.place} and backed up as a drive.`
      : `Screenshots and recordings are saved in your ${drive.name} drive.`;
  }
  if (drive.state === "pending") return drive.message;
  return `Your first capture asks where to keep them, with ${drive.suggested.place} suggested. You can set it up now.`;
}
