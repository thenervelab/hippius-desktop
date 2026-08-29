import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useSetAtom, useAtom } from "jotai";
import {
  refreshUnreadCountAtom,
  enabledNotificationTypesAtom,
  refreshEnabledTypesAtom,
} from "@/components/page-sections/notifications/notificationStore";
import { useWalletAuth } from "@/lib/wallet-auth-context";

/**
 * Aggregation window for the "Sync Complete" notification. The sync
 * engine can run several cycles back-to-back for a single user action
 * (e.g. an initial scan finishes with 2 files, then a rescan picks up
 * 84 more) — this window bundles them into one notification instead
 * of producing one per cycle.
 *
 * Also acts as a coalescing window across drives: if two drives
 * complete within this interval, the counts merge into a single
 * "N files uploaded" row.
 *
 * 10 seconds is a tradeoff: long enough to catch the "initial scan
 * then rescan" pattern we're fixing, short enough that the user still
 * sees the notification promptly after clicking away.
 */
const SYNC_NOTIFICATION_AGGREGATION_MS = 10_000;

/**
 * Hard cap on the `pendingFilesRef` buffer so a pathological burst of
 * sync cycles within the debounce window can't grow it unbounded.
 * Matches the Rust-side `MAX_NOTIFICATION_FILES = 200` cap in
 * `src-tauri/src/sync/progress.rs`; the notification detail view only
 * renders a scrollable list this long anyway, and the file summary
 * counters (the "N uploaded" badges) would double-count after the cap
 * if the buffer grew past 200, which is why we truncate here rather
 * than silently drop.
 */
const MAX_PENDING_NOTIFICATION_FILES = 200;

/** Serialisable summary of a synced file stored inside releaseNotes JSON. */
export interface SyncedFileDetail {
  fileName: string;
  totalBytes: number;
  action: string;
}

interface SyncOutcome {
  label?: string;
  files_uploaded: number;
  files_downloaded: number;
  files_deleted_locally: number;
  files_deleted_remotely: number;
  /**
   * Per-file details for this cycle, populated by Rust from the
   * `sync.progress.current_session.files` HashMap in
   * `tauri_bridge::on_event::SyncCompleted`. This is the single source
   * of truth for the notification's file list — previously the FE
   * scraped `snapshotAtom`, which is truncated to `MAX_EVENT_FILES`
   * (50) entries and caused count/list mismatches for cycles with
   * more than 50 files. Always present on current Rust builds but
   * typed as optional for forward compatibility with any stray
   * consumer that may not populate it yet.
   */
  files?: SyncedFileDetail[];
}

interface SyncError {
  label?: string;
  error: string;
}

/** Payload of `hcfs_folder_recovered` — Rust's `events::LabelPayload`. */
interface FolderRecovered {
  label?: string;
}

export function useFilesNotification() {
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);
  const { polkadotAddress, oauthSession } = useWalletAuth();

  const [enabledTypes] = useAtom(enabledNotificationTypesAtom);
  const areFilesNotificationsEnabled = enabledTypes.includes("Files");

  // Accumulate counts across multi-drive completion events
  const pendingCountsRef = useRef({ uploaded: 0, downloaded: 0, deletedLocally: 0, deletedRemotely: 0 });
  const pendingFilesRef = useRef<SyncedFileDetail[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!areFilesNotificationsEnabled || !polkadotAddress) return;

    let cancelled = false;
    const unsubs: (() => void)[] = [];

    const userAddress = oauthSession?.substrateAddress || polkadotAddress;

    const flushNotification = async () => {
      if (cancelled || !userAddress) return;
      const counts = { ...pendingCountsRef.current };
      const capturedFiles = [...pendingFilesRef.current];
      pendingCountsRef.current = { uploaded: 0, downloaded: 0, deletedLocally: 0, deletedRemotely: 0 };
      pendingFilesRef.current = [];

      const total = counts.uploaded + counts.downloaded + counts.deletedLocally + counts.deletedRemotely;
      if (total === 0) return;

      // Frontend formats the description from raw counts
      const parts: string[] = [];
      if (counts.uploaded > 0) parts.push(`${counts.uploaded} file${counts.uploaded !== 1 ? "s" : ""} uploaded`);
      if (counts.downloaded > 0) parts.push(`${counts.downloaded} file${counts.downloaded !== 1 ? "s" : ""} downloaded`);
      if (counts.deletedLocally > 0) parts.push(`${counts.deletedLocally} file${counts.deletedLocally !== 1 ? "s" : ""} deleted locally`);
      if (counts.deletedRemotely > 0) parts.push(`${counts.deletedRemotely} file${counts.deletedRemotely !== 1 ? "s" : ""} deleted remotely`);
      const description = parts.join(", ") + ".";

      const fileDetailsJson = capturedFiles.length > 0
        ? JSON.stringify(capturedFiles)
        : "";

      // Single Rust call creates the notification. Outcome drives the
      // title and notification_subtype prefix — the Rust side never
      // infers it from the description.
      //
      // `fileCount` is the aggregate above, NOT `capturedFiles.length`:
      // the detail list is capped at MAX_PENDING_NOTIFICATION_FILES here
      // and again at MAX_NOTIFICATION_FILES in Rust, so counting the list
      // would title a 5,000-file sync "Synced 200 files".
      await invoke("create_sync_notification", {
        userAddress,
        description,
        fileDetailsJson,
        outcome: "success",
        fileCount: total,
      });
      await refreshUnread();
    };

    (async () => {
      try {
        const results = await Promise.all([
          listen<SyncOutcome>("hcfs_sync_completed", (e) => {
            const o = e.payload;
            const totalCompleted =
              o.files_uploaded + o.files_downloaded + o.files_deleted_locally + o.files_deleted_remotely;
            if (totalCompleted === 0) return;

            pendingCountsRef.current.uploaded += o.files_uploaded;
            pendingCountsRef.current.downloaded += o.files_downloaded;
            pendingCountsRef.current.deletedLocally += o.files_deleted_locally;
            pendingCountsRef.current.deletedRemotely += o.files_deleted_remotely;

            // File details are carried on the event payload itself,
            // populated by Rust from the session state. This is the
            // authoritative source for both count and list — previously
            // the FE scraped `snapshotAtom`, which is capped at
            // `MAX_EVENT_FILES = 50` and caused the 84-vs-48 mismatch.
            if (o.files && o.files.length > 0) {
              pendingFilesRef.current.push(...o.files);
              // Bound the buffer so a runaway burst (many cycles inside
              // the aggregation window) can't grow it past the Rust-side
              // cap. The counts in `pendingCountsRef` remain accurate
              // regardless; only the detailed list is truncated.
              if (pendingFilesRef.current.length > MAX_PENDING_NOTIFICATION_FILES) {
                pendingFilesRef.current = pendingFilesRef.current.slice(
                  0,
                  MAX_PENDING_NOTIFICATION_FILES
                );
              }
            }

            // Sliding-window debounce: reset on every event received.
            // Aggregates across multiple cycles of the same folder AND
            // across concurrent drives into a single notification.
            if (debounceTimerRef.current) {
              clearTimeout(debounceTimerRef.current);
            }
            debounceTimerRef.current = setTimeout(() => {
              debounceTimerRef.current = null;
              flushNotification();
            }, SYNC_NOTIFICATION_AGGREGATION_MS);
          }),
          listen<SyncError>("hcfs_sync_failed_notify", async (e) => {
            if (cancelled || !userAddress) return;
            const label = e.payload.label || "default";
            // Single Rust call for error notification. `outcome: "error"`
            // makes the backend pick the "Sync Failed" title and the
            // `FileSyncError-<ts>` subtype. We listen to the GATED
            // `hcfs_sync_failed_notify` event, not the raw `hcfs_sync_error`:
            // a flaky endpoint emits a sync error every retry cycle, so the
            // Rust bridge gates this channel on a per-label "genuinely down"
            // threshold (see `sync::error_notify`) and fires it once per
            // outage. Cancels and transient single-cycle blips never reach
            // here, so every event is a real, sustained failure.
            await invoke("create_sync_notification", {
              userAddress,
              description: `Sync failed for folder "${label}": ${e.payload.error}`,
              fileDetailsJson: "",
              outcome: "error",
            });
            await refreshUnread();
          }),
          listen<FolderRecovered>("hcfs_folder_restored_notify", async (e) => {
            if (cancelled || !userAddress) return;
            const label = e.payload.label || "default";
            // The engine found this folder missing on the server and put it
            // back from this device, discarding the local baseline — so the
            // whole drive re-uploads. Without this notification the user sees
            // the usual cause (deleting the folder from the web console) as
            // the folder returning by itself alongside a large unexplained
            // upload.
            //
            // We listen to the GATED `hcfs_folder_restored_notify`, not the
            // raw `hcfs_folder_recovered`: the engine re-emits the raw event
            // on every cycle whose listing still lacks the folder, and also
            // fires it for a BRAND-NEW folder whose detached registration has
            // not reached the server yet — which would tell a user who just
            // added a folder that it "was missing on the server". Rust owns
            // both gates (`sync::folder_restore_notify`), so every event that
            // reaches here is a real restore of a drive that had already
            // synced.
            await invoke("create_sync_notification", {
              userAddress,
              description: `Folder "${label}" was missing on the server, so Hippius restored it from this device. Its files are being uploaded again.`,
              fileDetailsJson: "",
              outcome: "folder_restored",
            });
            await refreshUnread();
          }),
        ]);
        if (cancelled) {
          results.forEach((u) => u());
        } else {
          unsubs.push(...results);
        }
      } catch (err) {
        console.warn("[FilesNotification] Failed to register event listeners:", err);
      }
    })();

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [areFilesNotificationsEnabled, polkadotAddress, oauthSession, refreshUnread]);

  useEffect(() => {
    refreshEnabledTypes();
  }, [refreshEnabledTypes]);
}
