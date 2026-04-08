"use client";

import { useSyncEvents } from "@/lib/hooks/useSyncEvents";
import { useSyncSnapshotListener } from "@/lib/hooks/useSyncSnapshot";
import { useSyncEngineStatus } from "@/lib/hooks/useSyncEngineStatus";

/**
 * Invisible component that mounts the cross-cutting sync hooks:
 * - `useSyncEvents()` — Tauri event listeners for sync lifecycle logging.
 * - `useSyncSnapshotListener()` — push-based progress snapshots.
 * - `useSyncEngineStatus()` — single producer for `syncEngineStatusAtom`,
 *   subscribed to the Rust-owned status. Replaces the old
 *   `is_drive_active` race in `FilesContainer.tsx`.
 *
 * Must be rendered within an authenticated layout.
 */
export default function SyncEventLogger() {
  useSyncEvents();
  useSyncSnapshotListener();
  useSyncEngineStatus();
  return null;
}
