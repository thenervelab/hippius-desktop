"use client";

import { useSyncEvents } from "@/lib/hooks/useSyncEvents";
import { useSyncSnapshotListener } from "@/lib/hooks/useSyncSnapshot";

/**
 * Invisible component that mounts useSyncEvents() to activate
 * Tauri event listeners for sync lifecycle logging, and
 * useSyncSnapshotListener() for push-based progress snapshots.
 * Must be rendered within an authenticated layout.
 */
export default function SyncEventLogger() {
  useSyncEvents();
  useSyncSnapshotListener();
  return null;
}
