"use client";

import { useEffect } from "react";
import useNavigationLoader from "@/app/lib/hooks/useNavigationLoader";
import { trayMenuShortcutFor, trayPageRoute } from "@/app/lib/tray/trayHeaderMenu";
import { isMacPlatform } from "@/app/lib/utils/isMacPlatform";

/**
 * ⌘, (Ctrl+, on Windows and Linux) opens Settings from the main window, as
 * it does from the tray popover's ⋮ menu. Same key rule as the popover
 * (`trayMenuShortcutFor`: the command key alone, so ⇧⌘, stays free) and the
 * same route, so the two cannot drift. Mounted once, in `FullAppShell`.
 */
export default function SettingsShortcut() {
  const { push } = useNavigationLoader();

  useEffect(() => {
    const mac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (trayMenuShortcutFor(event, mac) !== "settings") return;
      const route = trayPageRoute("settings");
      if (!route) return;
      event.preventDefault();
      push(route);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [push]);

  return null;
}
