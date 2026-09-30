import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import CaptureButtons, { screenshotTooltip } from "../CaptureButtons";
import {
  captureDialogAtom,
  captureRecordingAtom,
  captureSupportedAtom,
} from "@/app/lib/capture/captureFlow";
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
  { supported = true, recording = true }: { supported?: boolean; recording?: boolean } = {},
  props: Parameters<typeof CaptureButtons>[0] = {},
) {
  const store = createStore();
  store.set(captureSupportedAtom, supported);
  store.set(captureRecordingAtom, recording);
  const view = render(
    <Provider store={store}>
      <CaptureButtons {...props} />
    </Provider>,
  );
  return { ...view, store };
}

async function openMore() {
  const trigger = screen.getByRole("button", { name: "More capture options" });
  // Radix opens its menu from the keyboard too; jsdom has no real pointer events.
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findByRole("menu");
}

describe("CaptureButtons", () => {
  it("opens the capture bar on screenshots from Screenshot", async () => {
    renderWith();
    fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("capture_start", { kind: "screenshot", mode: null }));
  });

  it("opens the capture bar on recording from Record", async () => {
    renderWith();
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("capture_start", { kind: "recording", mode: null }));
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

  // Windows captures screenshots but has no recording at all.
  it("hides Record where the platform has no recording", () => {
    mac = false;
    renderWith({ recording: false });
    expect(screen.getByRole("button", { name: "Screenshot" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
  });

  // A Mac whose build lacks the recording helper: the button stays, says why,
  // and does nothing. aria-disabled rather than disabled, so the reason's
  // tooltip still shows on hover and the button stays in the tab order.
  it("shows Record disabled with the reason on a Mac without the helper", () => {
    renderWith({ recording: false });
    const record = screen.getByRole("button", { name: "Record" });
    expect(record).toHaveAttribute("aria-disabled", "true");
    expect(record).toHaveAttribute("title", "Screen recording isn't available in this build.");
    expect(record).not.toBeDisabled();
    fireEvent.click(record);
    expect(invoke).not.toHaveBeenCalledWith("capture_start", expect.anything());
  });

  it("offers the capture bar with its shortcut, and the capture drive, under More", async () => {
    const { store } = renderWith();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("capture_get_shortcut"));
    const menu = await openMore();
    const bar = screen.getByRole("menuitem", { name: /Open capture bar/ });
    expect(bar).toHaveTextContent("⇧⌘2");
    expect(screen.getByRole("menuitem", { name: "Change capture drive…" })).toBeInTheDocument();

    // Drawn on its own background in both themes: the shared menu's base is
    // `bg-popover`, a token this theme does not define.
    const classes = Array.from(menu.classList);
    expect(classes.some((c) => /^bg-(?!popover)/.test(c))).toBe(true);
    expect(classes.some((c) => c.startsWith("dark:bg-"))).toBe(true);

    fireEvent.click(screen.getByRole("menuitem", { name: "Change capture drive…" }));
    expect(store.get(captureDialogAtom)).toEqual({ kind: "destination", resume: null });
  });

  it("opens the capture bar on the last mode from More", async () => {
    renderWith();
    await openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: /Open capture bar/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("capture_start", { kind: null, mode: null }));
  });

  // Icon-only (narrow widths, or labels="never"): the names live on
  // aria-label, and nothing visible is left to read.
  it("names every button when drawn as icons only", () => {
    renderWith({}, { labels: "never" });
    for (const name of ["Screenshot", "Record", "More capture options"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-label", name);
      expect(button).toHaveTextContent("");
    }
  });

  // Labels collapse by container width, not by wrapping: a hidden label with
  // a container-query reveal, and an icon-sized button until then.
  it("collapses labels to icons in narrow columns", () => {
    renderWith({}, { labels: "auto" });
    const shot = screen.getByRole("button", { name: "Screenshot" });
    expect(shot.className).toContain("w-[30px]");
    expect(shot.className).toContain("@[52rem]:w-auto");
    const text = Array.from(shot.querySelectorAll("span")).find((s) => s.textContent === "Screenshot");
    expect(text?.className).toMatch(/\bhidden\b.*@\[52rem\]:inline/);
  });

  it("keeps the folder list's compact 26px size", () => {
    renderWith({}, { size: "compact" });
    for (const name of ["Screenshot", "Record", "More capture options"]) {
      expect(screen.getByRole("button", { name }).className).toContain("h-[26px]");
    }
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
