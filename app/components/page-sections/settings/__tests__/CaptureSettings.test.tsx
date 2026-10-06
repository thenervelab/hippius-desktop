import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { captureRecordingNoteAtom, captureSupportedAtom, captureSurfacesAtom } from "@/app/lib/capture/captureFlow";
import type { CaptureDriveStatus, CaptureSurfaces } from "@/app/lib/tauri/capture";

const DEFAULT = "CommandOrControl+Shift+2";
const DOCS = {
  path: "/Users/a/Documents/Hippius Captures",
  place: "Documents › Hippius Captures",
  permissionNote: null,
};
const READY: CaptureDriveStatus = {
  state: "ready",
  label: "Hippius Captures",
  name: "Hippius Captures",
  remote: false,
  location: DOCS,
};
let accelerator: string | null = DEFAULT;

function setup(
  recordingNote: string | null = null,
  surfaces: CaptureSurfaces | null = null,
  drive: CaptureDriveStatus = READY,
) {
  tauri.onInvoke("capture_get_shortcut", () => ({ accelerator, defaultAccelerator: DEFAULT }));
  tauri.onInvoke("capture_drive_status", () => drive);
  tauri.onInvoke("capture_set_shortcut", (args) => {
    accelerator = (args as { accelerator: string | null }).accelerator;
    return null;
  });
  const store = createStore();
  store.set(captureSupportedAtom, true);
  store.set(captureRecordingNoteAtom, recordingNote);
  store.set(captureSurfacesAtom, surfaces);
  return render(
    <Provider store={store}>
      <CaptureSettings />
    </Provider>,
  );
}

const key = (code: string, mods: Partial<Record<"metaKey" | "shiftKey" | "altKey" | "ctrlKey", boolean>> = {}, k = code) =>
  fireEvent.keyDown(window, { code, key: k, ...mods });

beforeEach(() => {
  tauri.reset();
  accelerator = DEFAULT;
});

describe("the capture shortcut recorder", () => {
  it("records the next chord and saves it", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    key("Digit3", { metaKey: true, altKey: true });
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_shortcut", { accelerator: "Alt+Command+3" }),
    );
  });

  it("draws the modifiers as they are held", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    expect(screen.getByText("Waiting…")).toBeInTheDocument();
    key("MetaLeft", { metaKey: true }, "Meta");
    key("ShiftLeft", { metaKey: true, shiftKey: true }, "Shift");
    expect(screen.getByLabelText("Shortcut ⇧ ⌘")).toBeInTheDocument();
    fireEvent.keyUp(window, { code: "ShiftLeft", key: "Shift", metaKey: true });
    expect(screen.getByLabelText("Shortcut ⌘")).toBeInTheDocument();
  });

  it("says why a key cannot be used instead of waiting on in silence", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    key("Space", { metaKey: true }, " ");
    expect(screen.getByRole("alert")).toHaveTextContent("Use a letter, a number or an F key");
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_set_shortcut", expect.anything());
  });

  it("stops recording on Escape and keeps the shortcut", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    key("Escape", {}, "Escape");
    expect(screen.queryByText("Waiting…")).toBeNull();
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_set_shortcut", expect.anything());
  });

  it("offers Reset only away from the default, and Turn off only while on", async () => {
    accelerator = "Alt+Command+3";
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Reset" }));
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_shortcut", { accelerator: DEFAULT }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reset" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(screen.getByText("Off")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
  });

  it("shows Rust's refusal", async () => {
    setup();
    tauri.onInvoke("capture_set_shortcut", () => {
      throw { kind: "Validation", message: "Another app is already using that shortcut." };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    await act(async () => {
      key("KeyK", { metaKey: true, shiftKey: true });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Another app is already using that shortcut.");
  });

  // The installed Hippius held Cmd+Shift+2 while a development build ran:
  // the saved shortcut never registered, and Settings said nothing.
  it("says when the saved shortcut is not working, and who holds it", async () => {
    tauri.onInvoke("capture_get_shortcut", () => ({
      accelerator,
      defaultAccelerator: DEFAULT,
      problem: "Another copy of Hippius is using this shortcut. Quit it, or choose another.",
    }));
    tauri.onInvoke("capture_drive_status", () => READY);
    const store = createStore();
    store.set(captureSupportedAtom, true);
    render(
      <Provider store={store}>
        <CaptureSettings />
      </Provider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Another copy of Hippius is using this shortcut. Quit it, or choose another.",
    );
    // Choosing another hides it while the keys are being pressed (the first
    // Change is the shortcut's; the second is the drive's).
    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the capture folder row", () => {
  it("says where the captures drive is, and offers to move it", async () => {
    const { container } = setup();
    const line = await screen.findByTestId("capture-destination-line", {}, { timeout: 5000 });
    await waitFor(() => expect(line).toHaveTextContent("saved in Documents › Hippius Captures"));
    expect(screen.getAllByRole("button", { name: "Change" }).length).toBe(2);
    expect(container).not.toHaveTextContent("/Users/a");
  });

  it("names a captures drive that is not synced here", async () => {
    setup(null, null, { ...READY, remote: true, location: null });
    const line = await screen.findByTestId("capture-destination-line", {}, { timeout: 5000 });
    await waitFor(() => expect(line).toHaveTextContent("saved in your Hippius Captures drive"));
  });

  // Nothing chosen yet is not a problem to fix: the first capture asks.
  it("says the first capture asks, with the suggested place, and offers to set it up now", async () => {
    setup(null, null, { state: "needsSetup", suggested: DOCS, waiting: 0 });
    const line = await screen.findByTestId("capture-destination-line", {}, { timeout: 5000 });
    await waitFor(() => expect(line).toHaveTextContent("Your first capture asks where to keep them"));
    expect(line).toHaveTextContent("Documents › Hippius Captures");
    expect(screen.getByRole("button", { name: "Set up" })).toBeInTheDocument();
  });

  it("says in Rust's words why a chosen folder has no drive yet", async () => {
    setup(null, null, { state: "pending", location: DOCS, message: "Your captures are kept on this computer." });
    const line = await screen.findByTestId("capture-destination-line", {}, { timeout: 5000 });
    await waitFor(() => expect(line).toHaveTextContent("Your captures are kept on this computer."));
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("reads the status again when the captures drive changes", async () => {
    let drive: CaptureDriveStatus = { state: "needsSetup", suggested: DOCS, waiting: 0 };
    setup(null, null, drive);
    tauri.onInvoke("capture_drive_status", () => drive);
    await screen.findByRole("button", { name: "Set up" }, { timeout: 5000 });
    drive = READY;
    await act(() => tauri.emitEvent("capture_drive_changed", null));
    await waitFor(() => expect(screen.getByTestId("capture-destination-line")).toHaveTextContent("Documents › Hippius Captures"));
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
  });
});

describe("the capture card's recording row", () => {
  it("says in Rust's words when this build cannot record", async () => {
    setup("Screen recording isn't included in this build.");
    expect(await screen.findByText("Screen recording")).toBeInTheDocument();
    expect(screen.getByText(/Screen recording isn't included in this build\./)).toBeInTheDocument();
  });

  it("is absent when recording works or is not offered here", async () => {
    setup(null);
    await screen.findByText("Capture folder");
    expect(screen.queryByText("Screen recording")).toBeNull();
  });
});

describe("the capture card on Linux", () => {
  const DESKTOP_LINE =
    "Your desktop doesn't let apps set a shortcut themselves. Add one in your desktop's keyboard settings that runs this command:";
  const COMMAND = "/usr/bin/hippius --capture";
  const linux = (over: Partial<CaptureSurfaces> = {}): CaptureSurfaces => ({
    selection: "overlay",
    modes: { screenshot: ["area", "window", "screen"], recording: ["area", "window", "screen"] },
    screenshotTimer: true,
    recordCountdown: true,
    systemAudio: false,
    microphoneUnavailableMessage: null,
    continuityHint: null,
    shortcut: { supported: true, via: "plugin", unavailableMessage: null, command: null },
    systemPickerNote: null,
    linuxSession: "x11",
    ...over,
  });
  const wayland = (shortcut: CaptureSurfaces["shortcut"]) =>
    linux({ selection: "systemPicker", linuxSession: "wayland", shortcut });
  const desktopSettings = wayland({ supported: false, via: "desktopSettings", unavailableMessage: DESKTOP_LINE, command: COMMAND });

  /** X11 grabs the keys like macOS and Windows: the recorder and its buttons. */
  it("keeps the shortcut controls where Hippius grabs the keys (X11)", async () => {
    setup(null, linux());
    expect(await screen.findByRole("button", { name: "Turn off" })).toBeInTheDocument();
    expect(screen.queryByText(DESKTOP_LINE)).toBeNull();
  });

  /** A shortcut that would be saved but never fire is not offered; the command to bind is. */
  it("gives the command to bind where the desktop lets no app set one", async () => {
    setup(null, desktopSettings);
    expect(await screen.findByText(DESKTOP_LINE)).toBeInTheDocument();
    expect(screen.getByTestId("capture-shortcut-command")).toHaveTextContent(COMMAND);
    expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
    // Not GNOME: Hippius cannot add it, so it does not offer to.
    expect(screen.queryByRole("button", { name: "Add for me" })).toBeNull();
  });

  it("adds it on GNOME and then says where it lives", async () => {
    let added = false;
    setup(null, desktopSettings);
    tauri.onInvoke("capture_get_shortcut", () => ({ accelerator, defaultAccelerator: DEFAULT, addedToDesktop: added }));
    tauri.onInvoke("capture_add_desktop_shortcut", () => {
      added = true;
      return null;
    });
    // The first read ran before the GNOME answer was mocked: read again.
    fireEvent.click(await screen.findByRole("button", { name: "Copy command" }));
    cleanupAndRender();
    fireEvent.click(await screen.findByRole("button", { name: "Add for me" }));
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_add_desktop_shortcut"));
    expect(await screen.findByText(/Added to your desktop's keyboard shortcuts/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add for me" })).toBeNull();

    function cleanupAndRender() {
      document.body.innerHTML = "";
      const store = createStore();
      store.set(captureSupportedAtom, true);
      store.set(captureSurfacesAtom, desktopSettings);
      render(
        <Provider store={store}>
          <CaptureSettings />
        </Provider>,
      );
    }
  });

  /** The portal's desktop owns the binding: its own words for the keys, its own dialog to change them. */
  it("shows the desktop's shortcut and opens its dialog through the portal", async () => {
    setup(null, wayland({ supported: true, via: "portal", unavailableMessage: null, command: null }));
    tauri.onInvoke("capture_get_shortcut", () => ({
      accelerator,
      defaultAccelerator: DEFAULT,
      desktopTrigger: "Meta+Shift+2",
      canChangeInDesktop: true,
    }));
    tauri.onInvoke("capture_configure_shortcut", () => null);
    // Turning it off and on reads again; the mock now answers the trigger.
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_shortcut", { accelerator: null }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_shortcut", { accelerator: DEFAULT }));
    expect(await screen.findByText("Meta+Shift+2")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]);
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_configure_shortcut"));
    // No key recorder here: the desktop takes the keys.
    expect(screen.queryByText(/Press the new shortcut/)).toBeNull();
  });

  it("says why when the desktop did not bind it", async () => {
    setup(null, wayland({ supported: true, via: "portal", unavailableMessage: null, command: null }));
    tauri.onInvoke("capture_get_shortcut", () => ({
      accelerator,
      defaultAccelerator: DEFAULT,
      problem: "The shortcut wasn't added because the desktop's dialog was closed. Turn it on to be asked again.",
    }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("the desktop's dialog was closed");
    // Only the drive row's Change: nothing is bound for the desktop to change.
    expect(screen.getAllByRole("button", { name: "Change" })).toHaveLength(1);
  });

  it("says on Wayland that the desktop's own tool takes the screenshot", async () => {
    const note = "Your desktop's screenshot tool opens, so you can choose an area, a window or a whole screen there.";
    setup(null, linux({ selection: "systemPicker", systemPickerNote: note, linuxSession: "wayland" }));
    expect(await screen.findByText(note)).toBeInTheDocument();
    expect(screen.getByText("Screenshots")).toBeInTheDocument();
  });
});
