"use client";

import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Camera, Keyboard, ScanEye, VideoOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";
import {
  captureDialogAtom,
  captureRecordingNoteAtom,
  captureSupportedAtom,
  captureSurfacesAtom,
} from "@/app/lib/capture/captureFlow";
import {
  acceleratorKeys,
  isMacPlatform,
  recorderKey,
  UNSUPPORTED_SHORTCUT_KEY,
} from "@/app/lib/capture/shortcutLabel";
import ShortcutKeys from "@/app/components/capture/ShortcutKeys";
import {
  addCaptureDesktopShortcut,
  configureCaptureShortcut,
  getCaptureDestination,
  getCaptureShortcut,
  setCaptureShortcut,
  type CaptureShortcutSetting,
} from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { isLinuxPlatform } from "@/app/lib/utils/isMacPlatform";

const ROW =
  "flex flex-wrap items-center justify-between gap-4 rounded-[8px] border border-grey-dark-100 bg-white px-4 py-3 dark:border-black-300 dark:bg-black-600";
const KBD =
  "rounded-[6px] border border-grey-dark-100 bg-grey-light-200 px-2 py-1 font-geist text-[13px] font-medium text-grey-10 dark:border-black-300 dark:bg-black-500 dark:text-white";

/**
 * Screen capture settings: the system-wide shortcut that opens the capture
 * bar, and the drive captures are saved to. Rust validates and registers the
 * shortcut (`capture::shortcut`); this only records the keys and shows what
 * Rust answered. Hidden where capture is not available. On a Mac whose build
 * or macOS cannot record, a third row says so in Rust's words. The shortcut
 * row follows Rust's `shortcut.via`: the key recorder where Hippius grabs the
 * keys (`plugin`); the desktop's own description and dialog where Wayland's
 * shortcut portal binds it (`portal`); and where neither can, Rust's line
 * with the command to bind in the desktop's keyboard settings, which Hippius
 * adds itself on GNOME (`desktopSettings`). Where the desktop's own tool
 * takes screenshots (Wayland), a row says so.
 */
export default function CaptureSettings() {
  const supported = useAtomValue(captureSupportedAtom);
  const recordingNote = useAtomValue(captureRecordingNoteAtom);
  const surfaces = useAtomValue(captureSurfacesAtom);
  // Rust's line where Hippius cannot set the shortcut itself (Wayland without
  // the shortcut portal): it replaces the key recorder, which would save a
  // shortcut that never fires.
  const shortcutUnavailable = surfaces && !surfaces.shortcut.supported ? surfaces.shortcut.unavailableMessage : null;
  const desktopCommand = surfaces && !surfaces.shortcut.supported ? (surfaces.shortcut.command ?? null) : null;
  const viaPortal = !!surfaces && surfaces.shortcut.supported && surfaces.shortcut.via === "portal";
  const setDialog = useSetAtom(captureDialogAtom);
  const [setting, setSetting] = useState<CaptureShortcutSetting | null>(null);
  const [recording, setRecording] = useState(false);
  // The modifiers held so far while recording ("Shift+Command"), drawn live.
  const [held, setHeld] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [driveName, setDriveName] = useState<string | null>(null);
  const mac = isMacPlatform();

  const reload = useCallback(() => {
    getCaptureShortcut().then(setSetting).catch(() => setSetting(null));
    getCaptureDestination()
      .then((d) => setDriveName(d?.displayName ?? null))
      .catch(() => setDriveName(null));
  }, []);

  useEffect(() => {
    if (SCREEN_CAPTURE_ENABLED && supported) reload();
  }, [supported, reload]);

  const save = useCallback(
    async (accelerator: string | null) => {
      setError(null);
      try {
        await setCaptureShortcut(accelerator);
        reload();
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [reload],
  );

  // While recording, the next key press with a modifier becomes the shortcut.
  // The modifiers show as they are pressed and released, and a key that
  // cannot be a shortcut says so instead of leaving "Waiting…" up.
  useEffect(() => {
    if (!recording) {
      setHeld("");
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const press = recorderKey(e);
      if (press.kind === "modifiers") {
        setHeld(press.accelerator);
      } else if (press.kind === "unsupported") {
        setError(UNSUPPORTED_SHORTCUT_KEY);
      } else {
        setRecording(false);
        void save(press.accelerator);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const press = recorderKey(e);
      if (press.kind === "modifiers") setHeld(press.accelerator);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [recording, save]);

  // The portal binds in the background and the desktop may ask first: ask
  // Rust again until the desktop has answered (a trigger or a problem).
  const awaitingDesktop = viaPortal && !!setting?.accelerator && !setting.desktopTrigger && !setting.problem;
  useEffect(() => {
    if (!awaitingDesktop) return;
    const timer = window.setInterval(reload, 2000);
    const stop = window.setTimeout(() => window.clearInterval(timer), 60_000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [awaitingDesktop, reload]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setError(null);
      try {
        await action();
        reload();
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [reload],
  );

  if (!SCREEN_CAPTURE_ENABLED || !supported) return null;

  const current = setting?.accelerator ? acceleratorKeys(setting.accelerator, mac) : null;
  // The saved shortcut did not register when the app started (Rust's words,
  // naming another copy of Hippius when that is what holds it). A refusal
  // from a change just made takes its place.
  const problem = recording ? null : (setting?.problem ?? null);
  const isDefault = setting ? setting.accelerator === setting.defaultAccelerator : true;

  return (
    <div className="flex flex-col gap-3">
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

      {shortcutUnavailable ? (
        <div className={ROW}>
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <Keyboard className="mt-0.5 size-[18px] flex-shrink-0 text-grey-50 dark:text-grey-dark-600" strokeWidth={2} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-grey-10 dark:text-white">Capture shortcut</p>
              <p className="mt-1 text-sm text-[#7D7D7D] dark:text-grey-dark-600">{shortcutUnavailable}</p>
              {desktopCommand && (
                <code
                  data-testid="capture-shortcut-command"
                  className={`${KBD} mt-2 block select-all break-all font-mono text-[12px]`}
                >
                  {desktopCommand}
                </code>
              )}
              {setting?.addedToDesktop && (
                <p className="mt-2 text-sm text-[#7D7D7D] dark:text-grey-dark-600">
                  Added to your desktop&apos;s keyboard shortcuts. Change the keys there.
                </p>
              )}
              {error && (
                <p role="alert" className="mt-1 text-sm text-error-50">
                  {error}
                </p>
              )}
            </div>
          </div>
          {desktopCommand && (
            <div className="flex flex-wrap items-center gap-2">
              {setting?.addedToDesktop === false && (
                <Button variant="defaultStable" size="sm" onClick={() => void run(addCaptureDesktopShortcut)}>
                  Add for me
                </Button>
              )}
              <Button
                variant="defaultStable"
                size="sm"
                onClick={() => void navigator.clipboard?.writeText(desktopCommand).catch(() => undefined)}
              >
                Copy command
              </Button>
            </div>
          )}
        </div>
      ) : viaPortal ? (
        <div className={ROW}>
          <div className="flex min-w-0 items-start gap-3">
            <Keyboard className="mt-0.5 size-[18px] flex-shrink-0 text-primary-50 dark:text-primary-brand-dark" strokeWidth={2} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-grey-10 dark:text-white">Capture shortcut</p>
              <p className="mt-1 text-sm text-[#7D7D7D] dark:text-grey-dark-600">
                Opens the capture bar from any app. Your desktop keeps this shortcut and may ask you to confirm it.
              </p>
              {(error ?? setting?.problem) && (
                <p role="alert" className="mt-1 text-sm text-error-50">
                  {error ?? setting?.problem}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!setting ? (
              <span aria-hidden className="h-7 w-24 animate-pulse rounded-[6px] bg-grey-light-200 motion-reduce:animate-none dark:bg-black-500" />
            ) : !setting.accelerator ? (
              <span className="text-sm text-grey-50 dark:text-grey-dark-600">Off</span>
            ) : setting.desktopTrigger ? (
              <span className={KBD}>{setting.desktopTrigger}</span>
            ) : awaitingDesktop ? (
              <span
                role="status"
                aria-label="Waiting for your desktop"
                className="h-7 w-24 animate-pulse rounded-[6px] bg-grey-light-200 motion-reduce:animate-none dark:bg-black-500"
              />
            ) : null}
            {setting?.accelerator && setting.canChangeInDesktop && (
              <Button variant="defaultStable" size="sm" onClick={() => void run(configureCaptureShortcut)}>
                Change
              </Button>
            )}
            {setting && (
              <Button
                variant="defaultStable"
                size="sm"
                onClick={() => void save(setting.accelerator ? null : setting.defaultAccelerator)}
              >
                {setting.accelerator ? "Turn off" : "Turn on"}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className={ROW}>
          <div className="flex min-w-0 items-start gap-3">
            <Keyboard className="mt-0.5 size-[18px] flex-shrink-0 text-primary-50 dark:text-primary-brand-dark" strokeWidth={2} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-grey-10 dark:text-white">Capture shortcut</p>
              <p className="mt-1 text-sm text-[#7D7D7D] dark:text-grey-dark-600">
                {recording
                  ? mac
                    ? "Press the new shortcut, with Command, Control or Option. Esc cancels."
                    : isLinuxPlatform()
                      ? "Press the new shortcut, with Ctrl, Alt or Super. Esc cancels."
                      : "Press the new shortcut, with Ctrl, Alt or the Windows key. Esc cancels."
                  : "Opens the capture bar from any app, to take a screenshot or start a recording."}
              </p>
              {(error ?? problem) && (
                <p role="alert" className="mt-1 text-sm text-error-50">
                  {error ?? problem}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {recording && held ? (
              <span aria-live="polite">
                <ShortcutKeys keys={acceleratorKeys(held, mac)} size="md" />
              </span>
            ) : recording ? (
              <span aria-live="polite" className={`${KBD} animate-pulse motion-reduce:animate-none`}>
                Waiting…
              </span>
            ) : current ? (
              <ShortcutKeys keys={current} size="md" />
            ) : (
              <span className="text-sm text-grey-50 dark:text-grey-dark-600">Off</span>
            )}
            <Button
              variant="defaultStable"
              size="sm"
              onClick={() => {
                setError(null);
                setRecording((r) => !r);
              }}
            >
              {recording ? "Cancel" : "Change"}
            </Button>
            {!recording && !isDefault && (
              <Button variant="defaultStable" size="sm" onClick={() => void save(setting?.defaultAccelerator ?? null)}>
                Reset
              </Button>
            )}
            {!recording && current && (
              <Button variant="defaultStable" size="sm" onClick={() => void save(null)}>
                Turn off
              </Button>
            )}
          </div>
        </div>
      )}

      <div className={ROW}>
        <div className="flex min-w-0 items-start gap-3">
          <Camera className="mt-0.5 size-[18px] flex-shrink-0 text-primary-50 dark:text-primary-brand-dark" strokeWidth={2} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-grey-10 dark:text-white">Capture drive</p>
            <p className="mt-1 text-sm text-[#7D7D7D] dark:text-grey-dark-600">
              {driveName
                ? `Screenshots and recordings are saved to ${driveName} › Captures, and a share link is copied.`
                : "Choose the drive screenshots and recordings are saved to."}
            </p>
          </div>
        </div>
        <Button
          variant="defaultStable"
          size="sm"
          onClick={() => setDialog({ kind: "destination", resume: null })}
        >
          {driveName ? "Change" : "Choose"}
        </Button>
      </div>

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
    </div>
  );
}
