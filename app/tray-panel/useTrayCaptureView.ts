import { useEffect, useState } from "react";
import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";
import {
  getCaptureShortcut,
  getCaptureSupport,
  type CaptureShortcutKind,
  type CaptureSupport,
} from "@/app/lib/tauri/capture";
import { acceleratorKeys, isMacPlatform } from "@/app/lib/capture/shortcutLabel";
import { trayCaptureView, type TrayCaptureView } from "./trayCaptureView";

/** Each capture tile's shortcut keys; empty where there are none to show. */
export interface TrayShortcuts {
  screenshot: string[];
  record: string[];
}

const NO_KEYS: TrayShortcuts = { screenshot: [], record: [] };

/**
 * What the popover offers for capture (`trayCaptureView`, from Rust's
 * `capture_support`) and the screenshot and Record shortcuts' keys, read the
 * way the Drive page's capture buttons read them. The tiles and the tabs
 * both follow it: where capture is off, there is neither a Screenshot tile
 * nor a Captures tab.
 */
export function useTrayCaptureView(): { view: TrayCaptureView; shortcut: TrayShortcuts } {
  // undefined = asking Rust, null = it could not say.
  const [support, setSupport] = useState<CaptureSupport | null | undefined>(
    SCREEN_CAPTURE_ENABLED ? undefined : null,
  );
  const [shortcut, setShortcut] = useState<TrayShortcuts>(NO_KEYS);

  useEffect(() => {
    if (!SCREEN_CAPTURE_ENABLED) return;
    let live = true;
    getCaptureSupport()
      .then((s) => live && setSupport(s))
      .catch(() => live && setSupport(null));
    return () => {
      live = false;
    };
  }, []);

  // Keys only where Hippius itself holds the shortcut (`plugin`): where the
  // desktop binds it, it may have chosen other keys, and showing ours would
  // send people pressing the wrong ones. Record's only where it records.
  const screenshotWorks = Boolean(
    support?.supported && support.shortcut?.supported && support.shortcut.via === "plugin",
  );
  const recordWorks = Boolean(
    support?.supported &&
      support.recording &&
      support.recordShortcut?.supported &&
      support.recordShortcut.via === "plugin",
  );
  useEffect(() => {
    if (!screenshotWorks && !recordWorks) {
      setShortcut(NO_KEYS);
      return;
    }
    let live = true;
    const keysOf = (kind: CaptureShortcutKind, works: boolean): Promise<string[]> =>
      works
        ? getCaptureShortcut(kind)
            .then((s) => (s.accelerator ? acceleratorKeys(s.accelerator, isMacPlatform()) : []))
            .catch(() => [])
        : Promise.resolve([]);
    // Asked again whenever the popover gets focus: it is prewarmed and
    // reused, and the shortcuts can be changed in Settings meanwhile.
    const ask = () => {
      void Promise.all([keysOf("screenshot", screenshotWorks), keysOf("record", recordWorks)]).then(
        ([screenshot, record]) => live && setShortcut({ screenshot, record }),
      );
    };
    ask();
    window.addEventListener("focus", ask);
    return () => {
      live = false;
      window.removeEventListener("focus", ask);
    };
  }, [screenshotWorks, recordWorks]);

  return {
    view: trayCaptureView(SCREEN_CAPTURE_ENABLED, support, isMacPlatform()),
    shortcut,
  };
}
