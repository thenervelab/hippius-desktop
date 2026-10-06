import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

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

import TrayCaptureRow from "../TrayCaptureRow";

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
  tauri.onInvoke("hide_tray_panel", () => null);
  tauri.onInvoke("capture_annotate_latest", () => null);
});

/** Each `invoke`/`emit` call's place in the overall call order. */
function order(mock: { mock: { calls: unknown[][]; invocationCallOrder: number[] } }, first: unknown) {
  const i = mock.mock.calls.findIndex(([name]) => name === first);
  expect(i, `${String(first)} was called`).toBeGreaterThanOrEqual(0);
  return mock.mock.invocationCallOrder[i];
}

describe("the popover's capture row", () => {
  it("shows Screenshot and Record, each with its own menu, where capture works", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<TrayCaptureRow />);
    const group = await screen.findByRole("group", { name: "Screen capture" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Screenshot" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Record" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Screenshot options" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record options" })).toBeInTheDocument();
  });

  it("holds its place with a skeleton, not a spinner, while Rust is asked", () => {
    tauri.onInvoke("capture_support", () => new Promise(() => undefined));
    render(<TrayCaptureRow />);
    expect(screen.getByTestId("tray-capture-skeleton")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("is not there when the lane has capture off, and does not even ask Rust", () => {
    flags.capture = false;
    const { container } = render(<TrayCaptureRow />);
    expect(container).toBeEmptyDOMElement();
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_support");
  });

  it("is not there where this platform cannot capture, or Rust could not say", async () => {
    tauri.onInvoke("capture_support", () => support({ supported: false, recording: false }));
    const first = render(<TrayCaptureRow />);
    await waitFor(() => expect(first.container).toBeEmptyDOMElement());
    first.unmount();

    tauri.onInvoke("capture_support", () => Promise.reject(new Error("no")));
    const second = render(<TrayCaptureRow />);
    await waitFor(() => expect(second.container).toBeEmptyDOMElement());
  });

  it("hides the popover, THEN asks the main window to start, in one click", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<TrayCaptureRow />);
    fireEvent.click(await screen.findByRole("button", { name: "Screenshot" }));
    await waitFor(() =>
      expect(tauri.event.emit).toHaveBeenCalledWith("hippius:tray-capture", { kind: "screenshot", mode: undefined }),
    );
    expect(order(tauri.core.invoke, "hide_tray_panel")).toBeLessThan(order(tauri.event.emit, "hippius:tray-capture"));
    // The main window starts it (its dialogs live there); the popover never does.
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_start", expect.anything());
  });

  it("starts a recording on the mode picked from Record's menu", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<TrayCaptureRow />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Record options" }), { key: "Enter" });
    const menu = await screen.findByRole("menu", { name: "Record options" });
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["Record an area", "Record a window", "Record entire screen", "Captures folder…"]);
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
    render(<TrayCaptureRow />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Screenshot options" }), { key: "Enter" });
    await screen.findByRole("menu", { name: "Screenshot options" });
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Capture an area",
      "Capture entire screen",
      "Captures folder…",
    ]);
  });

  it("sends Captures folder to the main window's dialog", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<TrayCaptureRow />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Screenshot options" }), { key: "Enter" });
    await screen.findByRole("menu", { name: "Screenshot options" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Captures folder…" }));
    await waitFor(() => expect(tauri.event.emit).toHaveBeenCalledWith("hippius:tray-capture-drive", {}));
    expect(tauri.event.emit).not.toHaveBeenCalledWith("hippius:tray-capture", expect.anything());
  });

  // A popover hidden by a click outside must not come back with its menu open.
  it("closes an open menu when the popover loses focus", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<TrayCaptureRow />);
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
    render(<TrayCaptureRow />);
    const record = await screen.findByRole("button", { name: "Record" });
    // Named by its label alone; the reason is its description.
    expect(record).toHaveAttribute("aria-disabled", "true");
    expect(record).toHaveAccessibleDescription(reason);
    expect(screen.queryByRole("button", { name: "Record options" })).not.toBeInTheDocument();
    fireEvent.click(record);
    expect(tauri.event.emit).not.toHaveBeenCalled();
  });
});

describe("the popover's Annotate button", () => {
  /** The button once Rust's latest screenshot made it a menu trigger. */
  const annotateMenuButton = () =>
    waitFor(() => {
      const button = screen.getByRole("button", { name: "Annotate" });
      expect(button).toHaveAttribute("aria-haspopup", "menu");
      return button;
    });
  const SHOT = { fileName: "Screenshot 2026-10-05 at 10.00.00.png" };

  it("sits next to Screenshot and Record, and goes straight to the file dialog with no screenshot", async () => {
    tauri.onInvoke("capture_support", () => support());
    tauri.onInvoke("capture_annotate_pick", () => true);
    render(<TrayCaptureRow />);
    const group = await screen.findByRole("group", { name: "Screen capture" });
    const annotate = await screen.findByRole("button", { name: "Annotate" });
    expect(group).toContainElement(annotate);
    expect(annotate).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(annotate);
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_annotate_pick"));
    // The popover goes first, so the dialog and the editor are never under it.
    expect(order(tauri.core.invoke, "hide_tray_panel")).toBeLessThan(order(tauri.core.invoke, "capture_annotate_pick"));
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_annotate_open_latest");
  });

  it("offers the latest screenshot or another picture when there is one", async () => {
    tauri.onInvoke("capture_support", () => support());
    tauri.onInvoke("capture_annotate_latest", () => SHOT);
    tauri.onInvoke("capture_annotate_open_latest", () => true);
    render(<TrayCaptureRow />);
    const annotate = await annotateMenuButton();
    fireEvent.keyDown(annotate, { key: "Enter" });
    await screen.findByRole("menu", { name: "Annotate" });
    const items = screen.getAllByRole("menuitem");
    expect(items.map((el) => el.textContent)).toEqual([`Latest screenshot${SHOT.fileName}`, "Choose image…"]);
    fireEvent.click(items[0]);
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_annotate_open_latest"));
    expect(order(tauri.core.invoke, "hide_tray_panel")).toBeLessThan(
      order(tauri.core.invoke, "capture_annotate_open_latest"),
    );
    // The page names no file: Rust decides which screenshot is the latest.
    const call = tauri.core.invoke.mock.calls.find(([name]) => name === "capture_annotate_open_latest");
    expect(call).toEqual(["capture_annotate_open_latest"]);
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_annotate_pick");
  });

  it("opens the file dialog from Choose image…", async () => {
    tauri.onInvoke("capture_support", () => support());
    tauri.onInvoke("capture_annotate_latest", () => SHOT);
    tauri.onInvoke("capture_annotate_pick", () => false);
    render(<TrayCaptureRow />);
    const annotate = await annotateMenuButton();
    fireEvent.keyDown(annotate, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Choose image…" }));
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_annotate_pick"));
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_annotate_open_latest");
  });

  it("falls back to the file dialog when the latest screenshot has gone meanwhile", async () => {
    tauri.onInvoke("capture_support", () => support());
    tauri.onInvoke("capture_annotate_latest", () => SHOT);
    tauri.onInvoke("capture_annotate_open_latest", () => false);
    tauri.onInvoke("capture_annotate_pick", () => true);
    render(<TrayCaptureRow />);
    const annotate = await annotateMenuButton();
    fireEvent.keyDown(annotate, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Latest screenshot/ }));
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_annotate_pick"));
  });

  it("asks Rust again for the latest screenshot each time the popover gets focus", async () => {
    tauri.onInvoke("capture_support", () => support());
    let latest: typeof SHOT | null = null;
    tauri.onInvoke("capture_annotate_latest", () => latest);
    render(<TrayCaptureRow />);
    const annotate = await screen.findByRole("button", { name: "Annotate" });
    expect(annotate).not.toHaveAttribute("aria-haspopup");
    latest = SHOT;
    fireEvent.focus(window);
    await annotateMenuButton();
  });

  it("is not there where Screenshot is not", async () => {
    tauri.onInvoke("capture_support", () => support({ supported: false, recording: false }));
    const { container } = render(<TrayCaptureRow />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_annotate_latest");
  });

  it("stays quiet in the popover when Rust could not open the picture (Rust notifies)", async () => {
    tauri.onInvoke("capture_support", () => support());
    tauri.onInvoke("capture_annotate_pick", () => Promise.reject({ kind: "Validation", message: "nope" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<TrayCaptureRow />);
    fireEvent.click(await screen.findByRole("button", { name: "Annotate" }));
    await waitFor(() => expect(error).toHaveBeenCalled());
    error.mockRestore();
  });
});
