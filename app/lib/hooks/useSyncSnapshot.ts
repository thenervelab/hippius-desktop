"use client";

import { useEffect } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { selectAtom } from "jotai/utils";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  EMPTY_SNAPSHOT,
  type FileAction,
  type SyncSnapshot,
} from "../types/syncSnapshot";
import { errorMessage } from "../utils/errorUtils";

export const snapshotAtom = atom<SyncSnapshot>(EMPTY_SNAPSHOT);

/** A snapshot row that should influence file-listing UI (tables, cards). */
export interface ActionableSyncFile {
  path: string;
  fileName: string;
  /**
   * Deliberately coarse — listings only need "is it in flight, and which
   * direction". Carrying the engine's raw status here would churn the table
   * on every chunk boundary: hcfs oscillates inProgress↔encrypting per
   * chunk, and each oscillation would defeat the deep-equality guard below.
   */
  phase: "inFlight" | "completedDownload";
  action: FileAction;
}

/**
 * The subset of snapshot rows that file listings care about: in-flight
 * uploads/downloads (drive the live "uploading"/"downloading" pills) and
 * completed downloads (suppress the stale "pending" the backend reports
 * until its synced-set refreshes).
 *
 * Derived via `selectAtom` with DEEP equality so subscribers re-render only
 * when a file enters/leaves flight or finishes a download — NOT on the
 * ~250ms byte-progress ticks or per-chunk status oscillations, which
 * replace the snapshot atom wholesale but leave these rows content-equal.
 * Subscribing a large table to the raw `snapshotAtom` re-rendered every row
 * 4×/second during a sync, which is what made long listings unscrollable.
 */
export const actionableSyncFilesAtom = selectAtom(
  snapshotAtom,
  (snapshot): ActionableSyncFile[] => {
    const rows: ActionableSyncFile[] = [];
    for (const f of snapshot.files) {
      const isInFlight =
        f.status !== "completed" &&
        (f.action === "upload" || f.action === "download");
      const isCompletedDownload =
        f.status === "completed" && f.action === "download";
      if (isInFlight || isCompletedDownload) {
        rows.push({
          path: f.path,
          fileName: f.fileName,
          phase: isCompletedDownload ? "completedDownload" : "inFlight",
          action: f.action,
        });
      }
    }
    // Snapshot file order shuffles as the engine reprioritizes; sort so the
    // equality check below compares content, not ordering.
    rows.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    return rows;
  },
  (a, b) =>
    a.length === b.length &&
    a.every(
      (r, i) =>
        r.path === b[i].path &&
        r.fileName === b[i].fileName &&
        r.phase === b[i].phase &&
        r.action === b[i].action,
    ),
);

/**
 * Listens for push-based sync progress snapshots from the Rust backend.
 *
 * Mount once at the app root. Rust emits "sync_progress_snapshot" events
 * on state changes (throttled to 250ms for byte updates, immediate for
 * status transitions). No polling needed.
 */
export function useSyncSnapshotListener() {
  const setSnapshot = useSetAtom(snapshotAtom);

  useEffect(() => {
    let cancelled = false;

    invoke<SyncSnapshot>("sp_get_snapshot")
      .then((snapshot) => {
        // The seed and the live event stream are independent async sources. On
        // a fast-starting sync a `sync_progress_snapshot` event can land before
        // this seed resolves; applying the seed unconditionally would then
        // clobber the newer live state with the stale bootstrap. Only seed if
        // no event has written yet — `EMPTY_SNAPSHOT` is the shared initial
        // reference, so `cur === EMPTY_SNAPSHOT` reliably means "untouched".
        if (!cancelled) {
          setSnapshot((cur) => (cur === EMPTY_SNAPSHOT ? snapshot : cur));
        }
      })
      .catch((err: unknown) => {
        console.error("[SyncSnapshot] Failed to get initial snapshot:", errorMessage(err));
      });

    let unsubFn: (() => void) | null = null;

    listen<SyncSnapshot>("sync_progress_snapshot", (e) => {
      if (!cancelled) setSnapshot(e.payload);
    })
      .then((unsub) => {
        if (cancelled) {
          unsub();
        } else {
          unsubFn = unsub;
        }
      })
      .catch((err: unknown) => {
        console.error("[SyncSnapshot] Failed to listen:", errorMessage(err));
      });

    return () => {
      cancelled = true;
      unsubFn?.();
    };
  }, [setSnapshot]);
}

/**
 * Read-only hook to access the current sync snapshot.
 */
export function useSyncSnapshot(): SyncSnapshot {
  return useAtomValue(snapshotAtom);
}
