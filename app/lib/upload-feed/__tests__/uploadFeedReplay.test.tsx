/**
 * Uploads-feed REPLAY harness (integration level).
 *
 * The pure `mergeUploadFeed.test.ts` covers the join in isolation, but it FAKES
 * retention by passing a static `retainedCompleted` array. The actual Bug-3 fix
 * lives in the STATEFUL `useRetainedCompletedUploads` hook (a ref cache that
 * captures a finished upload ONCE with a stable timestamp and evicts it only on
 * server confirmation) — behavior that only exists across React renders. This
 * suite drives the REAL `useUploadFeed` chain (snapshot atom → the real
 * retention hook → the real `mergeUploadFeed`) through an ordered STREAM and
 * asserts the user-visible feed after each frame, closing the same
 * component-wiring blind spot the dialog replay closes — for the feed surface
 * (AUDIT_SYNC_WIDGET_2026-06-22.md bugs 3, 4, 8).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";

import { snapshotAtom } from "@/app/lib/hooks/useSyncSnapshot";
import { makeSnapshot } from "@/lib/test-utils/syncSnapshotFactory";
import { useFileLiveProgress } from "@/app/lib/hooks/useFileLiveProgress";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { FileProgress } from "@/app/lib/types/syncSnapshot";

// Controllable server list — the `get_recent_uploads` result the feed overlays
// live progress on top of. `useUploadFeed` imports this hook; we replace it so
// the test owns the "server has refetched" timing that Bug 3 hinges on.
const serverState = vi.hoisted(() => ({ data: [] as FormattedUserFile[] }));
const refetch = vi.fn();
vi.mock("@/app/lib/hooks/useRecentUploads", () => ({
  default: () => ({
    data: serverState.data,
    isLoading: false,
    isFetching: false,
    refetch,
  }),
}));

// Imported AFTER the mock so the mocked useRecentUploads is wired in.
import { useUploadFeed } from "@/app/lib/hooks/useUploadFeed";

// Deterministic clock so "captured once with a stable timestamp" is observable:
// snapshotToItem stamps `createdAt: Date.now()`, so a re-stamp regression
// (the "Just now forever" bug) would change createdAt when the clock advances.
const clock = { now: 1_000 };

function serverFile(name: string, opts: Partial<FormattedUserFile> = {}): FormattedUserFile {
  return {
    name,
    actualFileName: name,
    size: 100,
    createdAt: 1_000,
    arionHash: name,
    arionCid: "",
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    label: "Docs",
    syncStatus: "synced",
    ...opts,
  };
}

function progressFile(
  path: string,
  status: FileProgress["status"],
  opts: Partial<FileProgress> = {},
): FileProgress {
  return {
    path,
    fileName: path,
    label: "Docs",
    action: "upload",
    status,
    progressPercent: 0,
    bytesEncrypted: 0,
    bytesTransferred: 0,
    totalBytes: 200,
    ...opts,
  };
}

let store: ReturnType<typeof createStore>;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <Provider store={store}>{children}</Provider>
);

beforeEach(() => {
  serverState.data = [];
  clock.now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  store = createStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Push a new live snapshot (drives the atom the feed subscribes to). */
function pushSnapshot(files: FileProgress[]) {
  act(() => {
    store.set(snapshotAtom, makeSnapshot(files));
  });
}

describe("uploads feed replay — retain across the refetch gap (Bug 3)", () => {
  it("keeps a finished upload visible (with a stable timestamp) until the server confirms it", () => {
    const { result, rerender } = renderHook(() => useUploadFeed(50), { wrapper });

    // 1. Mid-upload: one live "uploading" row.
    pushSnapshot([progressFile("photo.jpg", "inProgress", { progressPercent: 40 })]);
    expect(result.current.data.map((f) => f.feedStatus)).toEqual(["uploading"]);

    // 2. Finishes in the snapshot; server list hasn't refetched yet.
    clock.now = 2_000;
    pushSnapshot([progressFile("photo.jpg", "completed")]);
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data[0].feedStatus).toBe("completed");
    const capturedAt = result.current.data[0].createdAt;
    expect(capturedAt).toBe(2_000);

    // 3. THE VANISH WINDOW: the file leaves snapshot.files, server STILL empty.
    //    Without retention this row disappears (the "appear then vanish" bug).
    clock.now = 5_000;
    pushSnapshot([]);
    expect(result.current.data.map((f) => f.name)).toEqual(["photo.jpg"]);

    // 4. Another merge tick while still retained — the timestamp must NOT be
    //    re-stamped to `now` (else the row reads "Just now" forever).
    clock.now = 9_000;
    act(() => rerender());
    expect(result.current.data[0].createdAt).toBe(capturedAt);

    // 5. Server refetch lands with the authoritative row → retained copy is
    //    evicted, exactly one row remains, and the server's real time wins.
    clock.now = 12_000;
    act(() => {
      serverState.data = [serverFile("photo.jpg", { createdAt: 7_777 })];
      rerender();
    });
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data[0].createdAt).toBe(7_777);
  });
});

describe("uploads feed replay: a batch larger than the server's list", () => {
  // The reported bug: after uploading more files than Recent Files shows, the
  // older finished rows were never in the server's newest-N list, so they
  // were never confirmed and stayed pinned at the top, above newer files,
  // until the page was left and the feed rebuilt.
  it("lets a finished row go once the server lists newer uploads without it", () => {
    const { result, rerender } = renderHook(() => useUploadFeed(3), { wrapper });

    clock.now = 2_000;
    pushSnapshot([progressFile("old.png", "completed")]);
    pushSnapshot([]);
    expect(result.current.data.map((f) => f.name)).toEqual(["old.png"]);

    // Three newer uploads land on the server; old.png ranks fourth and is
    // not in the list of three.
    act(() => {
      serverState.data = [
        serverFile("c.png", { createdAt: 5_000 }),
        serverFile("b.png", { createdAt: 4_000 }),
        serverFile("a.png", { createdAt: 3_000 }),
      ];
      rerender();
    });
    expect(result.current.data.map((f) => f.name)).toEqual(["c.png", "b.png", "a.png"]);
  });

  it("keeps a finished row while the server has not caught up to it", () => {
    const { result, rerender } = renderHook(() => useUploadFeed(3), { wrapper });

    clock.now = 9_000;
    pushSnapshot([progressFile("new.png", "completed")]);
    pushSnapshot([]);
    // The refetch landed but predates new.png: every row is older than it.
    act(() => {
      serverState.data = [serverFile("a.png", { createdAt: 3_000 })];
      rerender();
    });
    expect(result.current.data.map((f) => f.name)).toEqual(["new.png", "a.png"]);
  });

  it("does not drop a finished row the snapshot still lists, so it is never re-stamped", () => {
    const { result, rerender } = renderHook(() => useUploadFeed(3), { wrapper });

    clock.now = 2_000;
    pushSnapshot([progressFile("old.png", "completed")]);
    act(() => {
      serverState.data = [serverFile("c.png", { createdAt: 5_000 })];
      rerender();
    });
    clock.now = 8_000;
    act(() => rerender());
    const row = result.current.data.find((f) => f.name === "old.png");
    expect(row?.createdAt).toBe(2_000);
  });
});

describe("uploads feed replay — leading-slash dedup through the real chain (Bug 4)", () => {
  it("collapses a macOS leading-slash snapshot path against the trimmed server path", () => {
    const { result, rerender } = renderHook(() => useUploadFeed(50), { wrapper });

    // Snapshot carries the APFS leading slash; the file finishes and is retained.
    pushSnapshot([progressFile("/Work/a.png", "completed")]);
    expect(result.current.data).toHaveLength(1);

    // Server returns the SAME file with the slash trimmed. The two must dedup to
    // one row (normalizeRelPath on both sides); a regression splits them in two.
    act(() => {
      serverState.data = [serverFile("a.png", { actualFileName: "Work/a.png", createdAt: 42 })];
      rerender();
    });
    pushSnapshot([]);
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data[0].createdAt).toBe(42);
  });
});

describe("uploads feed replay — per-file live progress join (Bug 8)", () => {
  it("binds each same-basename file in different folders to its OWN progress", () => {
    const { result } = renderHook(
      () => ({
        a: useFileLiveProgress("Work/report.pdf", "report.pdf", "Docs"),
        b: useFileLiveProgress("Home/report.pdf", "report.pdf", "Docs"),
      }),
      { wrapper },
    );

    pushSnapshot([
      progressFile("Work/report.pdf", "inProgress", { progressPercent: 30, bytesTransferred: 60 }),
      progressFile("Home/report.pdf", "inProgress", { progressPercent: 70, bytesTransferred: 140 }),
    ]);

    // Each row gets its own file's percent — never the first match's (the
    // name-based first-match-wins regression bound both to 30).
    expect(result.current.a.progressPercent).toBe(30);
    expect(result.current.b.progressPercent).toBe(70);
  });

  it("returns no progress on an ambiguous basename collision rather than the wrong file's", () => {
    const { result } = renderHook(
      // A row that only knows its basename, with two snapshot files sharing it.
      () => useFileLiveProgress(undefined, "dup.png", "Docs"),
      { wrapper },
    );

    pushSnapshot([
      progressFile("one/dup.png", "inProgress", { fileName: "dup.png", progressPercent: 10, bytesTransferred: 20 }),
      progressFile("two/dup.png", "inProgress", { fileName: "dup.png", progressPercent: 90, bytesTransferred: 180 }),
    ]);

    // Two name matches → no bind (blank is correct; another file's % is not).
    expect(result.current.progressPercent).toBeNull();
    expect(result.current.status).toBeNull();
  });
});
