"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Camera } from "lucide-react";
import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";
import { getCaptureSupport } from "@/app/lib/tauri/capture";

/**
 * Capture from the menu bar, Loom's home and the one place a capture does not
 * start with the app window in front of what you want. A labelled pill, not
 * a faint icon: it is the popover's one action that is not navigation.
 *
 * The popover asks the MAIN window to start it (`CaptureHost`), because a
 * first capture can need the drive picker or the macOS permission explainer,
 * and those are main-window dialogs. It does not reveal the main window first:
 * the capture hides it again at once, and the flash would be all the user saw.
 *
 * Its slot is held while `capture_support` is being asked, so the header's
 * other buttons do not jump sideways when it arrives.
 */
export default function TrayCaptureButton() {
  const [supported, setSupported] = useState<boolean | null>(SCREEN_CAPTURE_ENABLED ? null : false);
  useEffect(() => {
    if (!SCREEN_CAPTURE_ENABLED) return;
    getCaptureSupport()
      .then((s) => setSupported(s.supported))
      .catch(() => setSupported(false));
  }, []);
  if (supported === false) return null;
  const pending = supported === null;
  return (
    <button
      type="button"
      onClick={() => void captureFromTray()}
      disabled={pending}
      aria-hidden={pending || undefined}
      tabIndex={pending ? -1 : undefined}
      title="Take a screenshot or start a recording (opens the capture bar)"
      className={`relative flex h-9 items-center gap-1.5 rounded-lg px-2.5 font-geist text-[13px] font-medium text-black transition-colors hover:bg-black/5 dark:text-white dark:hover:bg-white/10 ${
        pending ? "invisible" : ""
      }`}
    >
      <Camera className="size-[15px] shrink-0 opacity-70" aria-hidden />
      Capture
    </button>
  );
}

async function captureFromTray() {
  try {
    await invoke("hide_tray_panel");
    // No mode: the capture bar opens on whatever was used last.
    await emit("hippius:tray-capture", {});
  } catch (error) {
    console.error("[TrayPanel] Failed to start a capture:", error);
  }
}

