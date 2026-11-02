import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { ShareSummary } from "@/app/lib/tauri/shares";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { useTrayShareLinks } from "../useTrayShareLinks";

let listing: ShareSummary[] | Error = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === "hcfs_list_shares"
      ? listing instanceof Error
        ? Promise.reject(listing)
        : Promise.resolve(listing)
      : Promise.resolve(undefined),
  ),
}));

const eventHandlers = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    eventHandlers.set(name, handler);
    return Promise.resolve(() => eventHandlers.delete(name));
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: () => Promise.resolve(() => {}) }),
}));

const NAME = "Recording 2026-10-30 at 11.09.18.mp4";

/** A link made in the web console: no origin on this computer. */
const consoleLink: ShareSummary = {
  shareToken: "web",
  filename: NAME,
  plaintextSize: 320870,
  ciphertextSize: 320900,
  mimeType: "video/mp4",
  createdAt: "2026-10-30T09:00:00Z",
  expiresAt: null,
  shareUrl: "https://console.hippius.com/s/web#k=1",
  isPrivate: false,
  folderLabel: null,
  relativePath: null,
};

function capture(overrides: Partial<FormattedUserFile> = {}): FormattedUserFile {
  return { name: NAME, actualFileName: NAME, label: "Hippius Captures", size: 320870, isFolder: false, ...overrides } as FormattedUserFile;
}

const listCalls = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "hcfs_list_shares").length;

describe("useTrayShareLinks", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
    eventHandlers.clear();
    listing = [consoleLink];
  });

  it("finds a capture's link made in the web console, as the Captures page does", async () => {
    const { result } = renderHook(() => useTrayShareLinks(true));
    await waitFor(() => expect(result.current.linksFor(capture())).toHaveLength(1));
    expect(result.current.linksFor(capture())[0].shareToken).toBe("web");
    // Another file, or a different size, has no link.
    expect(result.current.linksFor(capture({ size: 5 }))).toEqual([]);
    expect(result.current.linksFor(capture({ name: "notes.png", actualFileName: "notes.png" }))).toEqual([]);
  });

  it("asks nothing before the session can answer", async () => {
    renderHook(() => useTrayShareLinks(false));
    await act(async () => {});
    expect(listCalls()).toBe(0);
  });

  it("reads the links again each time the popover is shown", async () => {
    const { result } = renderHook(() => useTrayShareLinks(true));
    await waitFor(() => expect(listCalls()).toBe(1));
    listing = [];
    await waitFor(() => expect(eventHandlers.has("hippius:tray-panel-shown")).toBe(true));
    act(() => eventHandlers.get("hippius:tray-panel-shown")?.({ payload: null }));
    await waitFor(() => expect(result.current.linksFor(capture())).toEqual([]));
    expect(listCalls()).toBe(2);
  });

  it("keeps what it knew when a read fails, so a row never loses its icon to one failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useTrayShareLinks(true));
    await waitFor(() => expect(result.current.linksFor(capture())).toHaveLength(1));
    listing = new Error("offline");
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.linksFor(capture())).toHaveLength(1);
    warn.mockRestore();
  });

  it("never lists a folder's links on a row", async () => {
    const { result } = renderHook(() => useTrayShareLinks(true));
    await waitFor(() => expect(listCalls()).toBe(1));
    expect(result.current.linksFor(capture({ isFolder: true }))).toEqual([]);
  });
});
