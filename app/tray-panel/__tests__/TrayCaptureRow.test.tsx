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
    expect(items).toEqual(["Record an area", "Record a window", "Record entire screen", "Change capture drive…"]);
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
      "Change capture drive…",
    ]);
  });

  it("sends Change capture drive to the main window's picker", async () => {
    tauri.onInvoke("capture_support", () => support());
    render(<TrayCaptureRow />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Screenshot options" }), { key: "Enter" });
    await screen.findByRole("menu", { name: "Screenshot options" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Change capture drive…" }));
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
