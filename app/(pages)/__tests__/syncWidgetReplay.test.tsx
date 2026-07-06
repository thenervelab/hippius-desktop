/**
 * Sync-widget REPLAY harness.
 *
 * Where SyncStatusDialog.test.tsx renders one hand-built snapshot straight
 * into the dialog, this suite mounts the REAL chain the app runs —
 * `useSyncSnapshotListener()` (the seed + `sync_progress_snapshot` writer) →
 * `SyncStatusHandler` → `SyncStatusDialog` — and replays an ordered *stream*
 * of frames through the mocked Tauri event boundary, asserting the audit
 * invariants after every frame.
 *
 * That extra reach is the point: the surviving bugs in
 * AUDIT_SYNC_WIDGET_2026-06-22.md are stateful across frames (smoother sticks
 * high — Bug 7; seed clobbers a newer live frame — Bug 6) and a single-frame
 * test structurally cannot exercise them. The same {@link ReplaySession} shape
 * is what `app/lib/sync/syncEventRecorder.ts` dumps from a real session, so a
 * captured production stream replays here unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";

import SyncStatusHandler from "../SyncStatusHandler";
import { useSyncSnapshotListener } from "@/lib/hooks/useSyncSnapshot";
import { EMPTY_SNAPSHOT, type SyncSnapshot } from "@/lib/types/syncSnapshot";
import { syncEngineHealthAtom } from "@/lib/store/syncAtoms";
import { makeFileProgress, makeSnapshot } from "@/lib/test-utils/syncSnapshotFactory";
import {
  checkFrameInvariants,
  readRingPercent,
  scenarioSingleLargeUpload,
  scenarioReplanLowersPercent,
  REPLAN_EXPECTED_PERCENT,
  REPLAN_STALE_PERCENT,
  type ReplaySession,
} from "./syncWidgetReplay.invariants";

// ── Tauri boundary control ─────────────────────────────────────────────────
//
// `vi.hoisted` so the mock factories (themselves hoisted above imports) can
// share one mutable control object with the test body. The seed (`sp_get_snapshot`)
// can resolve immediately or be held open ("deferred") to reproduce the
// seed-vs-live ordering race (Bug 6).
const ctl = vi.hoisted(() => ({
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  seedMode: "immediate" as "immediate" | "deferred",
  seedValue: null as SyncSnapshot | null,
  resolveSeed: null as null | ((s: SyncSnapshot) => void),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "sp_get_snapshot") {
      if (ctl.seedMode === "deferred") {
        return new Promise<SyncSnapshot>((res) => {
          ctl.resolveSeed = res;
        });
      }
      return Promise.resolve(ctl.seedValue);
    }
    return Promise.resolve(undefined);
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    ctl.listeners.set(event, handler);
    return Promise.resolve(() => ctl.listeners.delete(event));
  }),
}));

// UI-dep stubs (same set SyncStatusDialog.test.tsx uses) to keep the mount
// free of icon/tooltip deep imports while exercising the real layout/logic.
vi.mock("@/components/ui/icons", () => ({
  Close: ({ className }: { className?: string }) => (
    <span data-testid="icon-close" className={className} />
  ),
  TickCircle: ({ className }: { className?: string }) => <span className={className} />,
  Refresh: ({ className }: { className?: string }) => <span className={className} />,
  InfoCircle: ({ className }: { className?: string }) => <span className={className} />,
}));
vi.mock("@/components/ui/CustomTooltip2", () => ({
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/MiddleTruncatedName", () => ({
  default: ({ name, className }: { name: string; className?: string }) => (
    <span className={className} title={name}>
      {name}
    </span>
  ),
}));
vi.mock("../../lib/utils/fileTypeUtils", () => ({
  getFileIcon: () => ({
    icon: ({ className }: { className?: string }) => <span className={className} />,
    color: "text-grey-50",
  }),
  DEFAULT_FILE_FORMAT: "document",
  DIRECTORY_SUFFIX: ".ec_metadata",
  isDirectory: () => false,
  formatDisplayName: (name: string) => name,
}));

/** Mounts the production read/write chain: the listener that owns the snapshot
 *  atom plus the widget that renders it. */
function ReplayHost() {
  useSyncSnapshotListener();
  return <SyncStatusHandler host="portal" />;
}

function makeStore() {
  const store = createStore();
  store.set(syncEngineHealthAtom, {
    status: "connected",
    last_check_time: 0,
    last_successful_check: 0,
    consecutive_failures: 0,
    server_version: null,
    error_message: null,
  });
  return store;
}

/** Flush the microtasks the seed/listen promises schedule. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(seed: SyncSnapshot | null) {
  ctl.seedValue = seed ?? EMPTY_SNAPSHOT;
  const utils = render(
    <Provider store={makeStore()}>
      <ReplayHost />
    </Provider>,
  );
  await flush();
  return utils;
}

async function pushFrame(snapshot: SyncSnapshot) {
  const handler = ctl.listeners.get("sync_progress_snapshot");
  if (!handler) throw new Error("sync_progress_snapshot listener not registered");
  await act(async () => {
    handler({ payload: snapshot });
  });
}

/** Replay a whole session, asserting per-frame invariants after each frame. */
async function replayWithInvariants(session: ReplaySession) {
  const { container } = await mount(session.seed);
  for (let i = 0; i < session.frames.length; i++) {
    const snapshot = session.frames[i];
    await pushFrame(snapshot);
    const violations = checkFrameInvariants(container, snapshot);
    expect(
      violations,
      `frame ${i} (overallPercent=${snapshot.overallPercent}): ` +
        violations.map((v) => `[${v.rule}] ${v.detail}`).join("; "),
    ).toEqual([]);
  }
  return container;
}

beforeEach(() => {
  ctl.listeners.clear();
  ctl.seedMode = "immediate";
  ctl.seedValue = null;
  ctl.resolveSeed = null;
});

afterEach(() => {
  cleanup();
});

describe("sync widget replay — per-frame invariants", () => {
  it("single 260MB upload: header bytes never contradict the ring (Bug 1)", async () => {
    await replayWithInvariants(scenarioSingleLargeUpload());
  });

  it("re-plan stream keeps the header byte-sourced throughout (Bug 1)", async () => {
    await replayWithInvariants(scenarioReplanLowersPercent());
  });
});

describe("sync widget replay — stateful cross-frame bugs", () => {
  it("smoother follows the percent DOWN after a mid-session re-plan (Bug 7)", async () => {
    const container = await replayWithInvariants(scenarioReplanLowersPercent());
    // The whole point: an upward-only `Math.max` smoother would pin the ring at
    // the pre-re-plan high-water mark. The fix re-seeds on the bytesExpected /
    // totalFiles change, so the ring must read the lowered percent.
    const ring = readRingPercent(container);
    expect(ring).toBe(REPLAN_EXPECTED_PERCENT);
    expect(ring).not.toBe(REPLAN_STALE_PERCENT);
  });

  it("a live frame that lands before the seed is not clobbered by the stale seed (Bug 6)", async () => {
    // Hold the seed open, let a NEWER live frame land first, THEN resolve the
    // seed with a stale snapshot. The fix (only seed while the atom is still
    // EMPTY_SNAPSHOT) must keep the live frame.
    ctl.seedMode = "deferred";
    const { container } = await mount(null);

    const liveFrame = makeSnapshot(
      [
        makeFileProgress("live.bin", {
          status: "inProgress",
          progressPercent: 50,
          bytesTransferred: 5_000_000,
          totalBytes: 10_000_000,
        }),
      ],
      { startedAt: 2_000, overallPercent: 50 },
    );
    await pushFrame(liveFrame);
    expect(readRingPercent(container)).toBe(50);

    const staleSeed = makeSnapshot(
      [
        makeFileProgress("stale.bin", {
          status: "inProgress",
          progressPercent: 5,
          bytesTransferred: 500_000,
          totalBytes: 10_000_000,
        }),
      ],
      { startedAt: 1_000, overallPercent: 5 },
    );
    await act(async () => {
      ctl.resolveSeed?.(staleSeed);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Live frame survives; the stale seed did not overwrite it.
    expect(readRingPercent(container)).toBe(50);
  });
});
