import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);
vi.mock("@/app/lib/featureFlags", () => ({ SCREEN_CAPTURE_ENABLED: true }));
vi.mock("@/app/lib/capture/shortcutLabel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/capture/shortcutLabel")>()),
  isMacPlatform: () => true,
}));

import CaptureSettings from "../CaptureSettings";
import {
  captureRecordingAtom,
  captureRecordingNoteAtom,
  captureSupportedAtom,
  captureSurfacesAtom,
} from "@/app/lib/capture/captureFlow";
import type { CaptureOptions, CaptureSurfaces } from "@/app/lib/tauri/capture";

const SCREENSHOT_DEFAULT = "CommandOrControl+Shift+2";
const RECORD_DEFAULT = "CommandOrControl+Alt+Shift+2";
const TAKEN = "Those keys already take a screenshot. Choose different keys for recording.";

const OPTIONS: CaptureOptions = {
  timerSecs: 0,
  microphone: true,
  microphoneDevice: null,
  screen: true,
  camera: false,
  cameraDevice: null,
  cameraSize: "small",
  showClicks: false,
  systemAudio: false,
  lastKind: "screenshot",
  lastMode: "area",
  copyLink: true,
  openLink: true,
  recordCountdownSecs: 3,
};

const MAC: CaptureSurfaces = {
  selection: "overlay",
  modes: { screenshot: ["area", "window", "screen"], recording: ["area", "window", "screen"] },
  screenshotTimer: true,
  recordCountdown: true,
  systemAudio: true,
  microphoneUnavailableMessage: null,
  continuityHint: null,
  shortcut: { supported: true, via: "plugin", unavailableMessage: null, command: null },
  recordShortcut: { supported: true, via: "plugin", unavailableMessage: null, command: null },
  systemPickerNote: null,
  linuxSession: null,
};

type Kind = "screenshot" | "record";
let shortcuts: Record<Kind, string | null>;
let stored: CaptureOptions;

function setup({ recording = true, surfaces = MAC }: { recording?: boolean; surfaces?: CaptureSurfaces } = {}) {
  tauri.onInvoke("capture_get_shortcut", (args) => {
    const kind: Kind = (args as { kind?: Kind } | undefined)?.kind ?? "screenshot";
    return {
      accelerator: shortcuts[kind],
      defaultAccelerator: kind === "record" ? RECORD_DEFAULT : SCREENSHOT_DEFAULT,
    };
  });
  tauri.onInvoke("capture_set_shortcut", (args) => {
    const { accelerator, kind = "screenshot" } = args as { accelerator: string | null; kind?: Kind };
    shortcuts[kind] = accelerator;
    return null;
  });
  tauri.onInvoke("capture_drive_status", () => ({ state: "needsSetup", suggested: { path: "/x", place: "Documents" }, waiting: 0 }));
  tauri.onInvoke("capture_editor_save_preference", () => "ask");
  tauri.onInvoke("capture_get_options", () => stored);
  tauri.onInvoke("capture_set_options", (args) => {
    stored = { ...(args as { options: CaptureOptions }).options };
    return { options: stored, countdownSecs: 3, cameraFilmed: true };
  });
  const store = createStore();
  store.set(captureSupportedAtom, true);
  store.set(captureRecordingAtom, recording);
  store.set(captureRecordingNoteAtom, null);
  store.set(captureSurfacesAtom, surfaces);
  return render(
    <Provider store={store}>
      <CaptureSettings />
    </Provider>,
  );
}

const card = (name: string) => screen.findByRole("group", { name });

beforeEach(() => {
  tauri.reset();
  shortcuts = { screenshot: SCREENSHOT_DEFAULT, record: RECORD_DEFAULT };
  stored = { ...OPTIONS };
});

describe("the Screenshots & Recording tab", () => {
  it("lists the shortcuts first, then the folder, then the editor's save", async () => {
    const { container } = setup();
    await card("Recording shortcut");
    await screen.findByText("Copy a share link after capture");
    const text = container.textContent ?? "";
    const order = ["Screenshot shortcut", "Recording shortcut", "Capture folder", "When saving an edited image"].map(
      (t) => text.indexOf(t),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("offers no recording shortcut where this computer cannot record", async () => {
    setup({ recording: false });
    await card("Screenshot shortcut");
    expect(screen.queryByRole("group", { name: "Recording shortcut" })).toBeNull();
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_get_shortcut", { kind: "record" });
  });
});

describe("the recording shortcut", () => {
  it("shows the screenshot keys plus Option by default", async () => {
    setup();
    const record = await card("Recording shortcut");
    await waitFor(() => expect(within(record).getByLabelText("Shortcut ⌥ ⇧ ⌘ 2")).toBeInTheDocument());
    expect(within(record).getByText(/open the capture bar ready to record/)).toBeInTheDocument();
  });

  it("records new keys and saves them as the recording shortcut, leaving the screenshot one alone", async () => {
    setup();
    const record = await card("Recording shortcut");
    fireEvent.click(within(record).getByRole("button", { name: "Change" }));
    fireEvent.keyDown(window, { code: "KeyR", key: "r", metaKey: true, altKey: true });
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_shortcut", { accelerator: "Alt+Command+R", kind: "record" }),
    );
    expect(shortcuts.screenshot).toBe(SCREENSHOT_DEFAULT);
  });

  it("turns off on its own", async () => {
    setup();
    const record = await card("Recording shortcut");
    fireEvent.click(await within(record).findByRole("button", { name: "Turn off" }));
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_shortcut", { accelerator: null, kind: "record" }),
    );
    await waitFor(() => expect(within(record).getByText("Off")).toBeInTheDocument());
    // The screenshot shortcut is still on.
    const screenshot = await card("Screenshot shortcut");
    expect(within(screenshot).getByRole("button", { name: "Turn off" })).toBeInTheDocument();
  });

  // Rust refuses the screenshot's keys; the card says so in Rust's words.
  it("says why when its keys are the screenshot shortcut's", async () => {
    setup();
    tauri.onInvoke("capture_set_shortcut", () => {
      throw { kind: "Validation", message: TAKEN };
    });
    const record = await card("Recording shortcut");
    fireEvent.click(within(record).getByRole("button", { name: "Change" }));
    await act(async () => {
      fireEvent.keyDown(window, { code: "Digit2", key: "2", metaKey: true, shiftKey: true });
    });
    expect(await within(record).findByRole("alert")).toHaveTextContent(TAKEN);
    expect(within(await card("Screenshot shortcut")).queryByRole("alert")).toBeNull();
  });

  // Wayland: the desktop holds it; the card gives the command to bind.
  it("gives the command to bind where the desktop holds the shortcut", async () => {
    const line = "Hippius can't set this shortcut on your desktop. Add one in your desktop's keyboard settings that runs this command:";
    setup({
      surfaces: {
        ...MAC,
        linuxSession: "wayland",
        recordShortcut: { supported: false, via: "desktopSettings", unavailableMessage: line, command: "/usr/bin/hippius --record" },
      },
    });
    const record = await card("Recording shortcut");
    expect(within(record).getByText(line)).toBeInTheDocument();
    expect(within(record).getByTestId("record-shortcut-command")).toHaveTextContent("/usr/bin/hippius --record");
    expect(within(record).queryByRole("button", { name: "Change" })).toBeNull();
    expect(within(record).queryByRole("button", { name: "Add for me" })).toBeNull();
  });
});

describe("the capture bar's options, here as well", () => {
  it("turns copying a share link off through Rust's own options, keeping the rest", async () => {
    stored = { ...OPTIONS, microphoneDevice: "usb-mic" };
    setup();
    fireEvent.click(await screen.findByRole("switch", { name: "Copy a share link after capture" }));
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_options", {
        options: { ...OPTIONS, microphoneDevice: "usb-mic", copyLink: false },
      }),
    );
    // Opening the link means nothing without one.
    await waitFor(() => expect(screen.queryByRole("switch", { name: "Open the link in your browser" })).toBeNull());
  });

  it("sets the recording countdown and system audio where this computer records", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "5 seconds" }));
    await waitFor(() => expect(stored.recordCountdownSecs).toBe(5));
    fireEvent.click(screen.getByRole("switch", { name: "Record system audio" }));
    await waitFor(() => expect(stored.systemAudio).toBe(true));
  });

  it("offers only the link options where this computer cannot record", async () => {
    setup({ recording: false });
    expect(await screen.findByRole("switch", { name: "Copy a share link after capture" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Recording countdown" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Record system audio" })).toBeNull();
  });
});
