"use client";

import { useCallback, useEffect, useState } from "react";
import { Keyboard } from "lucide-react";

import { Button } from "@/components/ui/button";
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
  getCaptureShortcut,
  setCaptureShortcut,
  type CaptureShortcutKind,
  type CaptureShortcutSetting,
  type CaptureShortcutSupport,
} from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { isLinuxPlatform } from "@/app/lib/utils/isMacPlatform";

const KBD =
  "rounded-[6px] border border-grey-dark-100 bg-grey-light-200 px-2 py-1 font-geist text-[13px] font-medium text-grey-10 dark:border-black-300 dark:bg-black-500 dark:text-white";

/** Each shortcut's card: its name and what it does, in the user's words. */
const COPY: Record<CaptureShortcutKind, { title: string; does: string; portal: string; commandTestId: string }> = {
  screenshot: {
    title: "Screenshot shortcut",
    does: "From any app: drag over an area to screenshot it and copy its link. Press it during a recording to stop.",
    portal:
      "Takes a screenshot from any app and copies its link. Your desktop keeps this shortcut and may ask you to confirm it.",
    commandTestId: "capture-shortcut-command",
  },
  record: {
    title: "Recording shortcut",
    does: "From any app: open the capture bar ready to record. Press it again during a recording to stop.",
    portal: "",
    commandTestId: "record-shortcut-command",
  },
};

export const SHORTCUT_TITLE: Record<CaptureShortcutKind, string> = {
  screenshot: COPY.screenshot.title,
  record: COPY.record.title,
};

/**
 * One system-wide shortcut's card: the screenshot one or the Record one.
 * Rust validates, registers and stores each (`capture::shortcut`), refuses
 * one shortcut the other's keys, and says why in its own words; this only
 * records the keys and shows what Rust answered.
 *
 * The card follows Rust's route for that shortcut (`support.via`): the key
 * recorder where Hippius grabs the keys (`plugin`); the desktop's own
 * description and dialog where Wayland's shortcut portal binds it
 * (`portal`, the screenshot shortcut only); and where neither can, Rust's
 * line with the command to bind in the desktop's keyboard settings, which
 * Hippius adds itself on GNOME for the screenshot one (`desktopSettings`).
 */
export default function CaptureShortcutSetting({
  kind,
  support,
  rowClassName,
}: {
  kind: CaptureShortcutKind;
  /** Rust's route for this shortcut here; null until Rust has answered (the key recorder). */
  support: CaptureShortcutSupport | null;
  rowClassName: string;
}) {
  const copy = COPY[kind];
  // Rust's line where Hippius cannot set the shortcut itself (Wayland
  // without the shortcut portal, and the Record shortcut on any Wayland
  // desktop): it replaces the key recorder, which would save a shortcut
  // that never fires.
  const unavailable = support && !support.supported ? support.unavailableMessage : null;
  const desktopCommand = support && !support.supported ? (support.command ?? null) : null;
  const viaPortal = !!support && support.supported && support.via === "portal";
  const [setting, setSetting] = useState<CaptureShortcutSetting | null>(null);
  const [recording, setRecording] = useState(false);
  // The modifiers held so far while recording ("Shift+Command"), drawn live.
  const [held, setHeld] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mac = isMacPlatform();

  const reload = useCallback(() => {
    getCaptureShortcut(kind)
      .then(setSetting)
      .catch(() => setSetting(null));
  }, [kind]);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = useCallback(
    async (accelerator: string | null) => {
      setError(null);
      try {
        await setCaptureShortcut(accelerator, kind);
        reload();
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [kind, reload],
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

  if (unavailable) {
    return (
      <div role="group" aria-label={copy.title} className={rowClassName}>
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Keyboard className="mt-0.5 size-[18px] flex-shrink-0 text-grey-50 dark:text-grey-dark-600" strokeWidth={2} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-grey-10 dark:text-white">{copy.title}</p>
            <p className="mt-1 text-sm text-[#7D7D7D] dark:text-grey-dark-600">{unavailable}</p>
            {desktopCommand && (
              <code
                data-testid={copy.commandTestId}
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
    );
  }

  if (viaPortal) {
    return (
      <div role="group" aria-label={copy.title} className={rowClassName}>
        <div className="flex min-w-0 items-start gap-3">
          <Keyboard className="mt-0.5 size-[18px] flex-shrink-0 text-primary-50 dark:text-primary-brand-dark" strokeWidth={2} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-grey-10 dark:text-white">{copy.title}</p>
            <p className="mt-1 text-sm text-[#7D7D7D] dark:text-grey-dark-600">{copy.portal || copy.does}</p>
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
    );
  }

  const current = setting?.accelerator ? acceleratorKeys(setting.accelerator, mac) : null;
  // The saved shortcut did not register when the app started (Rust's words,
  // naming another copy of Hippius when that is what holds it). A refusal
  // from a change just made takes its place.
  const problem = recording ? null : (setting?.problem ?? null);
  const isDefault = setting ? setting.accelerator === setting.defaultAccelerator : true;

  return (
    <div role="group" aria-label={copy.title} className={rowClassName}>
      <div className="flex min-w-0 items-start gap-3">
        <Keyboard className="mt-0.5 size-[18px] flex-shrink-0 text-primary-50 dark:text-primary-brand-dark" strokeWidth={2} />
        <div className="min-w-0">
          <p className="text-sm font-medium text-grey-10 dark:text-white">{copy.title}</p>
          <p className="mt-1 text-sm text-[#7D7D7D] dark:text-grey-dark-600">
            {recording
              ? mac
                ? "Press the new shortcut, with Command, Control or Option. Esc cancels."
                : isLinuxPlatform()
                  ? "Press the new shortcut, with Ctrl, Alt or Super. Esc cancels."
                  : "Press the new shortcut, with Ctrl, Alt or the Windows key. Esc cancels."
              : copy.does}
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
  );
}
