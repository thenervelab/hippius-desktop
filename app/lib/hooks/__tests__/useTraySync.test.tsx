import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, configure } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import React from "react";

// These tests assert through a long async chain (mount → init effect →
// snapshot watcher → IPC → setIcon), so allow generous async-util time —
// the default 1s can flake on a loaded CI runner.
configure({ asyncUtilTimeout: 5000 });

// ── Mock infrastructure ─────────────────────────────────────────────
//
// `useTraySync` is thin Tauri glue: it builds the right-click context menu,
// attaches one tray icon, and drives that icon's artwork from sync snapshots.
// The icon DECISION logic is unit-tested in `tray/trayIconState.test.ts`; these
// tests pin the glue — that the attached menu carries the expected entries and
// that a snapshot actually reaches `setIcon`.

type TrayNewOpts = {
  menu?: { items?: { text: string }[] };
  action?: (e: unknown) => void | Promise<void>;
};

const mocks = vi.hoisted(() => {
  const trayNewCalls: TrayNewOpts[] = [];
  const setIconCalls: string[] = [];
  const invokeCmds: string[] = [];
  const windowActions: string[] = [];
  let snapshotListener: ((e: { payload: unknown }) => void) | null = null;

  // A syncing snapshot — only the fields `deriveTrayIconState` reads matter.
  const SYNCING_SNAPSHOT = {
    files: [{ action: "upload", status: "inProgress" }],
    widgetState: "active",
    effectiveInProgress: true,
    totalFiles: 3,
    completedFiles: 1,
    failedFiles: 0,
    overallPercent: 33,
    progressBytes: 100,
    startedAt: 1000,
  };

  class MockMenuItem {
    id?: string;
    text: string;
    enabled: boolean;
    constructor(o: { id?: string; text: string; enabled?: boolean }) {
      this.id = o.id;
      this.text = o.text;
      this.enabled = o.enabled ?? true;
    }
    static async new(o: { id?: string; text: string; enabled?: boolean }) {
      return new MockMenuItem(o);
    }
    async setText(t: string) {
      this.text = t;
    }
    async setEnabled(e: boolean) {
      this.enabled = e;
    }
  }
  class MockPredefinedMenuItem {
    text = "—separator—";
    static async new() {
      return new MockPredefinedMenuItem();
    }
  }
  class MockMenu {
    items: { text: string }[];
    constructor(o?: { items?: { text: string }[] }) {
      this.items = o?.items ? [...o.items] : [];
    }
    static async new(o?: { items?: { text: string }[] }) {
      return new MockMenu(o);
    }
  }
  class MockTrayIcon {
    // Mirrors the real registry: `getById` returns the live icon once created,
    // so `setTrayIconSyncing` takes its `setIcon` path instead of recreating.
    static current: MockTrayIcon | null = null;
    static failSetIconOnce = false;
    static async getById() {
      return MockTrayIcon.current;
    }
    static async new(o: TrayNewOpts) {
      trayNewCalls.push(o);
      MockTrayIcon.current = new MockTrayIcon();
      return MockTrayIcon.current;
    }
    async setIcon(p: string) {
      if (MockTrayIcon.failSetIconOnce) {
        MockTrayIcon.failSetIconOnce = false;
        throw new Error("setIcon failed");
      }
      setIconCalls.push(p);
    }
    async close() {
      MockTrayIcon.current = null;
    }
  }

  return {
    MockMenuItem,
    MockPredefinedMenuItem,
    MockMenu,
    MockTrayIcon,
    trayNewCalls,
    setIconCalls,
    invokeCmds,
    windowActions,
    SYNCING_SNAPSHOT,
    setSnapshotListener: (h: (e: { payload: unknown }) => void) => {
      snapshotListener = h;
    },
    getSnapshotListener: () => snapshotListener,
  };
});

vi.mock("@tauri-apps/api/menu", () => ({
  MenuItem: mocks.MockMenuItem,
  PredefinedMenuItem: mocks.MockPredefinedMenuItem,
  Menu: mocks.MockMenu,
}));

vi.mock("@tauri-apps/api/tray", () => ({ TrayIcon: mocks.MockTrayIcon }));

vi.mock("@tauri-apps/api/path", () => ({
  resolveResource: vi.fn(async (p: string) => `/resolved/${p}`),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    mocks.invokeCmds.push(cmd);
    if (cmd === "get_tray_menu_data") {
      return { loggedIn: true, credits: 5, substrateAddress: "addr" };
    }
    if (cmd === "sp_get_snapshot") return mocks.SYNCING_SNAPSHOT;
    return undefined;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: (e: { payload: unknown }) => void) => {
    mocks.setSnapshotListener(handler);
    return () => {
      /* noop unlisten */
    };
  }),
}));

vi.mock("@/app/lib/tray/trayWindowActions", () => ({
  openAppWindow: vi.fn(async () => {
    mocks.windowActions.push("openApp");
  }),
  openFilesPage: vi.fn(async () => {
    mocks.windowActions.push("openFiles");
  }),
  openVirtualMachinesPage: vi.fn(async () => {
    mocks.windowActions.push("openVm");
  }),
}));

async function mountTray(isAuth = true, opts: { failSetIconOnce?: boolean } = {}) {
  vi.resetModules();
  mocks.trayNewCalls.length = 0;
  mocks.setIconCalls.length = 0;
  mocks.invokeCmds.length = 0;
  mocks.windowActions.length = 0;
  mocks.MockTrayIcon.current = null;
  mocks.MockTrayIcon.failSetIconOnce = opts.failSetIconOnce ?? false;

  const store = createStore();
  const { useTrayInit } = await import("../useTraySync");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return renderHook(({ isAuth }: { isAuth: boolean }) => useTrayInit(isAuth), {
    wrapper,
    initialProps: { isAuth },
  });
}

/** Wait for the tray to be created and return the captured `action` closure. */
async function trayAction(): Promise<(e: unknown) => void | Promise<void>> {
  await waitFor(() => expect(mocks.trayNewCalls.length).toBe(1));
  const action = mocks.trayNewCalls[0].action;
  if (!action) throw new Error("tray action not attached");
  return action;
}

function leftClick() {
  return {
    type: "Click",
    button: "Left",
    buttonState: "Up",
    rect: { position: { x: 1, y: 2 }, size: { width: 3, height: 4 } },
  };
}

/**
 * Set `navigator.userAgent` deterministically. `userAgent` lives on the
 * prototype (no own property), so a per-test override here — reset before every
 * test below — is what keeps `detectLinuxPlatform()` order-independent. Without
 * it, the Linux test's UA leaked into later tests under CI's execution order.
 */
function setUserAgent(ua: string) {
  Object.defineProperty(globalThis.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

const NON_LINUX_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X) WKWebView";

// Default every test to a non-Linux UA; the Linux test opts in explicitly.
beforeEach(() => {
  setUserAgent(NON_LINUX_UA);
});

describe("useTrayInit — tray creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches a single right-click context menu with Open Drive and Quit", async () => {
    await mountTray();

    await waitFor(() => {
      expect(mocks.trayNewCalls.length).toBe(1);
    });

    const attachedMenu = mocks.trayNewCalls[0].menu;
    const texts = (attachedMenu?.items ?? []).map((i) => i.text);
    expect(texts).toContain("Open Drive");
    expect(texts).toContain("Quit Hippius");
    // The popover owns "Open Hippius" on macOS/Windows, so the context menu
    // must NOT carry its own (Linux is the only platform that adds it).
    expect(texts).not.toContain("Open Hippius");
  });

  it("drives the tray icon from the seeded sync snapshot", async () => {
    await mountTray();

    // The init seed (`sp_get_snapshot` → a syncing snapshot) must reach
    // `setIcon`, proving the watcher → deriveTrayIconState → setTrayIconSyncing
    // chain is wired through the hook.
    await waitFor(() => {
      expect(mocks.setIconCalls.length).toBeGreaterThan(0);
    });
    expect(mocks.setIconCalls.some((p) => p.includes("Syncing"))).toBe(true);
  });

  it("repaints the icon when a completed snapshot is pushed", async () => {
    await mountTray();
    await waitFor(() => expect(mocks.getSnapshotListener()).toBeTruthy());

    mocks.getSnapshotListener()!({
      payload: {
        files: [],
        widgetState: "completed",
        effectiveInProgress: false,
        totalFiles: 3,
        completedFiles: 3,
        failedFiles: 0,
        overallPercent: 100,
        progressBytes: 300,
        startedAt: 1000,
      },
    });

    await waitFor(() => {
      expect(mocks.setIconCalls.some((p) => p.includes("Completed"))).toBe(true);
    });
  });
});

describe("useTrayInit — icon update resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recreates the tray when setIcon throws", async () => {
    // The seeded syncing snapshot drives setTrayIconSyncing → setIcon, which
    // fails once, forcing the recreate-the-tray fallback. A second TrayIcon.new
    // (with a freshly built context menu) is the observable outcome.
    await mountTray(true, { failSetIconOnce: true });

    await waitFor(() => {
      expect(mocks.trayNewCalls.length).toBeGreaterThanOrEqual(2);
    });
    // The recreated icon still carries the right-click context menu.
    const recreated = mocks.trayNewCalls[mocks.trayNewCalls.length - 1];
    const texts = (recreated.menu?.items ?? []).map((i) => i.text);
    expect(texts).toContain("Quit Hippius");
  });
});

describe("useTrayInit — tray click", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("toggles the popover on an authenticated left-click", async () => {
    await mountTray(true);
    const action = await trayAction();
    await action(leftClick());
    expect(mocks.invokeCmds).toContain("toggle_tray_panel");
    expect(mocks.windowActions).not.toContain("openApp");
  });

  it("reveals the main window on a left-click while signed out", async () => {
    await mountTray(false);
    const action = await trayAction();
    await action(leftClick());
    expect(mocks.windowActions).toContain("openApp");
    expect(mocks.invokeCmds).not.toContain("toggle_tray_panel");
  });

  it("ignores non-left clicks", async () => {
    await mountTray(true);
    const action = await trayAction();
    await action({ ...leftClick(), button: "Right" });
    expect(mocks.invokeCmds).not.toContain("toggle_tray_panel");
    expect(mocks.windowActions).not.toContain("openApp");
  });
});

describe("useTrayInit — Linux context menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("leads the menu with Open Hippius on Linux", async () => {
    // Overrides the top-level non-Linux default for this test only; the next
    // test's top-level beforeEach resets it.
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64) webkit2gtk");

    await mountTray(true);
    await waitFor(() => expect(mocks.trayNewCalls.length).toBe(1));

    const texts = (mocks.trayNewCalls[0].menu?.items ?? []).map((i) => i.text);
    expect(texts[0]).toBe("Open Hippius");
    // On Linux the menu shows on left-click.
    expect(
      (mocks.trayNewCalls[0] as { showMenuOnLeftClick?: boolean })
        .showMenuOnLeftClick,
    ).toBe(true);
  });
});
