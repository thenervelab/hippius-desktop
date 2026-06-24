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
import { useRetainedCompletedUploads } from "@/app/lib/upload-feed/useRetainedCompletedUploads";

/**
 * Account / credits summary for the tray popover header + footer.
 * Mirrors the Rust `TrayMenuData` returned by `get_tray_menu_data`.
 */
export interface TrayMenuData {
  loggedIn: boolean;
  credits: number | null;
  substrateAddress: string | null;
  /** Whether the in-memory backend session is hydrated for `substrateAddress`.
   *  `loggedIn` flips true from the persisted session row at boot, but the
   *  account-scoped IPC calls below authorize against in-memory auth state that
   *  only `restore_session` populates. Gating on this flag (not just an address)
   *  keeps the prewarmed popover from polling them during that boot gap. */
  sessionReady: boolean;
}

/** Max upload-feed rows the popover shows. */
const FEED_LIMIT = 20;

/** Background refresh cadence for the server-backed slices (credits, recent
 *  uploads, unread). Live upload progress is event-driven, not polled. */
const REFRESH_INTERVAL_MS = 5000;

/** How many consecutive logged-in-but-not-`sessionReady` refreshes to keep the
 *  boot-gap skeleton before giving up and showing the empty state. One grace
 *  poll covers the normal restore_session hydration gap; beyond that the
 *  session is effectively stuck (e.g. a slow/blocked keychain restore) and an
 *  infinite skeleton is worse than an empty state (F-3). */
const MAX_NOT_READY_POLLS = 2;

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
  // First-load gate for the upload list. True until the first authoritative
  // fetch (one that ran with a hydrated session) resolves, so the popover shows
  // a loading skeleton instead of the empty state before any data has arrived.
  // The window is prewarmed/reused, so a boot-gap fetch (no session yet) keeps
  // this true and the skeleton shows on the first open instead of "no uploads".
  const [loading, setLoading] = useState(true);
  // Tracks the snapshot's last completion state so we refresh the server list
  // only on the rising edge (session finishes), not on every snapshot tick.
  const prevCompletedRef = useRef(false);
  // Whether the popover is currently on-screen. The window is prewarmed hidden
  // at boot and reused across opens, so this hook lives for the whole app
  // session; without this guard the interval below would poll `get_tray_menu_data`
  // — which makes a billing API call — every few seconds for a window nobody is
  // looking at. The popover hides on blur (`on_panel_blur`), so focus tracks
  // visibility 1:1.
  const isShownRef = useRef(false);
  // Consecutive refreshes that ran logged-in but without a hydrated session.
  // Caps the boot-gap skeleton so a stuck session can't hang it forever (F-3).
  const notReadyPollsRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const menuData = await invoke<TrayMenuData>("get_tray_menu_data");
      setMenu(menuData);

      const address = menuData.substrateAddress;
      // Only the in-memory session can authorize the account-scoped calls below.
      // At boot the persisted session reports an address before `restore_session`
      // hydrates that in-memory state; firing during the gap rejects with
      // `AppError::Auth`. `sessionReady` is the backend's "those calls will
      // authorize now" signal, so we defer until it flips true (the next poll).
      if (address && menuData.sessionReady) {
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
        // We now have authoritative data for this session — drop the skeleton.
        // Deferred until the session-ready branch so the boot gap (address known
        // but session not yet hydrated) keeps showing the skeleton, not "empty".
        notReadyPollsRef.current = 0;
        setLoading(false);
      } else {
        setRecentUploads([]);
        setUnreadCount(0);
        // Session not hydrated yet. Keep the skeleton for the boot-gap grace
        // poll, but once a logged-in user has waited past that, stop withholding
        // the resolved state so the popover shows the empty state rather than an
        // infinite skeleton (the never-flips-`sessionReady` hang, F-3).
        if (menuData.loggedIn) {
          notReadyPollsRef.current += 1;
          if (notReadyPollsRef.current >= MAX_NOT_READY_POLLS) {
            setLoading(false);
          }
        } else {
          // Logged out: nothing to load, so never hold the skeleton. The popover
          // is gated to signed-in today, but keep the state self-consistent.
          setLoading(false);
        }
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

    // Only poll while the popover is actually shown. The seed `refresh()` above
    // and the on-show refresh below keep it fresh; this interval just keeps a
    // *visible* popover live. Polling a hidden window would hit the billing API
    // (`get_tray_menu_data`) every tick for the app's whole lifetime.
    const interval = window.setInterval(() => {
      if (isShownRef.current) void refresh();
    }, REFRESH_INTERVAL_MS);

    // Re-fetch each time the popover is shown (it regains focus on show); track
    // shown/hidden so the interval above stays idle while it's dismissed.
    let unlistenFocus: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        isShownRef.current = focused;
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

  const retainedCompleted = useRetainedCompletedUploads(
    snapshot.files,
    recentUploads,
  );

  const feed: UploadFeedItem[] = useMemo(
    () =>
      mergeUploadFeed({
        recentUploads,
        snapshotFiles: snapshot.files,
        retainedCompleted,
        limit: FEED_LIMIT,
      }),
    [recentUploads, snapshot.files, retainedCompleted],
  );

  return { menu, feed, snapshot, blockNumber, isConnected, unreadCount, loading, refresh };
}
