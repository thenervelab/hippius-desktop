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
import { captureSupportedAtom } from "@/app/lib/capture/captureFlow";

const DEFAULT = "CommandOrControl+Shift+2";
let accelerator: string | null = DEFAULT;

function setup() {
  tauri.onInvoke("capture_get_shortcut", () => ({ accelerator, defaultAccelerator: DEFAULT }));
  tauri.onInvoke("capture_get_destination", () => ({ label: "Work", displayName: "Work" }));
  tauri.onInvoke("capture_set_shortcut", (args) => {
    accelerator = (args as { accelerator: string | null }).accelerator;
    return null;
  });
  const store = createStore();
  store.set(captureSupportedAtom, true);
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
    tauri.onInvoke("capture_get_destination", () => ({ label: "Work", displayName: "Work" }));
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
