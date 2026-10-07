"use client";

import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { FolderOpen, ScanEye, VideoOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";
import {
  captureDialogAtom,
  captureRecordingAtom,
  captureRecordingNoteAtom,
  captureSupportedAtom,
  captureSurfacesAtom,
} from "@/app/lib/capture/captureFlow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  CAPTURE_DRIVE_CHANGED_EVENT,
  getCaptureDriveStatus,
  type CaptureDriveStatus,
} from "@/app/lib/tauri/capture";
import EditedImageSetting from "./EditedImageSetting";
import CaptureShortcutSetting from "./CaptureShortcutSetting";
import CaptureOptionsSetting from "./CaptureOptionsSetting";
import { SettingIcon } from "./SettingIcon";
import { isMacPlatform } from "@/app/lib/capture/shortcutLabel";
import { errorMessage } from "@/app/lib/utils/errorUtils";

const SURFACE = "rounded-[12px] border border-grey-dark-100 bg-white dark:border-black-300 dark:bg-black-600";
/** A full-width setting: icon and words on the left, its control on the right. */
const ROW = `flex flex-wrap items-center justify-between gap-4 px-4 py-3 ${SURFACE}`;
/** A shortcut's tile: the keys large under its name, the buttons at the foot. */
const TILE = `flex h-full flex-col gap-4 p-4 ${SURFACE}`;
/** An on/off or pick-one setting's card in the grid. */
const CARD = `flex h-full flex-col gap-3 p-4 ${SURFACE}`;

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

  // Layout: the two shortcuts first and largest (what people come here to
  // change), side by side; then where captures are kept; then the on/off
  // choices as a grid of small cards; then what Save does in the editor.
  // `@container` so the columns follow the tab's own width, not the window.
  return (
    <div className="@container flex flex-col gap-3">
      <div className="grid gap-3 @xl:grid-cols-2">
        <CaptureShortcutSetting kind="screenshot" support={surfaces?.shortcut ?? null} rowClassName={TILE} layout="tile" />
        {recordingWorks && (
          <CaptureShortcutSetting kind="record" support={surfaces?.recordShortcut ?? null} rowClassName={TILE} layout="tile" />
        )}
      </div>

      <div className={ROW}>
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <SettingIcon>
            <FolderOpen className="size-[18px]" strokeWidth={2} />
          </SettingIcon>
          <div className="min-w-0">
            <p className="text-sm font-medium text-grey-10 dark:text-white">Capture folder</p>
            <p data-testid="capture-destination-line" className="mt-1 text-[13px] leading-snug text-[#7D7D7D] dark:text-grey-dark-600">
              {captureDriveLine(drive)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {drive?.state === "ready" && drive.location && !drive.remote && (
            <Button variant="defaultStable" size="sm" onClick={() => void revealCaptureFolder(drive.label)}>
              {isMacPlatform() ? "Show in Finder" : "Show in folder"}
            </Button>
          )}
          <Button variant="defaultStable" size="sm" onClick={() => setDialog({ kind: "captureDrive" })}>
            {drive?.state === "ready" ? "Change" : drive?.state === "pending" ? "Try again" : "Set up"}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-4">
        <CaptureOptionsSetting
          rowClassName={CARD}
          layout="cards"
          recording={recordingWorks}
          recordCountdown={surfaces?.recordCountdown ?? true}
          systemAudio={surfaces?.systemAudio ?? false}
        />
      </div>

      <EditedImageSetting rowClassName={ROW} />

      {recordingNote && (
        <div className={ROW}>
          <div className="flex min-w-0 items-start gap-3">
            <SettingIcon tone="muted">
              <VideoOff className="size-[18px]" strokeWidth={2} />
            </SettingIcon>
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
            <SettingIcon>
              <ScanEye className="size-[18px]" strokeWidth={2} />
            </SettingIcon>
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

/** Opens the captures drive's folder in the file manager (Rust reveals it). */
async function revealCaptureFolder(label: string): Promise<void> {
  try {
    await invoke("reveal_drive_in_finder", { label });
  } catch (e) {
    toast.error(errorMessage(e));
  }
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
