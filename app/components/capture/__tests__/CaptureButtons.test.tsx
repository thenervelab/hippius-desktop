import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import CaptureButtons, { SYSTEM_PICKER_LABEL, screenshotTooltip } from "../CaptureButtons";
import {
  captureDialogAtom,
  captureModesAtom,
  captureRecordingAtom,
  captureSupportedAtom,
  captureSurfacesAtom,
} from "@/app/lib/capture/captureFlow";
import type { CaptureSurfaces } from "@/app/lib/tauri/capture";
import { offeredModes, supportedModesOf, type SupportedModes } from "@/app/lib/capture/modes";
import { recordAvailability, RECORDING_UNAVAILABLE_REASON } from "@/app/lib/capture/recordAvailability";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
// Reachability given the feature is on; which lane it is on is pinned by
// the flag's own tests.
vi.mock("@/app/lib/featureFlags", () => ({ SCREEN_CAPTURE_ENABLED: true }));

// jsdom is not a Mac; each test says which platform it is on.
let mac = true;
vi.mock("@/app/lib/capture/shortcutLabel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/capture/shortcutLabel")>();
  return { ...actual, isMacPlatform: () => mac };
});

beforeEach(() => {
  mac = true;
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) =>
    Promise.resolve(
      cmd === "capture_get_shortcut"
        ? { accelerator: "CommandOrControl+Shift+2", defaultAccelerator: "CommandOrControl+Shift+2" }
        : null,
    ),
  );
});

function renderWith(
  {
    supported = true,
    recording = true,
    modes = null,
    surfaces = null,
  }: { supported?: boolean; recording?: boolean; modes?: SupportedModes | null; surfaces?: CaptureSurfaces | null } = {},
  props: Parameters<typeof CaptureButtons>[0] = {},
) {
  const store = createStore();
  store.set(captureSupportedAtom, supported);
  store.set(captureRecordingAtom, recording);
  store.set(captureModesAtom, modes);
  store.set(captureSurfacesAtom, surfaces);
  const view = render(
    <Provider store={store}>
      <CaptureButtons {...props} />
    </Provider>,
  );
  return { ...view, store };
}

async function openMenu(name: "Screenshot" | "Record") {
  const trigger = screen.getByRole("button", { name });
  // Radix opens its menu from the keyboard too; jsdom has no real pointer events.
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findByRole("menu", { name });
}

const itemNames = () => screen.getAllByRole("menuitem").map((el) => el.textContent?.replace("⇧⌘2", "").trim());

describe("CaptureButtons", () => {
  // The separate "…" button is gone: each button carries its own menu.
  it("has no separate More button, only Screenshot and Record, each opening a menu", () => {
    renderWith();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Screenshot", "Record"]);
    expect(screen.queryByRole("button", { name: /more/i })).toBeNull();
    for (const b of buttons) expect(b).toHaveAttribute("aria-haspopup", "menu");
  });

  it("offers each screenshot mode, and each item starts that capture", async () => {
    renderWith();
    for (const [item, mode] of [
      ["Capture an area", "area"],
      ["Capture a window", "window"],
      ["Capture entire screen", "screen"],
    ] as const) {
      await openMenu("Screenshot");
      fireEvent.click(screen.getByRole("menuitem", { name: item }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("capture_start", { kind: "screenshot", mode }));
    }
  });

  it("offers each recording mode, and each item starts that recording", async () => {
    renderWith();
    for (const [item, mode] of [
      ["Record an area", "area"],
      ["Record a window", "window"],
      ["Record entire screen", "screen"],
    ] as const) {
      await openMenu("Record");
      fireEvent.click(screen.getByRole("menuitem", { name: item }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("capture_start", { kind: "recording", mode }));
    }
  });

  it("lists the modes, a separator, then the capture bar with its shortcut and the drive", async () => {
    renderWith();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("capture_get_shortcut"));
    const menu = await openMenu("Screenshot");
    expect(itemNames()).toEqual([
      "Capture an area",
      "Capture a window",
      "Capture entire screen",
      "Open capture bar",
      "Change capture drive…",
    ]);
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: /Open capture bar/ })).toHaveTextContent("⇧⌘2");

    // Drawn on its own background in both themes: the shared menu's base is
    // `bg-popover`, a token this theme does not define.
    const classes = Array.from(menu.classList);
    expect(classes.some((c) => /^bg-(?!popover)/.test(c))).toBe(true);
    expect(classes.some((c) => c.startsWith("dark:bg-"))).toBe(true);
  });

  it("opens the capture bar on the menu's kind and last mode", async () => {
    renderWith();
    await openMenu("Record");
    fireEvent.click(screen.getByRole("menuitem", { name: /Open capture bar/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("capture_start", { kind: "recording", mode: null }));
  });

  it("changes the capture drive from either menu", async () => {
    const { store } = renderWith();
    await openMenu("Record");
    fireEvent.click(screen.getByRole("menuitem", { name: "Change capture drive…" }));
    expect(store.get(captureDialogAtom)).toEqual({ kind: "destination", resume: null });
  });

  // Windows groundwork: Rust says which modes each kind has on this platform.
  it("offers only the modes Rust says this platform supports", async () => {
    renderWith({ modes: { screenshot: ["area", "window", "screen"], recording: ["screen"] } });
    await openMenu("Record");
    expect(screen.queryByRole("menuitem", { name: "Record an area" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Record a window" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Record entire screen" })).toBeInTheDocument();
  });

  it("closes on Escape and gives focus back to its button", async () => {
    renderWith();
    const menu = await openMenu("Screenshot");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByRole("button", { name: "Screenshot" })).toHaveFocus();
  });

  it("shows the shortcut in Screenshot's tooltip and names Record's", async () => {
    renderWith();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Screenshot" })).toHaveAttribute("title", "Take a screenshot (⇧⌘2)"),
    );
    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("title", "Record your screen");
  });

  it("writes the shortcut the way each platform reads it", () => {
    expect(screenshotTooltip(["⇧", "⌘", "2"], true)).toBe("Take a screenshot (⇧⌘2)");
    expect(screenshotTooltip(["Ctrl", "Shift", "2"], false)).toBe("Take a screenshot (Ctrl+Shift+2)");
    expect(screenshotTooltip([], true)).toBe("Take a screenshot");
  });

  // Linux reports unsupported until its portal path lands: buttons that
  // only ever fail are worse than none.
  it("renders nothing where Rust says the platform cannot capture", () => {
    const { container } = renderWith({ supported: false });
    expect(container).toBeEmptyDOMElement();
  });

  // A platform with no recording at all.
  it("hides Record where the platform has no recording", () => {
    mac = false;
    renderWith({ recording: false });
    expect(screen.getByRole("button", { name: "Screenshot" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
  });

  // A Mac whose build lacks the recording helper: the button stays, says why,
  // and its menu never opens. aria-disabled rather than disabled, so the
  // reason's tooltip still shows on hover and the button stays in the tab order.
  it("shows Record disabled with the reason, and its menu does not open", () => {
    renderWith({ recording: false });
    const record = screen.getByRole("button", { name: "Record" });
    expect(record).toHaveAttribute("aria-disabled", "true");
    expect(record).toHaveAttribute("title", "Screen recording isn't available in this build.");
    expect(record).not.toBeDisabled();
    expect(record).not.toHaveAttribute("aria-haspopup");
    fireEvent.keyDown(record, { key: "Enter" });
    fireEvent.click(record);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("capture_start", expect.anything());
  });

  // Icon-only (narrow widths, or labels="never"): the names live on
  // aria-label, and nothing visible is left to read.
  it("names every button when drawn as icons only", () => {
    renderWith({}, { labels: "never" });
    for (const name of ["Screenshot", "Record"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-label", name);
      expect(button).toHaveTextContent("");
    }
  });

  // Labels collapse by container width, not by wrapping: a hidden label with
  // a container-query reveal, and an icon-and-chevron button until then.
  it("collapses labels to icons in narrow columns", () => {
    renderWith({}, { labels: "auto" });
    const shot = screen.getByRole("button", { name: "Screenshot" });
    expect(shot.className).toContain("px-2");
    expect(shot.className).toContain("@[52rem]:px-3");
    const text = Array.from(shot.querySelectorAll("span")).find((s) => s.textContent === "Screenshot");
    expect(text?.className).toMatch(/\bhidden\b.*@\[52rem\]:inline/);
  });

  it("keeps the folder list's compact 26px size", () => {
    renderWith({}, { size: "compact" });
    for (const name of ["Screenshot", "Record"]) {
      expect(screen.getByRole("button", { name }).className).toContain("h-[26px]");
    }
  });
});

/** Rust's surfaces on a Wayland session, as `capture_support` answers them. */
const WAYLAND: CaptureSurfaces = {
  selection: "systemPicker",
  modes: { screenshot: [], recording: ["window", "screen"] },
  screenshotTimer: false,
  systemAudio: false,
  microphoneUnavailableMessage: "Recording the microphone isn't available on this system yet",
  continuityHint: null,
  shortcut: {
    supported: false,
    via: "desktopSettings",
    unavailableMessage: "A capture shortcut isn't available on Linux yet.",
  },
  systemPickerNote: "Your desktop's screenshot tool opens, so you can choose an area, a window or a whole screen there.",
  linuxSession: "wayland",
};

describe("CaptureButtons where the desktop's own tool chooses (Wayland)", () => {
  beforeEach(() => {
    mac = false;
  });

  it("offers one Screenshot item that hands the choice to the desktop, and says so", async () => {
    renderWith({ recording: false, surfaces: WAYLAND });
    const menu = await openMenu("Screenshot");
    expect(itemNames()).toEqual([SYSTEM_PICKER_LABEL, "Change capture drive…"]);
    expect(menu).toHaveTextContent(WAYLAND.systemPickerNote!);
    // No capture bar to open: there is no Hippius overlay on Wayland.
    expect(screen.queryByRole("menuitem", { name: /capture bar/i })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: SYSTEM_PICKER_LABEL }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("capture_start", { kind: "screenshot", mode: null }));
  });

  it("shows no shortcut where Rust says there is none", async () => {
    renderWith({ recording: false, surfaces: { ...WAYLAND, selection: "overlay", linuxSession: "x11" } });
    const button = screen.getByRole("button", { name: "Screenshot" });
    expect(button).toHaveAttribute("title", "Take a screenshot");
    await openMenu("Screenshot");
    expect(screen.getByRole("menuitem", { name: /capture bar/i })).not.toHaveTextContent("Ctrl");
    expect(invoke).not.toHaveBeenCalledWith("capture_get_shortcut");
  });
});

describe("offeredModes", () => {
  it("offers every mode when Rust does not say", () => {
    expect(offeredModes("recording", null)).toEqual(["area", "window", "screen"]);
    expect(offeredModes("screenshot", {})).toEqual(["area", "window", "screen"]);
  });

  it("keeps the menu's order and only Rust's modes", () => {
    expect(offeredModes("recording", { recording: ["screen", "area"] })).toEqual(["area", "screen"]);
  });

  it("reads Rust's modes from a support answer", () => {
    const modes = { screenshot: ["area" as const], recording: ["screen" as const] };
    expect(supportedModesOf({ modes })).toEqual(modes);
    expect(supportedModesOf({})).toBeNull();
    expect(supportedModesOf(null)).toBeNull();
  });
});

describe("recordAvailability", () => {
  it("is available wherever Rust says recording works", () => {
    expect(recordAvailability({ recording: true }, true)).toEqual({ state: "available" });
    expect(recordAvailability({ recording: true }, false)).toEqual({ state: "available" });
  });

  it("is hidden off macOS, and disabled with the reason on a Mac without it", () => {
    expect(recordAvailability({ recording: false }, false)).toEqual({ state: "hidden" });
    expect(recordAvailability({ recording: false }, true)).toEqual({
      state: "disabled",
      reason: RECORDING_UNAVAILABLE_REASON,
    });
  });

  /** Rust names why (helper missing, macOS too old); that line wins. */
  it("uses Rust's reason when there is one", () => {
    const note = "Screen recording isn't included in this build.";
    expect(recordAvailability({ recording: false }, true, note)).toEqual({ state: "disabled", reason: note });
    expect(recordAvailability({ recording: true }, true, note)).toEqual({ state: "available" });
  });
});
