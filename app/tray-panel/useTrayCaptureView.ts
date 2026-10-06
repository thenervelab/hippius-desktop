import { useEffect, useState } from "react";
import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";
import {
  getCaptureShortcut,
  getCaptureSupport,
  type CaptureSupport,
} from "@/app/lib/tauri/capture";
import { acceleratorKeys, isMacPlatform } from "@/app/lib/capture/shortcutLabel";
import { trayCaptureView, type TrayCaptureView } from "./trayCaptureView";

/**
 * What the popover offers for capture (`trayCaptureView`, from Rust's
 * `capture_support`) and the screenshot shortcut's keys, read the way the
 * Drive page's capture buttons read them. The tiles and the tabs both
 * follow it: where capture is off, there is neither a Screenshot tile nor a
 * Captures tab.
 */
export function useTrayCaptureView(): { view: TrayCaptureView; shortcut: string[] } {
  // undefined = asking Rust, null = it could not say.
  const [support, setSupport] = useState<CaptureSupport | null | undefined>(
    SCREEN_CAPTURE_ENABLED ? undefined : null,
  );
  const [shortcut, setShortcut] = useState<string[]>([]);

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
  // send people pressing the wrong ones.
  const shortcutWorks = Boolean(support?.supported && support.shortcut?.supported && support.shortcut.via === "plugin");
  useEffect(() => {
    if (!shortcutWorks) {
      setShortcut([]);
      return;
    }
    let live = true;
    // Asked again whenever the popover gets focus: it is prewarmed and
    // reused, and the shortcut can be changed in Settings meanwhile.
    const ask = () => {
      getCaptureShortcut()
        .then((s) => live && setShortcut(s.accelerator ? acceleratorKeys(s.accelerator, isMacPlatform()) : []))
        .catch(() => live && setShortcut([]));
    };
    ask();
    window.addEventListener("focus", ask);
    return () => {
      live = false;
      window.removeEventListener("focus", ask);
    };
  }, [shortcutWorks]);

  return {
    view: trayCaptureView(SCREEN_CAPTURE_ENABLED, support, isMacPlatform()),
    shortcut,
  };
}
