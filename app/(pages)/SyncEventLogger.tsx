"use client";

import { useSyncEvents } from "@/lib/hooks/useSyncEvents";

/**
 * Invisible component that mounts useSyncEvents() to activate
 * Tauri event listeners for sync lifecycle logging.
 * Must be rendered within an authenticated layout.
 */
export default function SyncEventLogger() {
  useSyncEvents();
  return null;
}
