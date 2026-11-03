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
import { DesktopCopyOptions, RecordingOptions, SharingOptions, useCaptureChoices } from "./CaptureOptionsSetting";
import { SettingGroup, SettingRow } from "./SettingRow";
import { isMacPlatform } from "@/app/lib/capture/shortcutLabel";
import { errorMessage } from "@/app/lib/utils/errorUtils";

/**
 * Settings › Screenshots & Recording: every capture setting in one tab, in
 * four labelled groups so a reader finds a setting by what it is about:
 *
 * - Shortcuts: Record first (where this computer records), then Screenshot.
 * - Saving: where captures are kept, a copy on the Desktop, and what the
 *   screenshot editor's Save does.
 * - Sharing: the link made after a capture and what it shows.
 * - Recording: the countdown and the computer's sound (where it records).
 *
 * Rust validates, registers and stores all of it; each row only shows and
 * sends. Hidden where capture is not available. Where this computer could
 * record with another build or a newer OS, a row says why in Rust's words;
 * where the desktop's own tool takes screenshots (Wayland), a row says so.
 */
export default function CaptureSettings() {
  const supported = useAtomValue(captureSupportedAtom);
  const recordingWorks = useAtomValue(captureRecordingAtom);
  const recordingNote = useAtomValue(captureRecordingNoteAtom);
  const surfaces = useAtomValue(captureSurfacesAtom);
  const setDialog = useSetAtom(captureDialogAtom);
  const [drive, setDrive] = useState<CaptureDriveStatus | null>(null);
  const choices = useCaptureChoices();

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

  const recordCountdown = surfaces?.recordCountdown ?? true;
  const systemAudio = surfaces?.systemAudio ?? false;

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup label="Shortcuts">
        {recordingWorks && <CaptureShortcutSetting kind="record" support={surfaces?.recordShortcut ?? null} />}
        <CaptureShortcutSetting kind="screenshot" support={surfaces?.shortcut ?? null} />
        {surfaces?.systemPickerNote && (
          <SettingRow
            icon={<ScanEye className="size-[18px]" strokeWidth={2} />}
            title="Screenshots"
            description={surfaces.systemPickerNote}
          />
        )}
      </SettingGroup>

      <SettingGroup label="Saving">
        <SettingRow
          icon={<FolderOpen className="size-[18px]" strokeWidth={2} />}
          title="Capture folder"
          description={<span data-testid="capture-destination-line">{captureDriveLine(drive)}</span>}
          control={
            <>
              {drive?.state === "ready" && drive.location && !drive.remote && (
                <Button
                  variant="defaultStable"
                  size="sm"
                  onClick={() => void revealCaptureFolder(drive.label, drive.folder ? drive.location?.path : undefined)}
                >
                  {isMacPlatform() ? "Show in Finder" : "Show in folder"}
                </Button>
              )}
              <Button variant="defaultStable" size="sm" onClick={() => setDialog({ kind: "captureDrive" })}>
                {drive?.state === "ready" ? "Change" : drive?.state === "pending" ? "Try again" : "Set up"}
              </Button>
            </>
          }
        />
        <DesktopCopyOptions choices={choices} recording={recordingWorks} />
        <EditedImageSetting />
      </SettingGroup>

      {choices.options && (
        <SettingGroup label="Sharing">
          <SharingOptions choices={choices} />
        </SettingGroup>
      )}

      {recordingWorks && choices.options && (recordCountdown || systemAudio) && (
        <SettingGroup label="Recording">
          <RecordingOptions choices={choices} recordCountdown={recordCountdown} systemAudio={systemAudio} />
        </SettingGroup>
      )}

      {recordingNote && (
        <SettingGroup label="Recording">
          <SettingRow
            tone="muted"
            icon={<VideoOff className="size-[18px]" strokeWidth={2} />}
            title="Screen recording"
            description={`${recordingNote} Screenshots still work.`}
          />
        </SettingGroup>
      )}
    </div>
  );
}

/**
 * Opens the captures folder in the file manager (Rust reveals it): the drive
 * by its label, or the folder by its path when captures go to a folder
 * inside a drive.
 */
async function revealCaptureFolder(label: string, path?: string): Promise<void> {
  try {
    if (path) {
      await invoke("reveal_path_in_file_manager", { path });
    } else {
      await invoke("reveal_drive_in_finder", { label });
    }
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

/** The Capture folder row's sentence for where the captures drive stands. */
export function captureDriveLine(drive: CaptureDriveStatus | null): string {
  if (!drive) return "Screenshots and recordings are kept in a folder of their own.";
  if (drive.state === "ready") {
    if (drive.folder) {
      return drive.location
        ? `Screenshots and recordings are saved in ${drive.location.place}, in your ${drive.name} drive.`
        : `Screenshots and recordings are saved in ${drive.folder}, in your ${drive.name} drive.`;
    }
    return drive.location
      ? `Screenshots and recordings are saved in ${drive.location.place} and backed up as a drive.`
      : `Screenshots and recordings are saved in your ${drive.name} drive.`;
  }
  if (drive.state === "pending") return drive.message;
  return `Your first capture asks where to keep them, with ${drive.suggested.place} suggested. You can set it up now.`;
}
