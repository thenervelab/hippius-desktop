import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EMPTY_SNAPSHOT } from "@/app/lib/types/syncSnapshot";
import { useTrayPanelData } from "@/app/lib/tray/useTrayPanelData";
import { invoke } from "@tauri-apps/api/core";

// ── Tauri mocks ─────────────────────────────────────────────────────
//
// The popover hook talks to the backend only through raw invoke/listen and
// the window focus listener. Each test seeds what get_tray_menu_data returns.

let menuResult: {
  loggedIn: boolean;
  credits: number | null;
  substrateAddress: string | null;
  sessionReady: boolean;
};

let chatUnreadSeed = 0;

let capturesResult: unknown = { label: null, files: [] };

// The Captures tab ships behind the capture flag.
const flags = vi.hoisted(() => ({ capture: true }));
vi.mock("@/app/lib/featureFlags", () => ({
  get SCREEN_CAPTURE_ENABLED() {
    return flags.capture;
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    switch (cmd) {
      case "get_tray_menu_data":
        return Promise.resolve(menuResult);
      case "sp_get_snapshot":
        return Promise.resolve(EMPTY_SNAPSHOT);
      case "get_recent_uploads":
        return Promise.resolve([]);
      case "get_recent_captures":
        return capturesResult instanceof Error
          ? Promise.reject(capturesResult)
          : Promise.resolve(capturesResult);
      case "get_unread_count":
        return Promise.resolve(0);
      case "chat_get_unread_count":
        return Promise.resolve(chatUnreadSeed);
      default:
        return Promise.resolve(undefined);
    }
  }),
}));

// Backend event handlers by name, so a test can deliver a broadcast.
const eventHandlers = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (name: string, handler: (event: { payload: unknown }) => void) => {
      eventHandlers.set(name, handler);
      return Promise.resolve(() => {
        eventHandlers.delete(name);
      });
    },
  ),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: () => Promise.resolve(() => {}),
  }),
}));

describe("useTrayPanelData loading gate (F-3)", () => {
  beforeEach(() => {
    menuResult = {
      loggedIn: true,
      credits: null,
      substrateAddress: "5EZi38SomeAddrLvJs",
      sessionReady: false,
    };
  });

  it("clears loading (shows empty state, not an infinite skeleton) when a logged-in session never hydrates", async () => {
    const { result } = renderHook(() => useTrayPanelData());

    // Mount refresh ran once (boot-gap grace) — skeleton still up.
    await waitFor(() => expect(result.current.menu?.sessionReady).toBe(false));
    expect(result.current.loading).toBe(true);

    // A second not-ready refresh crosses the grace cap → drop the skeleton so
    // the popover renders its empty state instead of hanging forever.
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.feed).toHaveLength(0);
  });

  it("clears loading immediately once the session is ready (the already-working path)", async () => {
    menuResult = {
      loggedIn: true,
      credits: 5,
      substrateAddress: "5EZi38SomeAddrLvJs",
      sessionReady: true,
    };
    const { result } = renderHook(() => useTrayPanelData());

    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});

// The popover is a separate webview: it seeds the chat count from Rust's
// remembered value (a message that arrived before this window listened would
// otherwise be missed) and then follows the cross-window broadcast — the same
// number Rust puts on the dock badge and in the window title.
describe("useTrayPanelData chat unread", () => {
  beforeEach(() => {
    eventHandlers.clear();
    chatUnreadSeed = 4;
    menuResult = {
      loggedIn: true,
      credits: 5,
      substrateAddress: "5EZi38SomeAddrLvJs",
      sessionReady: true,
    };
  });

  it("seeds from chat_get_unread_count and follows chat_unread_changed", async () => {
    const { result } = renderHook(() => useTrayPanelData());
    await waitFor(() => expect(result.current.chatUnread).toBe(4));

    await waitFor(() =>
      expect(eventHandlers.has("chat_unread_changed")).toBe(true),
    );
    act(() => {
      eventHandlers.get("chat_unread_changed")?.({ payload: { count: 0 } });
    });
    expect(result.current.chatUnread).toBe(0);
  });
});

// The Captures tab lists what Rust calls captures (`get_recent_captures`),
// as finished rows; the popover never decides it.
describe("useTrayPanelData captures", () => {
  const shot = {
    name: "Screenshot 1.png",
    actualFileName: "Screenshot 1.png",
    size: 10,
    createdAt: 1,
    arionHash: "p",
    arionCid: "c",
    fileId: "f",
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    source: "",
    syncStatus: "synced",
    label: "Captures",
  };

  beforeEach(() => {
    flags.capture = true;
    capturesResult = { label: "Captures", files: [shot] };
    vi.mocked(invoke).mockClear();
    menuResult = {
      loggedIn: true,
      credits: 5,
      substrateAddress: "5EZi38SomeAddrLvJs",
      sessionReady: true,
    };
  });

  it("asks Rust for the account's captures and lists them as finished rows", async () => {
    const { result } = renderHook(() => useTrayPanelData());
    await waitFor(() => expect(result.current.captures).toHaveLength(1));
    expect(result.current.captures[0]).toMatchObject({ name: "Screenshot 1.png", feedStatus: "completed" });
    expect(invoke).toHaveBeenCalledWith("get_recent_captures", {
      accountId: "5EZi38SomeAddrLvJs",
      limit: 10,
    });
  });

  it("shows no captures, and keeps the rest, when Rust could not list them", async () => {
    capturesResult = new Error("offline");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() => useTrayPanelData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.captures).toEqual([]);
    error.mockRestore();
  });

  it("does not ask where the lane has capture off", async () => {
    flags.capture = false;
    const { result } = renderHook(() => useTrayPanelData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(invoke).not.toHaveBeenCalledWith("get_recent_captures", expect.anything());
    expect(result.current.captures).toEqual([]);
  });
});
