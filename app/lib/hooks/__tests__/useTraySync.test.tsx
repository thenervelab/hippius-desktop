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
  const trayCloseCalls: number[] = [];
  const setIconCalls: string[] = [];
  const invokeCmds: string[] = [];
  const invokeCalls: { cmd: string; args: unknown }[] = [];
  const setMenuCalls: { items?: { text: string }[] }[] = [];
  const windowActions: string[] = [];
  const listenedEvents: string[] = [];
  let snapshotListener: ((e: { payload: unknown }) => void) | null = null;
  let releasedListener: ((e: { payload: unknown }) => void) | null = null;

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
      trayCloseCalls.push(Date.now());
      MockTrayIcon.current = null;
    }
    async setMenu(m: { items?: { text: string }[] }) {
      setMenuCalls.push(m);
    }
  }

  return {
    MockMenuItem,
    MockPredefinedMenuItem,
    MockMenu,
    MockTrayIcon,
    trayNewCalls,
    trayCloseCalls,
    setIconCalls,
    invokeCmds,
    invokeCalls,
    setMenuCalls,
    windowActions,
    listenedEvents,
    SYNCING_SNAPSHOT,
    setSnapshotListener: (h: (e: { payload: unknown }) => void) => {
      snapshotListener = h;
    },
    getSnapshotListener: () => snapshotListener,
    setReleasedListener: (h: (e: { payload: unknown }) => void) => {
      releasedListener = h;
    },
    getReleasedListener: () => releasedListener,
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
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    mocks.invokeCmds.push(cmd);
    mocks.invokeCalls.push({ cmd, args });
    if (cmd === "get_tray_menu_data") {
      return { loggedIn: true, credits: 5, substrateAddress: "addr" };
    }
    if (cmd === "sp_get_snapshot") return mocks.SYNCING_SNAPSHOT;
    return undefined;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    mocks.listenedEvents.push(event);
    if (event === "sync_progress_snapshot") mocks.setSnapshotListener(handler);
    if (event === "capture_tray_icon_released") mocks.setReleasedListener(handler);
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

async function mountTray(
  isAuth = true,
  opts: { failSetIconOnce?: boolean; existingTray?: boolean } = {},
) {
  vi.resetModules();
  mocks.trayNewCalls.length = 0;
  mocks.trayCloseCalls.length = 0;
  mocks.setIconCalls.length = 0;
  mocks.invokeCmds.length = 0;
  mocks.invokeCalls.length = 0;
  mocks.setMenuCalls.length = 0;
  mocks.windowActions.length = 0;
  mocks.listenedEvents.length = 0;
  // `existingTray`: the page reloaded under an icon the previous page made.
  mocks.MockTrayIcon.current = opts.existingTray ? new mocks.MockTrayIcon() : null;
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

/** What the page told Rust about sign-in, in order. */
function signedInReports(): unknown[] {
  return mocks.invokeCalls.filter((c) => c.cmd === "tray_set_signed_in").map((c) => c.args);
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

describe("useTrayInit: after a recording's mark", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Windows: Rust draws a recording dot on the icon and puts the plain icon
  // back when the recording ends. Only this page knows a sync was running,
  // so it paints its own icon again, even though it asked for that one
  // before the recording.
  it("puts its own sync icon back when Rust releases the icon", async () => {
    await mountTray();
    await waitFor(() => expect(mocks.setIconCalls.some((p) => p.includes("Syncing"))).toBe(true));
    await waitFor(() => expect(mocks.getReleasedListener()).toBeTruthy());
    const before = mocks.setIconCalls.length;
    mocks.getReleasedListener()!({ payload: null });
    await waitFor(() => expect(mocks.setIconCalls.length).toBe(before + 1));
    expect(mocks.setIconCalls[mocks.setIconCalls.length - 1]).toContain("Syncing");
    // macOS and Windows keep their menu through a recording.
    expect(mocks.setMenuCalls.length).toBe(0);
  });

  // Linux: Rust put the recording's own menu (Stop, Pause, Show) on the icon,
  // since AppIndicator sends no click; at the end this page's menu comes back.
  it("puts its own menu back on Linux when Rust releases the icon", async () => {
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64) webkit2gtk");
    await mountTray();
    await waitFor(() => expect(mocks.getReleasedListener()).toBeTruthy());
    await waitFor(() => expect(mocks.trayNewCalls.length).toBe(1));
    mocks.getReleasedListener()!({ payload: null });
    await waitFor(() => expect(mocks.setMenuCalls.length).toBe(1));
    const texts = (mocks.setMenuCalls[0].items ?? []).map((i) => i.text);
    expect(texts[0]).toBe("Open Hippius");
    expect(texts).toContain("Quit Hippius");
    // Reported like every attach, so a recording started meanwhile gets its
    // own menu back from Rust.
    await waitFor(() =>
      expect(mocks.invokeCmds.filter((c) => c === "tray_menu_attached").length).toBe(2),
    );
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

  // The popover stopped opening: the click went to a callback this page gave
  // the icon, and a reload of the page left that callback dead. Rust receives
  // the click itself; the page only says who is signed in.
  it("gives the icon no click callback of its own", async () => {
    await mountTray(true);
    await waitFor(() => expect(mocks.trayNewCalls.length).toBe(1));
    expect(mocks.trayNewCalls[0].action).toBeUndefined();
  });

  it("reports sign-in to Rust, and again when it changes", async () => {
    const hook = await mountTray(true);
    await waitFor(() => expect(signedInReports()).toEqual([{ signedIn: true }]));
    hook.rerender({ isAuth: false });
    await waitFor(() => expect(signedInReports()).toEqual([{ signedIn: true }, { signedIn: false }]));
  });

  // Rust owns the recording's part in the tray (title and click): the
  // webview's copy of the phase once went stale and left the time stuck.
  it("never opens the popover or reads the capture phase itself", async () => {
    await mountTray(true);
    await waitFor(() => expect(mocks.trayNewCalls.length).toBe(1));
    expect(mocks.invokeCmds).not.toContain("toggle_tray_panel");
    expect(mocks.invokeCmds).not.toContain("capture_stop");
    expect(mocks.invokeCmds).not.toContain("capture_state");
    expect(mocks.listenedEvents).not.toContain("capture_state_changed");
    expect(mocks.windowActions).not.toContain("openApp");
  });
});

describe("useTrayInit: the context menu is handed to Rust", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** How many times the page told Rust it attached a menu. */
  const menuReports = () =>
    mocks.invokeCmds.filter((c) => c === "tray_menu_attached").length;

  // On macOS a status item that owns a menu opens it on every click, so a
  // left click never reached Rust and the popover never opened. Rust takes
  // the menu off the status item, but only once told it is there: every
  // attach must be reported.
  it("reports the menu the new icon carries", async () => {
    await mountTray(true);
    await waitFor(() => expect(mocks.trayNewCalls.length).toBe(1));
    await waitFor(() => expect(menuReports()).toBe(1));
  });

  it("reports the menu of an icon recreated after a failed icon update", async () => {
    await mountTray(true, { failSetIconOnce: true });
    await waitFor(() => expect(mocks.trayNewCalls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(menuReports()).toBe(mocks.trayNewCalls.length));
  });
});

describe("useTrayInit: a reload under a live icon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The old page's menu items called back into a page that is gone, and the
  // icon's look (sync icon, Rust's recording marks) is unknown to this one:
  // the icon is replaced, and the new one reported so Rust takes its menu off
  // the macOS status item and puts a running recording's marks back on it.
  it("replaces the icon with a fresh one and reports it", async () => {
    await mountTray(true, { existingTray: true });
    await waitFor(() => expect(mocks.trayNewCalls.length).toBe(1));
    expect(mocks.trayCloseCalls.length).toBe(1);
    expect(mocks.trayNewCalls[0].action).toBeUndefined();
    const texts = (mocks.trayNewCalls[0].menu?.items ?? []).map((i) => i.text);
    expect(texts).toContain("Quit Hippius");
    await waitFor(() =>
      expect(mocks.invokeCmds.filter((c) => c === "tray_menu_attached").length).toBe(1),
    );
    expect(signedInReports()).toEqual([{ signedIn: true }]);
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
