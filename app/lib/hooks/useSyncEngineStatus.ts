"use client";

/**
 * Subscribe to the Rust-owned sync engine status.
 *
 * This hook is the **only** producer for `syncEngineStatusAtom`. The atom
 * mirrors whatever Rust says, full stop. The previous frontend logic — a
 * `useEffect` in `FilesContainer.tsx` calling `is_drive_active` on mount —
 * raced against `auto_init_sync` and reliably lost on cold start, flipping
 * the widget to "Stopped" before drives had a chance to load. That race
 * is gone: the hook calls `get_sync_engine_status` once on mount and then
 * listens for `hcfs_sync_engine_status_changed` events from the backend.
 *
 * Mount this exactly once, at the protected layout root, alongside the
 * other invisible event-listener components (SyncEventLogger,
 * ConflictEventListener, MigrationChecker).
 *
 * One-shot localStorage migration: existing users with the old
 * `localStorage["hippius_sync_stopped"]` flag set to `"true"` get their
 * preference moved into the Rust-owned `user_preferences` table on first
 * mount, then the localStorage key is removed. Idempotent.
 */

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { syncEngineStatusAtom, type SyncEngineStatus } from "@/app/lib/global-atoms/unpinAtoms";

const SYNC_ENGINE_STATUS_CHANGED = "hcfs_sync_engine_status_changed";
const LEGACY_LOCAL_STORAGE_KEY = "hippius_sync_stopped";

/**
 * Migrate any legacy `localStorage["hippius_sync_stopped"]` value into the
 * Rust-owned `user_preferences` table, then remove the localStorage key.
 * No-op when the key isn't present, so safe to run on every mount.
 */
async function migrateLegacyStoppedFlag(): Promise<void> {
  if (typeof window === "undefined") return;
  const legacy = localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
  if (legacy !== "true" && legacy !== "false") return;
  try {
    await invoke("save_user_preference", {
      key: "sync_user_stopped",
      value: legacy,
    });
    localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY);
  } catch (err) {
    // Best-effort: leave the localStorage key in place so we can retry on
    // the next mount. Don't surface an error — the new path still works
    // even if the migration is delayed.
    console.warn("[useSyncEngineStatus] migration failed:", err);
  }
}

export function useSyncEngineStatus() {
  const setSyncEngineStatus = useSetAtom(syncEngineStatusAtom);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    (async () => {
      // 1. Migrate any legacy flag BEFORE the initial fetch so the fetch
      //    sees the correct persisted value.
      await migrateLegacyStoppedFlag();

      // 2. Initial fetch — Rust returns the authoritative status based on
      //    persisted flag → auto-init latch → in-memory state → drives map.
      try {
        const status = await invoke<SyncEngineStatus>("get_sync_engine_status");
        if (!cancelled) setSyncEngineStatus(status);
      } catch (err) {
        // Fail-closed: if we can't reach the backend, treat the engine as
        // stopped so the user gets a clear "something is wrong" signal
        // rather than a stuck "initializing" spinner.
        console.warn("[useSyncEngineStatus] initial fetch failed:", err);
        if (!cancelled) setSyncEngineStatus("stopped");
      }

      if (cancelled) return;

      // 3. Subscribe to backend status changes. Every transition the FE
      //    cares about flows through `set_status_and_emit` in Rust, which
      //    fires this event with the new status as a camelCase string.
      const handle = await listen<SyncEngineStatus>(
        SYNC_ENGINE_STATUS_CHANGED,
        (event) => {
          if (!cancelled) setSyncEngineStatus(event.payload);
        }
      );
      if (cancelled) {
        handle();
        return;
      }
      unlisten = handle;
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [setSyncEngineStatus]);
}
