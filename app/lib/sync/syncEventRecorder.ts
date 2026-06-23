"use client";

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { type SyncSnapshot } from "@/lib/types/syncSnapshot";
import { errorMessage } from "@/lib/utils/errorUtils";

/**
 * A captured sync session: the bootstrap snapshot the widget seeded from
 * (`sp_get_snapshot`) plus the ordered `sync_progress_snapshot` event payloads.
 *
 * This is intentionally the SAME shape the replay harness consumes
 * (`app/(pages)/__tests__/syncWidgetReplay.invariants.ts` `ReplaySession`), so
 * a session captured from a real run drops straight into a replay test with no
 * translation — the whole reason the recorder exists. Recording REAL streams,
 * rather than hand-building snapshots, is what closes the blind spot behind the
 * surviving widget bugs (AUDIT_SYNC_WIDGET_2026-06-22.md): the author who
 * misunderstood the data also builds the fixture that fails to trip it.
 */
export interface RecordedSyncSession {
  seed: SyncSnapshot | null;
  frames: SyncSnapshot[];
}

/** Hard cap so a recorder left enabled across many sync cycles can't grow
 *  memory without bound; the oldest frames are dropped past this. */
const MAX_FRAMES = 5000;

/** localStorage key the developer flips to arm the recorder. Off by default. */
const ENABLE_KEY = "hippius:record-sync";

interface SyncRecorderHandle {
  /** Returns the captured session (seed + frames) as a plain object. */
  dump(): RecordedSyncSession;
  /** Triggers a browser download of the session as pretty-printed JSON. */
  download(fileName?: string): void;
  /** Discards all captured frames (keeps the seed). */
  clear(): void;
  /** Number of frames captured so far. */
  readonly count: number;
}

declare global {
  interface Window {
    __hippiusSyncRecorder?: SyncRecorderHandle;
  }
}

function isEnabled(): boolean {
  // Never in production builds; only when explicitly armed. The production cost
  // of this whole module is therefore one `process.env` compare + one
  // `localStorage.getItem` at mount, then it bails.
  if (process.env.NODE_ENV === "production") return false;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ENABLE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Dev-only recorder for the sync-progress event stream.
 *
 * Mounted unconditionally (it self-gates), so it is a no-op unless armed via
 * `localStorage.setItem("hippius:record-sync", "1")` in a non-production build.
 * When armed it seeds from `sp_get_snapshot`, captures every
 * `sync_progress_snapshot` payload in order, and exposes
 * `window.__hippiusSyncRecorder` so a developer can reproduce a sync, then run
 * `window.__hippiusSyncRecorder.download()` and drop the JSON into a replay
 * test fixture.
 */
export function useSyncRecorder(): void {
  useEffect(() => {
    if (!isEnabled()) return;

    const session: RecordedSyncSession = { seed: null, frames: [] };
    let cancelled = false;
    let unsub: (() => void) | null = null;

    invoke<SyncSnapshot>("sp_get_snapshot")
      .then((snapshot) => {
        if (!cancelled) session.seed = snapshot;
      })
      .catch((err: unknown) => {
        console.warn("[SyncRecorder] seed fetch failed:", errorMessage(err));
      });

    listen<SyncSnapshot>("sync_progress_snapshot", (event) => {
      if (cancelled) return;
      session.frames.push(event.payload);
      if (session.frames.length > MAX_FRAMES) {
        session.frames.splice(0, session.frames.length - MAX_FRAMES);
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unsub = fn;
      })
      .catch((err: unknown) => {
        console.warn("[SyncRecorder] listen failed:", errorMessage(err));
      });

    const handle: SyncRecorderHandle = {
      dump: () => ({ seed: session.seed, frames: [...session.frames] }),
      download: (fileName = "sync-session.json") => {
        const blob = new Blob([JSON.stringify(handle.dump(), null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        anchor.click();
        URL.revokeObjectURL(url);
      },
      clear: () => {
        session.frames.length = 0;
      },
      get count() {
        return session.frames.length;
      },
    };

    window.__hippiusSyncRecorder = handle;
    console.info(
      "[SyncRecorder] armed — reproduce a sync, then call " +
        "window.__hippiusSyncRecorder.download()",
    );

    return () => {
      cancelled = true;
      unsub?.();
      if (window.__hippiusSyncRecorder === handle) {
        delete window.__hippiusSyncRecorder;
      }
    };
  }, []);
}
