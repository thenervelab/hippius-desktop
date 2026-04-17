import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";
import type { Store } from "jotai";

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

// `useTraySync` pulls VPN + login-status helpers in at import time.
// None of them matter for these tests — stub to no-ops / safe defaults.
vi.mock("@/components/dashboard-title-wrapper/vpn-menu/nebula-utils", () => ({
  getVpnStatus: vi.fn(async () => false),
  toggleVpnStatus: vi.fn(async () => false),
}));

vi.mock("@/components/dashboard-title-wrapper/vpn-menu/vpnAtoms", () => ({
  vpnConnectedAtom: { init: false, read: () => false, write: () => {} },
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
function mockAppStoreAs(store: Store) {
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

beforeEach(() => {
  submenuRegistry.length = 0;
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

