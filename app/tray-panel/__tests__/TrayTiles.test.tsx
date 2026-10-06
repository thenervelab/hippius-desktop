import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

const main = vi.hoisted(() => ({
  isMinimized: vi.fn(() => Promise.resolve(false)),
  unminimize: vi.fn(() => Promise.resolve()),
  show: vi.fn(() => Promise.resolve()),
  setFocus: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  Window: { getByLabel: vi.fn(() => Promise.resolve(main)) },
}));

// The popover's own drop listener: tests deliver drag events through it.
type DragEvent = { payload: { type: "enter" | "over" | "drop" | "leave"; paths?: string[] } };
const drop = vi.hoisted(() => ({ handler: null as null | ((e: DragEvent) => void) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (e: DragEvent) => void) => {
      drop.handler = handler;
      return Promise.resolve(() => {
        drop.handler = null;
      });
    },
  }),
}));

// The flag is read at render, so each test can say whether the lane has it.
const flags = vi.hoisted(() => ({ capture: true }));
vi.mock("@/app/lib/featureFlags", () => ({
  get SCREEN_CAPTURE_ENABLED() {
    return flags.capture;
  },
}));

// jsdom is not a Mac; the popover only runs on macOS and Windows.
vi.mock("@/app/lib/capture/shortcutLabel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/capture/shortcutLabel")>()),
  isMacPlatform: () => true,
}));

import TrayTiles from "../TrayTiles";
import { useTrayCaptureView } from "../useTrayCaptureView";

/** The tiles as the page wires them: Rust's answer, read by the hook. */
function Tiles() {
  const { view, shortcut } = useTrayCaptureView();
  return <TrayTiles view={view} shortcut={shortcut} />;
}

const SURFACES = {
  selection: "overlay",
  modes: { screenshot: ["area", "window", "screen"], recording: ["area", "window", "screen"] },
  screenshotTimer: true,
  systemAudio: true,
  microphoneUnavailableMessage: null,
  continuityHint: null,
  shortcut: { supported: true, via: "plugin", unavailableMessage: null },
  systemPickerNote: null,
  linuxSession: null,
};

function support(overrides: Record<string, unknown> = {}) {
  return {
    supported: true,
    recording: true,
    cameraOnly: true,
    screenRecordingPermission: true,
    permissionPane: null,
    recordingUnavailable: null,
    recordingUnavailableMessage: null,
    ...SURFACES,
    ...overrides,
  };
}

beforeEach(() => {
  tauri.reset();
  flags.capture = true;
  drop.handler = null;
  main.show.mockClear();
  tauri.onInvoke("hide_tray_panel", () => null);
  tauri.onInvoke("capture_get_shortcut", () => ({
    accelerator: "CommandOrControl+Shift+2",
    defaultAccelerator: "CommandOrControl+Shift+2",
  }));
});

/** Each `invoke`/`emit` call's place in the overall call order. */
function order(mock: { mock: { calls: unknown[][]; invocationCallOrder: number[] } }, first: unknown) {
  const i = mock.mock.calls.findIndex(([name]) => name === first);
  expect(i, `${String(first)} was called`).toBeGreaterThanOrEqual(0);
  return mock.mock.invocationCallOrder[i];
}

const menuItems = () => screen.getAllByRole("menuitem").map((el) => el.textContent);

describe("the popover's tiles", () => {
  it("shows Screenshot, Record and Upload where capture works", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<Tiles />);
    const group = await screen.findByRole("group", { name: "Capture and upload" });
    const tiles = within(group)
      .getAllByRole("button")
      .filter((b) => !b.getAttribute("aria-label")?.endsWith("options"));
    expect(tiles.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Screenshot",
      "Record",
      "Upload, or drop files",
    ]);
    expect(screen.getByRole("button", { name: "Screenshot options" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record options" })).toBeInTheDocument();
  });

  it("puts the configured shortcut under Screenshot, as Rust reports it", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<Tiles />);
    const screenshot = await screen.findByRole("button", { name: "Screenshot" });
    await waitFor(() => expect(screenshot).toHaveAccessibleDescription("Shortcut ⇧⌘2"));
    expect(screenshot).toHaveTextContent("⇧⌘2");
  });

  it("shows no keys where the desktop, not Hippius, holds the shortcut", async () => {
    tauri.onInvoke("capture_support", () =>
      support({ shortcut: { supported: true, via: "portal", unavailableMessage: null } }),
    );
    render(<Tiles />);
    const screenshot = await screen.findByRole("button", { name: "Screenshot" });
    expect(screenshot).not.toHaveTextContent("⇧⌘2");
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_get_shortcut");
  });

  it("shows only Upload where this platform cannot capture, or the lane has it off", async () => {
    tauri.onInvoke("capture_support", () => support({ supported: false, recording: false }));
    const first = render(<Tiles />);
    const group = await screen.findByRole("group", { name: "Upload" });
    expect(within(group).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Upload, or drop files",
    ]);
    expect(screen.queryByRole("button", { name: "Screenshot" })).not.toBeInTheDocument();
    first.unmount();
    tauri.core.invoke.mockClear();

    flags.capture = false;
    render(<Tiles />);
    expect(screen.getByRole("button", { name: "Upload, or drop files" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record" })).not.toBeInTheDocument();
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_support");
  });

  it("holds its place with a skeleton, not a spinner, while Rust is asked", () => {
    tauri.onInvoke("capture_support", () => new Promise(() => undefined));
    render(<Tiles />);
    expect(screen.getByTestId("tray-capture-skeleton")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("hides the popover, THEN asks the main window to start, in one click", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<Tiles />);
    fireEvent.click(await screen.findByRole("button", { name: "Screenshot" }));
    await waitFor(() =>
      expect(tauri.event.emit).toHaveBeenCalledWith("hippius:tray-capture", { kind: "screenshot", mode: undefined }),
    );
    expect(order(tauri.core.invoke, "hide_tray_panel")).toBeLessThan(order(tauri.event.emit, "hippius:tray-capture"));
    // The main window starts it (its dialogs live there); the popover never does.
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_start", expect.anything());
  });

  it("offers Area, Window and Full screen, then Annotate an image, from Screenshot's arrow", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<Tiles />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Screenshot options" }), { key: "Enter" });
    await screen.findByRole("menu", { name: "Screenshot options" });
    expect(menuItems()).toEqual([
      "Capture an area",
      "Capture a window",
      "Capture entire screen",
      "Annotate an image…",
      "Captures folder…",
    ]);
  });

  it("annotates a picked image: hides the popover first, and names no file", async () => {
    tauri.onInvoke("capture_support", () => support());
    tauri.onInvoke("capture_annotate_pick", () => true);
    render(<Tiles />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Screenshot options" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Annotate an image…" }));
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_annotate_pick"));
    expect(order(tauri.core.invoke, "hide_tray_panel")).toBeLessThan(order(tauri.core.invoke, "capture_annotate_pick"));
    // The latest screenshot is now each row's Edit; the tiles never ask for it.
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_annotate_latest");
    expect(screen.queryByRole("button", { name: "Annotate" })).not.toBeInTheDocument();
  });

  it("starts a recording on the mode picked from Record's arrow", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<Tiles />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Record options" }), { key: "Enter" });
    const menu = await screen.findByRole("menu", { name: "Record options" });
    expect(menuItems()).toEqual(["Record an area", "Record a window", "Record entire screen", "Captures folder…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Record a window" }));
    await waitFor(() =>
      expect(tauri.event.emit).toHaveBeenCalledWith("hippius:tray-capture", { kind: "recording", mode: "window" }),
    );
    expect(order(tauri.core.invoke, "hide_tray_panel")).toBeLessThan(order(tauri.event.emit, "hippius:tray-capture"));
    expect(menu).not.toBeInTheDocument();
  });

  it("offers only the modes Rust says this platform has", async () => {
    tauri.onInvoke("capture_support", () =>
      support({ modes: { screenshot: ["area", "screen"], recording: ["screen"] } }),
    );
    render(<Tiles />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Screenshot options" }), { key: "Enter" });
    await screen.findByRole("menu", { name: "Screenshot options" });
    expect(menuItems()).toEqual([
      "Capture an area",
      "Capture entire screen",
      "Annotate an image…",
      "Captures folder…",
    ]);
  });

  it("sends Captures folder to the main window's dialog", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<Tiles />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Screenshot options" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Captures folder…" }));
    await waitFor(() => expect(tauri.event.emit).toHaveBeenCalledWith("hippius:tray-capture-drive", {}));
    expect(tauri.event.emit).not.toHaveBeenCalledWith("hippius:tray-capture", expect.anything());
  });

  // A popover hidden by a click outside must not come back with its menu open.
  it("closes an open menu when the popover loses focus", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<Tiles />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Screenshot options" }), { key: "Enter" });
    const menu = await screen.findByRole("menu", { name: "Screenshot options" });
    fireEvent.blur(window);
    await waitFor(() => expect(menu).not.toBeInTheDocument());
  });

  it("keeps Record in view with Rust's reason when this Mac could record with another build", async () => {
    const reason = "Screen recording isn't included in this build.";
    tauri.onInvoke("capture_support", () =>
      support({ recording: false, recordingUnavailable: "helperMissing", recordingUnavailableMessage: reason }),
    );
    render(<Tiles />);
    const record = await screen.findByRole("button", { name: "Record" });
    expect(record).toHaveAttribute("aria-disabled", "true");
    expect(record).toHaveAccessibleDescription(reason);
    expect(screen.queryByRole("button", { name: "Record options" })).not.toBeInTheDocument();
    fireEvent.click(record);
    expect(tauri.event.emit).not.toHaveBeenCalled();
  });
});

describe("the Upload tile", () => {
  it("brings the main window forward with its Upload File dialog, not the Drive page", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<Tiles />);
    fireEvent.click(await screen.findByRole("button", { name: "Upload, or drop files" }));
    await waitFor(() => expect(tauri.event.emit).toHaveBeenCalledWith("hippius:tray-open-upload", {}));
    expect(main.show).toHaveBeenCalled();
    expect(main.setFocus).toHaveBeenCalled();
    expect(tauri.event.emit).not.toHaveBeenCalledWith("hippius:tray-open-files", expect.anything());
    // The popover is out of the way before the dialog is asked for.
    const hide = tauri.core.invoke.mock.invocationCallOrder[
      tauri.core.invoke.mock.calls.findIndex(([c]) => c === "hide_tray_panel")
    ];
    expect(hide).toBeLessThan(tauri.event.emit.mock.invocationCallOrder[0]);
  });

  it("lights up while files are dragged over the popover, and hands a drop to the main window", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<Tiles />);
    const upload = await screen.findByRole("button", { name: "Upload, or drop files" });
    await waitFor(() => expect(drop.handler).not.toBeNull());

    act(() => drop.handler?.({ payload: { type: "enter", paths: ["/Users/me/a.png"] } }));
    expect(upload).toHaveAttribute("data-dragging", "true");
    expect(upload).toHaveTextContent("Drop to upload");

    act(() => drop.handler?.({ payload: { type: "drop", paths: ["/Users/me/a.png", "/Users/me/b.pdf"] } }));
    expect(upload).not.toHaveAttribute("data-dragging");
    await waitFor(() =>
      expect(tauri.event.emit).toHaveBeenCalledWith("hippius:tray-upload-paths", {
        paths: ["/Users/me/a.png", "/Users/me/b.pdf"],
      }),
    );
    // The popover goes first, so the upload dialog is never under it.
    expect(order(tauri.core.invoke, "hide_tray_panel")).toBeLessThan(
      order(tauri.event.emit, "hippius:tray-upload-paths"),
    );
  });

  it("forgets a drag that left without a drop", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<Tiles />);
    const upload = await screen.findByRole("button", { name: "Upload, or drop files" });
    await waitFor(() => expect(drop.handler).not.toBeNull());
    act(() => drop.handler?.({ payload: { type: "enter", paths: ["/a"] } }));
    act(() => drop.handler?.({ payload: { type: "leave" } }));
    expect(upload).not.toHaveAttribute("data-dragging");
    expect(tauri.event.emit).not.toHaveBeenCalledWith("hippius:tray-upload-paths", expect.anything());
  });
});
