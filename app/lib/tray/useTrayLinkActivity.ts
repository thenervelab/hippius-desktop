import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onTauriEvent } from "@/app/lib/utils/tauriListeners";
import { LINK_ACTIVITY_CHANGED_EVENT, type RecentLinkActivity } from "@/app/lib/linkActivity/linkActivity";

/** Rust's "the popover is now visible" event (`toggle_tray_panel`). */
const TRAY_SHOWN_EVENT = "hippius:tray-panel-shown";

/** How many events the popover shows. */
export const TRAY_LINK_ACTIVITY_LIMIT = 3;

/**
 * The tray popover's last few link events (`link_activity_recent`), read
 * once the session is ready, each time the popover is shown and whenever
 * Rust saves a new one. A failed read keeps what was known.
 */
export function useTrayLinkActivity(enabled: boolean) {
  const [events, setEvents] = useState<RecentLinkActivity[]>([]);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const reload = useCallback(async () => {
    if (!enabledRef.current) return;
    try {
      const rows = await invoke<RecentLinkActivity[]>("link_activity_recent", { limit: TRAY_LINK_ACTIVITY_LIMIT });
      setEvents(Array.isArray(rows) ? rows : []);
    } catch (error) {
      console.warn("[TrayPanel] Could not read link activity:", error);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  useEffect(() => {
    const stopShown = onTauriEvent(TRAY_SHOWN_EVENT, () => void reload());
    const stopChanged = onTauriEvent(LINK_ACTIVITY_CHANGED_EVENT, () => void reload());
    return () => {
      stopShown();
      stopChanged();
    };
  }, [reload]);

  return events;
}
