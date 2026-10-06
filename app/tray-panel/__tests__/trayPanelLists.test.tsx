import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EMPTY_SNAPSHOT, type SyncSnapshot } from "@/app/lib/types/syncSnapshot";
import type { UploadFeedItem } from "@/app/lib/upload-feed/mergeUploadFeed";
import type { TrayCaptureView } from "../trayCaptureView";
import { TRAY_TAB_STORAGE_KEY } from "@/app/lib/tray/trayTab";

// The popover's middle: the Captures | All files tabs, the one-line sync
// status beside them, and the list each tab shows. The data hook and the
// capture view are stubbed so each test states what Rust answered.

const ADDRESS = "5CPQ46eGx7nRkTyY2pV9wH3aLmZcQ1uS8bDfJ4kN6tWqFdJ";

const data = vi.hoisted(() => ({
  feed: [] as UploadFeedItem[],
  captures: [] as UploadFeedItem[],
  snapshot: null as SyncSnapshot | null,
  loading: false,
}));

vi.mock("@/app/lib/tray/useTrayPanelData", () => ({
  useTrayPanelData: () => ({
    menu: {
      loggedIn: true,
      credits: 1,
      balance: "1.00",
      accountLabel: null,
      substrateAddress: ADDRESS,
      sessionReady: true,
    },
    feed: data.feed,
    captures: data.captures,
    snapshot: data.snapshot ?? EMPTY_SNAPSHOT,
    blockNumber: 1,
    isConnected: true,
    unreadCount: 0,
    chatUnread: 0,
    loading: data.loading,
  }),
}));

const READY: TrayCaptureView = {
  state: "ready",
  screenshotModes: ["area", "window", "screen"],
  systemPicker: false,
  systemPickerNote: null,
  record: { state: "available" },
  recordModes: ["area", "window", "screen"],
};
const capture = vi.hoisted(() => ({ view: null as TrayCaptureView | null }));
vi.mock("../useTrayCaptureView", () => ({
  useTrayCaptureView: () => ({ view: capture.view, shortcut: [] }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  Window: { getByLabel: vi.fn(() => Promise.resolve(null)) },
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

import TrayPanelPage from "../page";

function file(name: string, overrides: Partial<UploadFeedItem> = {}): UploadFeedItem {
  return {
    name,
    actualFileName: name,
    size: 1_700_000,
    createdAt: Date.now() - 5 * 60 * 1000,
    arionHash: `path-${name}`,
    arionCid: `cid-${name}`,
    fileId: "ab".repeat(32),
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    source: `/Users/me/Drive/${name}`,
    syncStatus: "synced",
    label: "Drive",
    feedStatus: "completed",
    ...overrides,
  };
}

const SHOT = file("Screenshot 1.png", { label: "Captures" });
const REPORT = file("report.pdf");

function rowNames() {
  return within(screen.getByRole("tabpanel"))
    .queryAllByRole("listitem")
    .map((li) => li.querySelector("[data-testid=tray-row-name]")?.getAttribute("title"));
}

beforeEach(() => {
  data.feed = [SHOT, REPORT];
  data.captures = [SHOT];
  data.snapshot = null;
  data.loading = false;
  capture.view = READY;
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Captures | All files tabs", () => {
  it("open on Captures, which lists what Rust called captures", () => {
    render(<TrayPanelPage />);
    expect(screen.getByRole("tab", { name: "Captures" })).toHaveAttribute("aria-selected", "true");
    expect(rowNames()).toEqual(["Screenshot 1.png"]);
    expect(screen.getByText(/^Screenshot · 1.7 MB/)).toBeInTheDocument();
  });

  it("switch to every upload, and remember the choice for the next open", () => {
    const { unmount } = render(<TrayPanelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "All files" }));
    expect(screen.getByRole("tab", { name: "All files" })).toHaveAttribute("aria-selected", "true");
    expect(rowNames()).toEqual(["Screenshot 1.png", "report.pdf"]);
    // A capture in the full list still reads as a Screenshot.
    expect(screen.getByText(/^Screenshot · 1.7 MB/)).toBeInTheDocument();
    expect(screen.getByText(/^PDF · 1.7 MB/)).toBeInTheDocument();
    expect(window.localStorage.getItem(TRAY_TAB_STORAGE_KEY)).toBe("all");
    unmount();

    render(<TrayPanelPage />);
    expect(screen.getByRole("tab", { name: "All files" })).toHaveAttribute("aria-selected", "true");
  });

  it("move with the arrow keys, keeping only the chosen tab in the tab order", () => {
    render(<TrayPanelPage />);
    const captures = screen.getByRole("tab", { name: "Captures" });
    expect(captures).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "All files" })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(captures, { key: "ArrowRight" });
    const all = screen.getByRole("tab", { name: "All files" });
    expect(all).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(all);
    fireEvent.keyDown(all, { key: "Home" });
    expect(screen.getByRole("tab", { name: "Captures" })).toHaveAttribute("aria-selected", "true");
  });

  it("still open when storage refuses, on Captures", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<TrayPanelPage />);
    expect(screen.getByRole("tab", { name: "Captures" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "All files" }));
    expect(rowNames()).toEqual(["Screenshot 1.png", "report.pdf"]);
  });

  it("are not there where capture is off: the list is every upload", () => {
    capture.view = { state: "hidden" };
    window.localStorage.setItem(TRAY_TAB_STORAGE_KEY, "captures");
    render(<TrayPanelPage />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your Uploads" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("each have their own empty state", () => {
    data.feed = [];
    data.captures = [];
    render(<TrayPanelPage />);
    expect(screen.getByText("No captures yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upload a File/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "All files" }));
    expect(screen.getByText("No files yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload a File/ })).toBeInTheDocument();
  });

  it("show the skeleton, not the empty state, while the first load runs", () => {
    data.feed = [];
    data.captures = [];
    data.loading = true;
    render(<TrayPanelPage />);
    expect(screen.queryByText("No captures yet")).not.toBeInTheDocument();
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
  });
});

describe("the sync line", () => {
  const line = () => screen.getByTestId("tray-sync-line");

  it("reads All synced with a green check when nothing is waiting", () => {
    render(<TrayPanelPage />);
    expect(line()).toHaveAttribute("data-tone", "synced");
    expect(line()).toHaveTextContent("All synced");
    expect(screen.queryByText("100% COMPLETE")).not.toBeInTheDocument();
  });

  it("counts what is uploading and how far along it is", () => {
    data.snapshot = {
      ...EMPTY_SNAPSHOT,
      totalFiles: 5,
      actualTotal: 5,
      syncedCount: 3,
      overallPercent: 64,
      effectiveInProgress: true,
      widgetVisible: true,
    };
    render(<TrayPanelPage />);
    expect(line()).toHaveAttribute("data-tone", "active");
    expect(line()).toHaveTextContent("Uploading 2 · 64%");
    expect(line()).toHaveAttribute("title", "3 of 5 synced · 2 remaining");
  });

  it("says how many failed, in the error tone", () => {
    data.snapshot = {
      ...EMPTY_SNAPSHOT,
      totalFiles: 4,
      actualTotal: 4,
      syncedCount: 2,
      failedFiles: 2,
      overallPercent: 50,
      statusVariant: "error",
      widgetVisible: true,
    };
    render(<TrayPanelPage />);
    expect(line()).toHaveAttribute("data-tone", "failed");
    expect(line()).toHaveTextContent("2 failed");
    expect(line().className).toContain("text-[#FF6D61]");
  });
});
