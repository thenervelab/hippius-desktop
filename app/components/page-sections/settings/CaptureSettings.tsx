"use client";

import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Camera, Keyboard } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";
import { captureDialogAtom, captureSupportedAtom } from "@/app/lib/capture/captureFlow";
import {
  acceleratorKeys,
  isMacPlatform,
  recorderKey,
  UNSUPPORTED_SHORTCUT_KEY,
} from "@/app/lib/capture/shortcutLabel";
import ShortcutKeys from "@/app/components/capture/ShortcutKeys";
import {
  getCaptureDestination,
  getCaptureShortcut,
  setCaptureShortcut,
  type CaptureShortcutSetting,
} from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";

const ROW =
  "flex flex-wrap items-center justify-between gap-4 rounded-[8px] border border-grey-dark-100 bg-white px-4 py-3 dark:border-black-300 dark:bg-black-600";
const KBD =
  "rounded-[6px] border border-grey-dark-100 bg-grey-light-200 px-2 py-1 font-geist text-[13px] font-medium text-grey-10 dark:border-black-300 dark:bg-black-500 dark:text-white";

/**
 * Screen capture settings: the system-wide shortcut that opens the capture
 * bar, and the drive captures are saved to. Rust validates and registers the
 * shortcut (`capture::shortcut`); this only records the keys and shows what
 * Rust answered. Hidden where capture is not available.
 */
export default function CaptureSettings() {
  const supported = useAtomValue(captureSupportedAtom);
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

  if (!SCREEN_CAPTURE_ENABLED || !supported) return null;

  const current = setting?.accelerator ? acceleratorKeys(setting.accelerator, mac) : null;
  // The saved shortcut did not register when the app started (Rust's words,
  // naming another copy of Hippius when that is what holds it). A refusal
  // from a change just made takes its place.
  const problem = recording ? null : (setting?.problem ?? null);
  const isDefault = setting ? setting.accelerator === setting.defaultAccelerator : true;

  return (
    <div className="flex flex-col gap-3">
      <div className={ROW}>
        <div className="flex min-w-0 items-start gap-3">
          <Keyboard className="mt-0.5 size-[18px] flex-shrink-0 text-primary-50 dark:text-primary-brand-dark" strokeWidth={2} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-grey-10 dark:text-white">Capture shortcut</p>
            <p className="mt-1 text-sm text-[#7D7D7D] dark:text-grey-dark-600">
              {recording
                ? "Press the new shortcut, with Command, Control or Option. Esc cancels."
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
    </div>
  );
}
