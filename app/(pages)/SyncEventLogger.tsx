"use client";

import { useSyncEvents } from "@/lib/hooks/useSyncEvents";
import { useSyncSnapshotListener } from "@/lib/hooks/useSyncSnapshot";
import { useDriveStatuses } from "@/lib/hooks/useDriveStatuses";

/**
 * Invisible component that mounts the cross-cutting sync hooks:
 * - `useSyncEvents()` — Tauri event listeners for sync lifecycle logging.
 * - `useSyncSnapshotListener()` — push-based progress snapshots.
 * - `useDriveStatuses()` — single producer for `driveStatusesAtom`,
 *   subscribed to the per-drive Rust events. Replaces the old global
 *   per-drive status hook (replaces the deleted global engine-status hook).
 *
 * Must be rendered within an authenticated layout.
 */
export default function SyncEventLogger() {
  useSyncEvents();
  useSyncSnapshotListener();
  useDriveStatuses();
  return null;
}
