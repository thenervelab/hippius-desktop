import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  type SyncSnapshot,
  EMPTY_SNAPSHOT,
} from "@/app/lib/types/syncSnapshot";
import {
  mergeUploadFeed,
  type UploadFeedItem,
} from "@/app/lib/upload-feed/mergeUploadFeed";

/**
 * Account / credits summary for the tray popover header + footer.
 * Mirrors the Rust `TrayMenuData` returned by `get_tray_menu_data`.
 */
export interface TrayMenuData {
  loggedIn: boolean;
  credits: number | null;
  substrateAddress: string | null;
}

/** Max upload-feed rows the popover shows. */
const FEED_LIMIT = 20;

/** Background refresh cadence for the server-backed slices (credits, recent
 *  uploads, unread). Live upload progress is event-driven, not polled. */
const REFRESH_INTERVAL_MS = 5000;

/**
 * Data feed for the tray popover.
 *
 * The popover webview mounts no app providers (see `AppShell`), so it cannot
 * use react-query or Jotai — it talks to the backend only through raw `invoke`
 * / `listen`. It assembles the SAME upload feed the main window's Recent Files
 * section shows: the account-wide "last uploads" (`get_recent_uploads`)
 * overlaid with this device's live sync progress (`sp_get_snapshot` +
 * `sync_progress_snapshot` events), joined by the pure `mergeUploadFeed`.
 *
 * Server slices refresh on mount, on a light interval, and whenever the
 * popover regains focus (each re-show). The live snapshot updates from its
 * event stream, so uploading rows animate without polling.
 */
export function useTrayPanelData() {
  const [menu, setMenu] = useState<TrayMenuData | null>(null);
  const [recentUploads, setRecentUploads] = useState<FormattedUserFile[]>([]);
  const [snapshot, setSnapshot] = useState<SyncSnapshot>(EMPTY_SNAPSHOT);
  // Latest finalized block + chain connectivity, mirrored from the Rust block
  // subscription's `block_number_updated` broadcast (the same feed the main
  // window's ProfileCard reads). `null` until the first block arrives.
  const [blockNumber, setBlockNumber] = useState<number | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  // Unread notification count for the header bell badge — same DB-backed value
  // the main window's top-bar bell shows (`get_unread_count`).
  const [unreadCount, setUnreadCount] = useState(0);
  // Tracks the snapshot's last completion state so we refresh the server list
  // only on the rising edge (session finishes), not on every snapshot tick.
  const prevCompletedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const menuData = await invoke<TrayMenuData>("get_tray_menu_data");
      setMenu(menuData);

      const address = menuData.substrateAddress;
      if (address) {
        // Recent uploads + unread are keyed by the active account address.
        const [uploads, count] = await Promise.all([
          invoke<FormattedUserFile[]>("get_recent_uploads", {
            accountId: address,
            limit: FEED_LIMIT,
          }).catch((error) => {
            console.error("[TrayPanel] Failed to load recent uploads:", error);
            return [] as FormattedUserFile[];
          }),
          invoke<number>("get_unread_count", { userAddress: address }).catch(
            (error) => {
              console.error("[TrayPanel] Failed to load unread count:", error);
              return 0;
            },
          ),
        ]);
        setRecentUploads(uploads);
        setUnreadCount(count);
      } else {
        setRecentUploads([]);
        setUnreadCount(0);
      }
    } catch (error) {
      console.error("[TrayPanel] Failed to load data:", error);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Seed the live snapshot once; subsequent updates arrive via the event.
    void invoke<SyncSnapshot>("sp_get_snapshot")
      .then(setSnapshot)
      .catch((error) =>
        console.error("[TrayPanel] Failed to seed snapshot:", error),
      );

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

    // Live sync progress (uploading / failed). Events reach every window.
    // The `sync_files_completed_changed` DOM event the main window uses to
    // refresh the server list is window-local (dispatched by `useSyncEvents`,
    // which the provider-less popover never mounts), so we can't rely on it
    // here. Instead, refresh the server-backed recent uploads on the rising
    // edge of the snapshot's completion — when a session finishes, pull the
    // authoritative completed rows. Until then the live overlay keeps the
    // just-finished file visible, and the 5s interval is the backstop.
    let unlistenSnapshot: (() => void) | undefined;
    void listen<SyncSnapshot>("sync_progress_snapshot", (event) => {
      const completed = event.payload.effectiveCompleted;
      if (completed && !prevCompletedRef.current) {
        void refresh();
      }
      prevCompletedRef.current = completed;
      setSnapshot(event.payload);
    })
      .then((un) => {
        unlistenSnapshot = un;
      })
      .catch((error) => console.error("[TrayPanel] snapshot listener failed:", error));

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
      unlistenSnapshot?.();
      unlistenBlock?.();
    };
  }, [refresh]);

  const feed: UploadFeedItem[] = useMemo(
    () =>
      mergeUploadFeed({
        recentUploads,
        snapshotFiles: snapshot.files,
        limit: FEED_LIMIT,
      }),
    [recentUploads, snapshot.files],
  );

  return { menu, feed, snapshot, blockNumber, isConnected, unreadCount, refresh };
}
