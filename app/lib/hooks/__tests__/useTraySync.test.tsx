import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";

// jotai 2.x no longer exports a `Store` type; the store handle is the return
// of `createStore` (what `appStore` in jotaiStore.ts actually is).
type JotaiStore = ReturnType<typeof createStore>;
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EMPTY_SNAPSHOT, type SyncSnapshot } from "@/app/lib/types/syncSnapshot";

// ── Hoisted mock infrastructure ─────────────────────────────────────
//
// `useTraySync` holds module-level state (driveSubmenu, menuPromise,
// driveSubmenuItems, rendered text cache) that persists across
// renders. The tests need isolated state per case, so every test
// uses `vi.resetModules()` and dynamically imports the hook.
//
// The Tauri menu/tray classes are mocked as lightweight recording
// stubs so assertions can look at the operations that the hook
// performed — `appendLog`, `removeLog`, rendered text, etc.

const mocks = vi.hoisted(() => {
  interface MenuItemOpts {
    id?: string;
    text: string;
    enabled?: boolean;
    action?: () => void;
  }

  class MockMenuItem {
    id?: string;
    text: string;
    enabled: boolean;
    action?: () => void;

    constructor(opts: MenuItemOpts) {
      this.id = opts.id;
      this.text = opts.text;
      this.enabled = opts.enabled ?? true;
      this.action = opts.action;
    }

    static async new(opts: MenuItemOpts) {
      return new MockMenuItem(opts);
    }

    async setText(text: string) {
      this.text = text;
    }

    async setEnabled(enabled: boolean) {
      this.enabled = enabled;
    }
  }

  class MockPredefinedMenuItem {
    static async new() {
      return new MockPredefinedMenuItem();
    }
  }

  class MockSubmenu {
    id?: string;
    text: string;
    items: MockMenuItem[] = [];
    appendLog: MockMenuItem[] = [];
    removeLog: MockMenuItem[] = [];

    constructor(opts: { id?: string; text: string; items?: MockMenuItem[] }) {
      this.id = opts.id;
      this.text = opts.text;
      if (opts.items) this.items = [...opts.items];
    }

    static async new(opts: { id?: string; text: string; items?: MockMenuItem[] }) {
      return new MockSubmenu(opts);
    }

    async append(item: MockMenuItem) {
      this.items.push(item);
      this.appendLog.push(item);
    }

    async remove(item: MockMenuItem) {
      const idx = this.items.indexOf(item);
      if (idx >= 0) this.items.splice(idx, 1);
      this.removeLog.push(item);
    }
  }

  class MockMenu {
    private _items: unknown[] = [];
    submenus: MockSubmenu[] = [];

    constructor(opts?: { items?: unknown[] }) {
      if (opts?.items) this._items = [...opts.items];
    }

    static async new(opts?: { items?: unknown[] }) {
      return new MockMenu(opts);
    }

    async append(item: unknown) {
      this._items.push(item);
      if (item instanceof MockSubmenu) this.submenus.push(item);
    }

    async items() {
      return [...this._items];
    }

    async remove(item: unknown) {
      const idx = this._items.indexOf(item);
      if (idx >= 0) this._items.splice(idx, 1);
    }

    async insert(item: unknown, position: number) {
      this._items.splice(position, 0, item);
    }
  }

  class MockTrayIcon {
    static async getById() {
      return null;
    }
    static async new() {
      return new MockTrayIcon();
    }
    async setIcon() {
      /* noop */
    }
    async setTitle() {
      /* noop */
    }
  }

  return {
    MockMenuItem,
    MockPredefinedMenuItem,
    MockSubmenu,
    MockMenu,
    MockTrayIcon,
  };
});

vi.mock("@tauri-apps/api/menu", () => ({
  MenuItem: mocks.MockMenuItem,
  PredefinedMenuItem: mocks.MockPredefinedMenuItem,
  Submenu: mocks.MockSubmenu,
  Menu: mocks.MockMenu,
}));

vi.mock("@tauri-apps/api/tray", () => ({
  TrayIcon: mocks.MockTrayIcon,
}));

vi.mock("@tauri-apps/api/path", () => ({
  resolveResource: vi.fn(async (p: string) => `/resolved/${p}`),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ hasEnough: true, isLoading: false })),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {
    /* noop unlisten */
  }),
}));

vi.mock("@/app/lib/tray/trayWindowActions", () => ({
  openAppWindow: vi.fn(),
  openFilesPage: vi.fn(),
  openVirtualMachinesPage: vi.fn(),
}));

vi.mock("@/components/updater/checkForUpdates", () => ({
  checkForUpdates: vi.fn(),
  getAvailableUpdate: vi.fn(async () => null),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// The hook reads from `appStore` (the shared Jotai store) for its
// initial drain-rebuild call. We need the test store to BE that
// module, so the hook sees the drive entries we seed.
function mockAppStoreAs(store: JotaiStore) {
  vi.doMock("@/lib/store/jotaiStore", () => ({ appStore: store }));
}

// ── Test helpers ────────────────────────────────────────────────────

type DriveEntryLike = {
  folderName: string;
  path: string;
  status: { kind: "active" | "paused" } | { kind: "error"; message: string };
};

async function setupHook(initialDrives?: Map<string, DriveEntryLike>) {
  // Fresh module state every test.
  vi.resetModules();

  const store = createStore();
  mockAppStoreAs(store);

  // Import the atom first — same module registry as the hook will
  // see, so the reference identity matches.
  const { driveStatusesAtom } = await import(
    "@/app/lib/global-atoms/unpinAtoms"
  );

  // Seed BEFORE the hook mounts so the menu-builder drain call sees
  // the pre-existing entries (exercises the startup-race recovery).
  if (initialDrives) {
    store.set(driveStatusesAtom, initialDrives);
  }

  const { useTrayInit } = await import("../useTraySync");

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );

  const { unmount, rerender } = renderHook(
    ({ isAuth }: { isAuth: boolean }) => useTrayInit(isAuth),
    { wrapper, initialProps: { isAuth: true } }
  );

  return { store, unmount, rerender, driveStatusesAtom };
}

async function getSubmenu(): Promise<InstanceType<typeof mocks.MockSubmenu>> {
  // The hook appended exactly one Submenu to the root Menu; grab it
  // from the last MockMenu that was constructed. Since we reset
  // modules every test, there's only one.
  return await waitFor(() => {
    // Heuristic: the submenu was assigned into module-level state as
    // `driveSubmenu`. We can recover it by asking the MockMenu for
    // the submenu it holds — but the MockMenu instance isn't exposed.
    // Instead, poll for a Submenu instance whose id matches the
    // per-drive submenu id.
    const submenu = findSubmenuById("drive-submenu");
    if (!submenu) throw new Error("drive-submenu not built yet");
    return submenu;
  });
}

// Registry of all MockSubmenu instances the hook constructed this test.
// Populated via a side-channel in the mock class — we intercept
// construction by monkey-patching prior to each test.
const submenuRegistry: InstanceType<typeof mocks.MockSubmenu>[] = [];

function findSubmenuById(
  id: string
): InstanceType<typeof mocks.MockSubmenu> | undefined {
  return submenuRegistry.find((s) => s.id === id);
}

// Registry of all MockMenu instances so the race-prevention test can
// inspect the root menu's items directly (the hook only holds the
// menu inside a module-local `menuPromise`).
const menuRegistry: InstanceType<typeof mocks.MockMenu>[] = [];

beforeEach(() => {
  submenuRegistry.length = 0;
  menuRegistry.length = 0;
  // Patch `Submenu.new` to register every constructed submenu so
  // tests can fish out the drive submenu without reaching into
  // module internals.
  const OrigNew = mocks.MockSubmenu.new.bind(mocks.MockSubmenu);
  mocks.MockSubmenu.new = async (
    opts: { id?: string; text: string; items?: InstanceType<typeof mocks.MockMenuItem>[] }
  ) => {
    const inst = await OrigNew(opts);
    submenuRegistry.push(inst);
    return inst;
  };
  // Same trick for Menu.new.
  const OrigMenuNew = mocks.MockMenu.new.bind(mocks.MockMenu);
  mocks.MockMenu.new = async (
    opts?: { items?: unknown[] }
  ) => {
    const inst = await OrigMenuNew(opts);
    menuRegistry.push(inst);
    return inst;
  };
});

// ── Tests ───────────────────────────────────────────────────────────

describe("useTraySync — Sync Folders submenu lifecycle", () => {
  it("drains driveStatusesAtom updates that land mid menu-build (add race)", async () => {
    const halo: DriveEntryLike = {
      folderName: "Halo",
      path: "/Users/camden/Hippius/Halo",
      status: { kind: "active" },
    };

    // Seed the atom BEFORE the hook mounts — simulating the race
    // where `add_local_sync_folder` completed and emitted
    // `hcfs_drive_status_changed` while the menu-builder was still
    // awaiting resource resolution. In the pre-fix code the initial
    // rebuild effect would bail because `driveSubmenu` was null, and
    // no further event would fire to re-trigger it. The drain call
    // at the end of the menu-builder (see useTraySync.ts) is what
    // recovers from this.
    const { store, unmount } = await setupHook(new Map([["halo", halo]]));

    const submenu = await getSubmenu();

    await waitFor(() => {
      const haloRow = submenu.items.find(
        (i) => typeof i === "object" && i !== null && "text" in i &&
          typeof (i as { text: string }).text === "string" &&
          (i as { text: string }).text.startsWith("Halo")
      );
      expect(haloRow).toBeDefined();
      expect((haloRow as { text: string }).text).toBe("Halo — Pause");
    });

    // No placeholder should remain.
    expect(
      submenu.items.some(
        (i) =>
          typeof i === "object" &&
          i !== null &&
          "text" in i &&
          (i as { text: string }).text === "(no sync folders)"
      )
    ).toBe(false);

    unmount();
    // Silence unused-var lint for `store` — it's returned for symmetry
    // with the other tests.
    void store;
  });

  it("adds a row when a drive is inserted into the atom after startup", async () => {
    const { store, unmount, driveStatusesAtom } = await setupHook();

    const submenu = await getSubmenu();

    // Initially empty: the placeholder should be present.
    await waitFor(() => {
      expect(
        submenu.items.some(
          (i) =>
            typeof i === "object" &&
            i !== null &&
            "text" in i &&
            (i as { text: string }).text === "(no sync folders)"
        )
      ).toBe(true);
    });

    // Simulate the hcfs_drive_status_changed event landing in the
    // atom after the menu-builder has finished.
    const halo: DriveEntryLike = {
      folderName: "Halo",
      path: "/Users/camden/Hippius/Halo",
      status: { kind: "active" },
    };
    act(() => {
      store.set(driveStatusesAtom, new Map([["halo", halo]]));
    });

    await waitFor(() => {
      expect(
        submenu.items.some(
          (i) =>
            typeof i === "object" &&
            i !== null &&
            "text" in i &&
            (i as { text: string }).text === "Halo — Pause"
        )
      ).toBe(true);
    });

    unmount();
  });

  it("removes a row when a drive is deleted from the atom", async () => {
    const halo: DriveEntryLike = {
      folderName: "Halo",
      path: "/Users/camden/Hippius/Halo",
      status: { kind: "active" },
    };
    const { store, driveStatusesAtom } = await setupHook(
      new Map([["halo", halo]])
    );

    const submenu = await getSubmenu();

    // Wait for the Halo row to appear.
    let haloRow: InstanceType<typeof mocks.MockMenuItem> | undefined;
    await waitFor(() => {
      haloRow = submenu.items.find(
        (i): i is InstanceType<typeof mocks.MockMenuItem> =>
          typeof i === "object" &&
          i !== null &&
          "text" in i &&
          (i as { text: string }).text === "Halo — Pause"
      );
      expect(haloRow).toBeDefined();
    });

    // Simulate hcfs_drive_removed landing in the atom.
    act(() => {
      store.set(driveStatusesAtom, new Map());
    });

    await waitFor(() => {
      expect(submenu.items).not.toContain(haloRow);
    });
  });

  it("flips a row from 'Pause' to 'Resume' when status transitions Active → Paused", async () => {
    const halo: DriveEntryLike = {
      folderName: "Halo",
      path: "/Users/camden/Hippius/Halo",
      status: { kind: "active" },
    };
    const { store, unmount, driveStatusesAtom } = await setupHook(
      new Map([["halo", halo]])
    );

    const submenu = await getSubmenu();

    let haloRow: InstanceType<typeof mocks.MockMenuItem> | undefined;
    await waitFor(() => {
      haloRow = submenu.items.find(
        (i): i is InstanceType<typeof mocks.MockMenuItem> =>
          typeof i === "object" &&
          i !== null &&
          "text" in i &&
          (i as { text: string }).text === "Halo — Pause"
      );
      expect(haloRow).toBeDefined();
    });

    // Simulate pause_drive: the same label flips to paused status.
    act(() => {
      store.set(
        driveStatusesAtom,
        new Map([
          [
            "halo",
            { ...halo, status: { kind: "paused" as const } },
          ],
        ])
      );
    });

    await waitFor(() => {
      expect(haloRow!.text).toBe("Halo — Resume");
    });

    // Flip back — Paused → Active.
    act(() => {
      store.set(driveStatusesAtom, new Map([["halo", halo]]));
    });

    await waitFor(() => {
      expect(haloRow!.text).toBe("Halo — Pause");
    });

    unmount();
  });
});

// ── Sync summary row race prevention ────────────────────────────────
//
// The tray watcher subscribes to `sync_progress_snapshot` events and
// inserts three summary rows into the root menu on demand:
//   - `sync-progress-summary` ("X of Y files synced/failed")
//   - `sync-size-info`        ("A / B" byte progress)
//   - `sync-delete-summary`   ("N files deleted")
//
// Before the mutex was added, each `tick()` had ~5 awaits against Tauri
// IPC. A snapshot storm during upload failure (one event per file × per
// retry × per byte-progress bump) interleaved multiple ticks, each
// observing the module-level ref as null and each inserting a fresh
// MenuItem. The module ref overwrote to the LAST one; earlier inserts
// leaked into the menu as orphan rows — exactly what the user screenshot
// shows: dozens of "1.11 GB" rows stacked under the "Sync Failed" header.
//
// This test drives the listener directly with snapshots whose signatures
// all differ (so the per-tick signature dedup doesn't short-circuit),
// then asserts the root menu has at most one row per summary ID.

describe("useTraySync — sync summary row race prevention", () => {
  type ListenCallback = (e: { payload: SyncSnapshot }) => void;

  /**
   * Teach the shared `invoke` mock to answer every command the tray
   * watcher and menu-builder use during this test. Anything unrecognized
   * returns `null` so regressions surface loudly.
   */
  function installInvokeMock() {
    vi.mocked(invoke).mockImplementation(
      (async (cmd: string) => {
        switch (cmd) {
          case "sp_get_snapshot":
            return { ...EMPTY_SNAPSHOT };
          case "get_tray_menu_data":
            return {
              loggedIn: true,
              credits: 100,
              substrateAddress: "addr",
            };
          default:
            return null;
        }
      }) as unknown as typeof invoke
    );
  }

  /**
   * Capture the `sync_progress_snapshot` listener so the test can drive
   * events directly. The hook also listens for other channels (none
   * today, but tolerate in case that changes) — returning a no-op
   * unlisten keeps the startup path happy.
   */
  function installListenMock(): { current: ListenCallback | null } {
    const capture: { current: ListenCallback | null } = { current: null };
    vi.mocked(listen).mockImplementation(
      (async (event: string, cb: ListenCallback) => {
        if (event === "sync_progress_snapshot") {
          capture.current = cb;
        }
        return () => {
          /* noop unsub */
        };
      }) as unknown as typeof listen
    );
    return capture;
  }

  /**
   * Build a snapshot with a failure state that matches the bug report:
   * 9 of 9 files failed, ~1.11 GB total. `progressBytes` varies so each
   * event has a distinct signature and the watcher can't short-circuit
   * via `lastSyncSummarySignature`.
   */
  function makeFailingSnapshot(
    progressBytes: number,
    startedAt: number
  ): SyncSnapshot {
    return {
      ...EMPTY_SNAPSHOT,
      isActive: false,
      totalFiles: 9,
      completedFiles: 0,
      failedFiles: 9,
      bytesExpected: 1_190_000_000,
      progressBytes,
      startedAt,
      completedAt: startedAt + 100,
      statusVariant: "error",
      effectiveCompleted: true,
      actualTotal: 9,
      files: Array.from({ length: 9 }, (_, i) => ({
        path: `f${i}.txt`,
        fileName: `f${i}.txt`,
        label: "default",
        action: "upload" as const,
        status: "error" as const,
        progressPercent: 0,
        bytesEncrypted: 0,
        bytesTransferred: 0,
        totalBytes: 132_222_222,
        error: "network",
      })),
    };
  }

  it("inserts at most one of each summary row under a snapshot storm", async () => {
    installInvokeMock();
    const listenerCapture = installListenMock();

    const { unmount } = await setupHook();

    // Wait for the menu-builder to finish and the watcher to register
    // its listener. `menuPromise` is resolved only after the builder
    // appends the drive submenu, which is an async tail of useTrayInit.
    await waitFor(() => {
      expect(listenerCapture.current).not.toBeNull();
      expect(menuRegistry.length).toBeGreaterThan(0);
    });

    const rootMenu = menuRegistry[0];
    const startedAt = Date.now();

    // Fire a storm of snapshots. Each call is `void tick(...)` inside
    // the real hook — we simulate that synchronously so multiple ticks
    // are in flight against the same module state at once. Without the
    // mutex each call sees the refs as null and inserts fresh rows.
    await act(async () => {
      for (let i = 0; i < 20; i++) {
        listenerCapture.current!({
          payload: makeFailingSnapshot(i, startedAt),
        });
      }
      // Yield the microtask queue enough times for every tick (original
      // + coalesced tail) to drain. 32 iterations covers the worst-case
      // ~5 awaits-per-tick × 20 ticks depth with headroom.
      for (let i = 0; i < 32; i++) {
        await Promise.resolve();
      }
    });

    await waitFor(async () => {
      const items = await rootMenu.items();
      const progressItems = items.filter(
        (i) =>
          typeof i === "object" &&
          i !== null &&
          "id" in i &&
          (i as { id?: string }).id === "sync-progress-summary"
      );
      const sizeItems = items.filter(
        (i) =>
          typeof i === "object" &&
          i !== null &&
          "id" in i &&
          (i as { id?: string }).id === "sync-size-info"
      );
      // The critical invariant: one row per summary ID, regardless of
      // how many events fired.
      expect(progressItems.length).toBeLessThanOrEqual(1);
      expect(sizeItems.length).toBeLessThanOrEqual(1);
    });

    unmount();
  });

  it("reconciles pre-existing duplicate rows by dropping all but one", async () => {
    installInvokeMock();
    const listenerCapture = installListenMock();

    const { unmount } = await setupHook();

    await waitFor(() => {
      expect(listenerCapture.current).not.toBeNull();
      expect(menuRegistry.length).toBeGreaterThan(0);
    });

    const rootMenu = menuRegistry[0];

    // Simulate corruption from a pre-fix release: multiple rows with the
    // same summary ID already in the menu. The reconciler on the next
    // tick must drop the duplicates without tearing down valid content.
    for (let i = 0; i < 5; i++) {
      const stub = new mocks.MockMenuItem({
        id: "sync-progress-summary",
        text: `stale ${i}`,
      });
      await rootMenu.append(stub);
    }
    for (let i = 0; i < 3; i++) {
      const stub = new mocks.MockMenuItem({
        id: "sync-size-info",
        text: `stale ${i}`,
      });
      await rootMenu.append(stub);
    }

    // Fire one snapshot — the dedup sweep runs at the top of every tick.
    await act(async () => {
      listenerCapture.current!({
        payload: makeFailingSnapshot(0, Date.now()),
      });
      for (let i = 0; i < 32; i++) {
        await Promise.resolve();
      }
    });

    await waitFor(async () => {
      const items = await rootMenu.items();
      const progressItems = items.filter(
        (i) =>
          typeof i === "object" &&
          i !== null &&
          "id" in i &&
          (i as { id?: string }).id === "sync-progress-summary"
      );
      const sizeItems = items.filter(
        (i) =>
          typeof i === "object" &&
          i !== null &&
          "id" in i &&
          (i as { id?: string }).id === "sync-size-info"
      );
      expect(progressItems.length).toBe(1);
      expect(sizeItems.length).toBe(1);
    });

    unmount();
  });
});

// ── Stalled completion in tray ──────────────────────────────────────
//
// hcfs-client's file watcher can detect the sync engine's own writes
// and set `changes_pending=true`, which pins `session.is_active=true`
// even after all files are synced. The Rust `fixup_stalled_completion`
// helper flips `effectiveInProgress`, `effectiveCompleted`,
// `widgetState`, and `status_variant` — but NOT `isActive`. If the
// tray reads `progress.isActive` directly, it stays stuck on
// "⟳ Syncing: 100%" forever. This test drives a stalled snapshot
// through the listener and asserts the tray transitions to
// "✓ Sync Complete".

describe("useTraySync — stalled completion shows Sync Complete", () => {
  type ListenCallback = (e: { payload: SyncSnapshot }) => void;

  function installInvokeMock() {
    vi.mocked(invoke).mockImplementation(
      (async (cmd: string) => {
        switch (cmd) {
          case "sp_get_snapshot":
            return { ...EMPTY_SNAPSHOT };
          case "get_tray_menu_data":
            return { loggedIn: true, credits: 100, substrateAddress: "addr" };
          default:
            return null;
        }
      }) as unknown as typeof invoke
    );
  }

  function installListenMock(): { current: ListenCallback | null } {
    const capture: { current: ListenCallback | null } = { current: null };
    vi.mocked(listen).mockImplementation(
      (async (event: string, cb: ListenCallback) => {
        if (event === "sync_progress_snapshot") {
          capture.current = cb;
        }
        return () => {
          /* noop unsub */
        };
      }) as unknown as typeof listen
    );
    return capture;
  }

  /**
   * Build a snapshot matching the production bug: 93/93 files fully
   * synced, overall 100%, but `isActive=true` because hcfs-client
   * never called `complete_session`. The Rust fixup has already
   * flipped the `effective*` fields and `widgetState`.
   */
  function makeStalledSnapshot(startedAt: number): SyncSnapshot {
    return {
      ...EMPTY_SNAPSHOT,
      isActive: true, // <-- the stall bug: stays true
      totalFiles: 93,
      completedFiles: 93,
      failedFiles: 0,
      overallPercent: 100,
      progressBytes: 1_180_000_000,
      bytesExpected: 1_180_000_000,
      startedAt,
      completedAt: null,
      widgetState: "completed",       // <-- fixup applied
      statusVariant: "success",       // <-- fixup applied
      effectiveInProgress: false,     // <-- fixup applied
      effectiveCompleted: true,       // <-- fixup applied
      syncedCount: 93,
      actualTotal: 93,
      files: Array.from({ length: 5 }, (_, i) => ({
        path: `f${i}.mkv`,
        fileName: `f${i}.mkv`,
        label: "default",
        action: "download" as const,
        status: "completed" as const,
        progressPercent: 100,
        bytesEncrypted: 200_000_000,
        bytesTransferred: 200_000_000,
        totalBytes: 200_000_000,
      })),
    };
  }

  it("renders '✓ Sync Complete' when isActive=true but effectiveCompleted=true", async () => {
    installInvokeMock();
    const listenerCapture = installListenMock();

    const { unmount } = await setupHook();

    await waitFor(() => {
      expect(listenerCapture.current).not.toBeNull();
      expect(menuRegistry.length).toBeGreaterThan(0);
    });

    const rootMenu = menuRegistry[0];

    await act(async () => {
      listenerCapture.current!({
        payload: makeStalledSnapshot(Date.now()),
      });
      for (let i = 0; i < 32; i++) {
        await Promise.resolve();
      }
    });

    await waitFor(async () => {
      const items = await rootMenu.items();
      const syncItem = items.find(
        (i) =>
          typeof i === "object" &&
          i !== null &&
          "id" in i &&
          (i as { id?: string }).id === "sync"
      ) as { text?: string } | undefined;
      expect(syncItem).toBeDefined();
      // The critical invariant: tray label reflects completion, not
      // "Syncing: 100%". Pre-fix this would fail because the tray
      // read `progress.isActive` directly, which the fixup leaves
      // as `true`.
      expect(syncItem!.text).toBe("✓ Sync Complete");
      expect(syncItem!.text).not.toContain("Syncing");
    });

    unmount();
  });
});

// ── Preparing state transitions ────────────────────────────────────
//
// The Rust `apply_preparing_override` flips `widgetState="preparing"`
// (and `widgetVisible=true`) on otherwise-invisible snapshots when a
// file-watcher-triggered sync cycle is between `SyncStarted` and its
// first session-populated snapshot. The tray must:
//   1. Treat `widgetState==="preparing"` as `isActive` so the icon
//      switches to the syncing variant.
//   2. UNLATCH any previously-latched "Sync Complete" so the label
//      transitions to "⟳ Preparing sync…" immediately instead of
//      sticking on the old completion for the several seconds
//      `scan_local_files`+`fetch_remote_state` runs.
//   3. Render "⟳ Preparing sync…" as the header label.
//
// Pre-fix the tray's `isActive` derivation read `effectiveInProgress
// || inProgressCount > 0 || (totalFiles > 0 && ...)`. For a preparing
// snapshot all three are false (the session is empty), so `isActive`
// stayed false, the latched completion never unwound, and the tray
// read "✓ Sync Complete" while the user was waiting for their newly-
// dropped folder to start uploading. This test pins the contract by
// sequencing a completed snapshot then a preparing snapshot and
// asserting the label flips.

describe("useTraySync — latched complete → preparing transitions", () => {
  type ListenCallback = (e: { payload: SyncSnapshot }) => void;

  function installInvokeMock() {
    vi.mocked(invoke).mockImplementation(
      (async (cmd: string) => {
        switch (cmd) {
          case "sp_get_snapshot":
            return { ...EMPTY_SNAPSHOT };
          case "get_tray_menu_data":
            return { loggedIn: true, credits: 100, substrateAddress: "addr" };
          default:
            return null;
        }
      }) as unknown as typeof invoke
    );
  }

  function installListenMock(): { current: ListenCallback | null } {
    const capture: { current: ListenCallback | null } = { current: null };
    vi.mocked(listen).mockImplementation(
      (async (event: string, cb: ListenCallback) => {
        if (event === "sync_progress_snapshot") {
          capture.current = cb;
        }
        return () => {
          /* noop unsub */
        };
      }) as unknown as typeof listen
    );
    return capture;
  }

  /**
   * Build a "completed sync" snapshot that the tray will latch (so
   * subsequent empty snapshots don't immediately tear down the row
   * set — see the existing latch logic in useTraySync.ts).
   */
  function makeCompletedSnapshot(startedAt: number): SyncSnapshot {
    return {
      ...EMPTY_SNAPSHOT,
      isActive: false,
      totalFiles: 5,
      completedFiles: 5,
      failedFiles: 0,
      overallPercent: 100,
      progressBytes: 100,
      bytesExpected: 100,
      startedAt,
      completedAt: startedAt + 100,
      widgetVisible: true,
      widgetState: "completed",
      statusVariant: "success",
      effectiveInProgress: false,
      effectiveCompleted: true,
      syncedCount: 5,
      actualTotal: 5,
    };
  }

  /**
   * Build a "preparing" snapshot — empty session, but the Rust
   * override has flipped `widgetVisible=true` and
   * `widgetState="preparing"` so the tray knows a file-watcher cycle
   * has begun. `startedAt=null` mirrors production: at the moment
   * `SyncStarted` fires the runner has not yet created a progress
   * session, so the snapshot has no `started_at` to compare against.
   */
  function makePreparingSnapshot(): SyncSnapshot {
    return {
      ...EMPTY_SNAPSHOT,
      isActive: false,
      totalFiles: 0,
      completedFiles: 0,
      failedFiles: 0,
      overallPercent: 0,
      progressBytes: 0,
      bytesExpected: 0,
      startedAt: null,
      completedAt: null,
      widgetVisible: true,
      widgetState: "preparing",
      statusVariant: "progress",
      effectiveInProgress: false,
      effectiveCompleted: false,
    };
  }

  it("flips tray label from '✓ Sync Complete' to '⟳ Preparing sync…' when a Finder-add lands after a completion", async () => {
    installInvokeMock();
    const listenerCapture = installListenMock();

    const { unmount } = await setupHook();

    await waitFor(() => {
      expect(listenerCapture.current).not.toBeNull();
      expect(menuRegistry.length).toBeGreaterThan(0);
    });

    const rootMenu = menuRegistry[0];

    // Step 1: drive the tray to the latched-complete state. The
    // listener fans this snapshot into `updateTraySyncLabel` which
    // writes the header MenuItem; the latch capture also fires.
    await act(async () => {
      listenerCapture.current!({
        payload: makeCompletedSnapshot(Date.now()),
      });
      for (let i = 0; i < 32; i++) {
        await Promise.resolve();
      }
    });

    await waitFor(async () => {
      const items = await rootMenu.items();
      const syncItem = items.find(
        (i) =>
          typeof i === "object" &&
          i !== null &&
          "id" in i &&
          (i as { id?: string }).id === "sync"
      ) as { text?: string } | undefined;
      expect(syncItem?.text).toBe("✓ Sync Complete");
    });

    // Step 2: simulate the user dropping a folder via Finder. The
    // Rust bridge fires SyncStarted → preparing.mark_preparing → an
    // immediate emit_snapshot. That snapshot lands on the listener
    // here with widgetState="preparing".
    await act(async () => {
      listenerCapture.current!({ payload: makePreparingSnapshot() });
      for (let i = 0; i < 32; i++) {
        await Promise.resolve();
      }
    });

    // Step 3: the tray label must transition. Both invariants are
    // load-bearing: the new label must be the preparing one, and the
    // OLD "Sync Complete" must not still be showing (the bug shape
    // before this fix).
    await waitFor(async () => {
      const items = await rootMenu.items();
      const syncItem = items.find(
        (i) =>
          typeof i === "object" &&
          i !== null &&
          "id" in i &&
          (i as { id?: string }).id === "sync"
      ) as { text?: string } | undefined;
      expect(syncItem?.text).toBe("⟳ Preparing sync…");
      expect(syncItem?.text).not.toContain("Sync Complete");
    });

    unmount();
  });

  /**
   * Regression: a no-op periodic sync cycle (nothing to upload —
   * `Computed sync plan uploads=0 downloads=0`) emits SyncStarted
   * (→ a brief "preparing" snapshot) then SyncCompleted, whose bridge
   * arm clears the preparing set and emits a fresh, fully-idle
   * snapshot (no session: widgetState!="preparing", totalFiles=0,
   * completedFiles=0). `isCompleted` is false (nothing was synced) so
   * the tray falls into the idle-teardown branch. That branch must
   * also clear the sync HEADER — otherwise the "⟳ Preparing sync…"
   * text set during the ~1s SyncStarted window is frozen in the tray
   * forever (re-set, never cleared, every periodic cycle). This is
   * the user-reported "stuck on Preparing sync… but nothing is
   * syncing" bug.
   */
  function makeIdleSnapshot(): SyncSnapshot {
    return {
      ...EMPTY_SNAPSHOT,
      isActive: false,
      totalFiles: 0,
      completedFiles: 0,
      failedFiles: 0,
      overallPercent: 0,
      progressBytes: 0,
      bytesExpected: 0,
      startedAt: null,
      completedAt: null,
      widgetVisible: false,
      widgetState: "idle",
      statusVariant: "progress",
      effectiveInProgress: false,
      effectiveCompleted: false,
    };
  }

  it("clears the tray header after a no-op cycle's idle snapshot (not stuck on 'Preparing sync…')", async () => {
    installInvokeMock();
    const listenerCapture = installListenMock();

    const { unmount } = await setupHook();

    await waitFor(() => {
      expect(listenerCapture.current).not.toBeNull();
      expect(menuRegistry.length).toBeGreaterThan(0);
    });

    const rootMenu = menuRegistry[0];

    // SyncStarted of a no-op cycle → preparing override snapshot.
    await act(async () => {
      listenerCapture.current!({ payload: makePreparingSnapshot() });
      for (let i = 0; i < 32; i++) {
        await Promise.resolve();
      }
    });

    await waitFor(async () => {
      const items = await rootMenu.items();
      const syncItem = items.find(
        (i) =>
          typeof i === "object" &&
          i !== null &&
          "id" in i &&
          (i as { id?: string }).id === "sync"
      ) as { text?: string } | undefined;
      expect(syncItem?.text).toBe("⟳ Preparing sync…");
    });

    // SyncCompleted of the no-op cycle → bridge cleared preparing and
    // emitted a fully-idle snapshot. The tray must remove the sync
    // header (no "sync" item), exactly as the logout cleanup path
    // does via updateTraySyncLabel(null).
    await act(async () => {
      listenerCapture.current!({ payload: makeIdleSnapshot() });
      for (let i = 0; i < 32; i++) {
        await Promise.resolve();
      }
    });

    await waitFor(async () => {
      const items = await rootMenu.items();
      const syncItem = items.find(
        (i) =>
          typeof i === "object" &&
          i !== null &&
          "id" in i &&
          (i as { id?: string }).id === "sync"
      ) as { text?: string } | undefined;
      expect(syncItem).toBeUndefined();
    });

    unmount();
  });
});
