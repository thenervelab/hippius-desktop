import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useTrayLinkActivity } from "../useTrayLinkActivity";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
const handlers = new Map<string, () => void>();
vi.mock("@/app/lib/utils/tauriListeners", () => ({
  onTauriEvent: (event: string, handler: () => void) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
}));

const ROW = { id: 1, shareToken: "tok", line: "1 new view on deck.pdf", at: 1 };

describe("useTrayLinkActivity", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    handlers.clear();
  });

  it("reads nothing before the session is ready", () => {
    renderHook(() => useTrayLinkActivity(false));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reads the last three, again when Rust saves one, and keeps them when a read fails", async () => {
    invokeMock.mockResolvedValueOnce([ROW]);
    const { result } = renderHook(() => useTrayLinkActivity(true));
    await waitFor(() => expect(result.current).toEqual([ROW]));
    expect(invokeMock).toHaveBeenCalledWith("link_activity_recent", { limit: 3 });

    const newer = { ...ROW, id: 2, line: "2 new views on deck.pdf" };
    invokeMock.mockResolvedValueOnce([newer, ROW]);
    act(() => handlers.get("hippius:link-activity-changed")?.());
    await waitFor(() => expect(result.current).toEqual([newer, ROW]));

    invokeMock.mockRejectedValueOnce(new Error("offline"));
    act(() => handlers.get("hippius:tray-panel-shown")?.());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3));
    expect(result.current).toEqual([newer, ROW]);
  });
});
