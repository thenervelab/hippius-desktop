import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EMPTY_SNAPSHOT } from "@/app/lib/types/syncSnapshot";
import { useTrayPanelData } from "@/app/lib/tray/useTrayPanelData";

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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    switch (cmd) {
      case "get_tray_menu_data":
        return Promise.resolve(menuResult);
      case "sp_get_snapshot":
        return Promise.resolve(EMPTY_SNAPSHOT);
      case "get_recent_uploads":
        return Promise.resolve([]);
      case "get_unread_count":
        return Promise.resolve(0);
      default:
        return Promise.resolve(undefined);
    }
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
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
