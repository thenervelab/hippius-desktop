import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Account / credits summary for the tray popover header + footer.
 * Mirrors the Rust `TrayMenuData` returned by `get_tray_menu_data`.
 */
export interface TrayMenuData {
  loggedIn: boolean;
  credits: number | null;
  substrateAddress: string | null;
}

/**
 * One pre-normalized upload/activity row, as produced by the Rust
 * `get_sync_activity_rows` command (dedup/sort/status-mapping already done).
 * `fileName` is the shortened display name; `rawName` is the full name.
 */
export interface SyncActivityRow {
  id: string;
  file_name: string;
  raw_name: string;
  status: string;
  size: number;
  timestamp: number | null;
  deleted: boolean;
}

/** Max activity rows to request for the popover list. */
const ACTIVITY_LIMIT = 40;

/** Background refresh cadence while the popover window stays mounted. */
const REFRESH_INTERVAL_MS = 5000;

/**
 * Data feed for the tray popover.
 *
 * All values are computed in Rust — this hook only fetches and keeps them
 * fresh. It refetches on mount, on a light interval (the window is created
 * once and reused, so it stays mounted while hidden), and whenever the popover
 * regains focus (i.e. each time it is re-shown), so a freshly opened panel
 * always reflects current credits and uploads.
 */
export function useTrayPanelData() {
  const [menu, setMenu] = useState<TrayMenuData | null>(null);
  const [activity, setActivity] = useState<SyncActivityRow[]>([]);
  // Latest finalized block + chain connectivity, mirrored from the Rust block
  // subscription's `block_number_updated` broadcast (the same feed the main
  // window's ProfileCard reads). `null` until the first block arrives.
  const [blockNumber, setBlockNumber] = useState<number | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  // Unread notification count for the header bell badge — same DB-backed value
  // the main window's top-bar bell shows (`get_unread_count`).
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [menuData, rows] = await Promise.all([
        invoke<TrayMenuData>("get_tray_menu_data"),
        invoke<SyncActivityRow[]>("get_sync_activity_rows", { limit: ACTIVITY_LIMIT }),
      ]);
      setMenu(menuData);
      setActivity(rows);

      // Unread count is keyed by the active account address.
      if (menuData.substrateAddress) {
        try {
          const count = await invoke<number>("get_unread_count", { userAddress: menuData.substrateAddress });
          setUnreadCount(count);
        } catch (error) {
          console.error("[TrayPanel] Failed to load unread count:", error);
        }
      } else {
        setUnreadCount(0);
      }
    } catch (error) {
      console.error("[TrayPanel] Failed to load data:", error);
    }
  }, []);

  useEffect(() => {
    void refresh();

    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);

    // Re-fetch each time the popover is shown (it regains focus on show).
    let unlistenFocus: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) void refresh();
      })
      .then((un) => {
        unlistenFocus = un;
      })
      .catch((error) => console.error("[TrayPanel] focus listener failed:", error));

    // Mirror the chain block + connectivity broadcast (app.emit reaches every
    // window, so this works even though the subscription runs for the main one).
    let unlistenBlock: (() => void) | undefined;
    void listen<{ blockNumber: number; isConnected: boolean }>("block_number_updated", (event) => {
      setBlockNumber(event.payload.blockNumber);
      setIsConnected(event.payload.isConnected);
    })
      .then((un) => {
        unlistenBlock = un;
      })
      .catch((error) => console.error("[TrayPanel] block listener failed:", error));

    return () => {
      window.clearInterval(interval);
      unlistenFocus?.();
      unlistenBlock?.();
    };
  }, [refresh]);

  return { menu, activity, blockNumber, isConnected, unreadCount, refresh };
}
