"use client";

import { useSyncEvents } from "@/lib/hooks/useSyncEvents";
import { useSyncSnapshotListener } from "@/lib/hooks/useSyncSnapshot";
import { useDriveStatuses } from "@/lib/hooks/useDriveStatuses";
import { useServerCapabilities } from "@/lib/hooks/useServerCapabilities";
import { useUploadProcessing } from "@/lib/hooks/useUploadProcessing";
import { useCreditsExhausted } from "@/lib/hooks/useCreditsExhausted";
import { useMetadataStale } from "@/lib/hooks/useMetadataStale";
import { useSyncRecorder } from "@/lib/sync/syncEventRecorder";

/**
 * Invisible component that mounts the cross-cutting sync hooks:
 * - `useSyncEvents()` — Tauri event listeners for sync lifecycle logging.
 * - `useSyncSnapshotListener()` — push-based progress snapshots.
 * - `useDriveStatuses()` — single producer for `driveStatusesAtom`,
 *   subscribed to the per-drive Rust events. Replaces the old global
 *   per-drive status hook (replaces the deleted global engine-status hook).
 * - `useCreditsExhausted()` — writes the credits-exhausted atom on
 *   `hcfs_credits_exhausted` events; the banner reads it.
 * - `useMetadataStale()` — writes `metadataStaleLabelsAtom` on
 *   `hcfs_metadata_stale` events and clears it on `hcfs_activity_updated`,
 *   so the Files page can surface a per-drive "couldn't refresh upload
 *   dates" banner when the bounded-retry reconcile exhausts its budget.
 * - `useSyncRecorder()` — dev-only, self-gated capture of the snapshot event
 *   stream into a replay fixture. No-op in production / unless armed via
 *   `localStorage["hippius:record-sync"] = "1"`.
 *
 * Must be rendered within an authenticated layout.
 */
export default function SyncEventLogger() {
  useSyncEvents();
  useUploadProcessing();
  useSyncSnapshotListener();
  useDriveStatuses();
  useCreditsExhausted();
  useMetadataStale();
  useSyncRecorder();
  // Caches `serverCapabilitiesAtom` once per session so share UI surfaces
  // can gate themselves on `shares: true` without each surface fetching
  // separately. Cleared automatically on logout.
  useServerCapabilities();
  return null;
}
