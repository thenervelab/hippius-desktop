import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { CapturePhase } from "@/app/lib/tauri/capture";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

import CaptureControlsPage from "../page";
import { discardNeedsConfirm } from "../discard";

const recording = (elapsedSecs: number): CapturePhase => ({ phase: "recording", elapsedSecs, microphone: false });
const called = (cmd: string) => tauri.core.invoke.mock.calls.some(([c]) => c === cmd);

function setup(phase: CapturePhase) {
  tauri.onInvoke("capture_state", () => phase);
  tauri.onInvoke("capture_camera_context", () => ({ shape: null, hidden: false, deviceId: null, deviceName: null, size: "small" }));
  tauri.onInvoke("capture_cancel", () => null);
  tauri.onInvoke("capture_stop", () => null);
  return render(<CaptureControlsPage />);
}

beforeEach(() => tauri.reset());

describe("discarding a recording", () => {
  it("asks first from five seconds on", () => {
    expect(discardNeedsConfirm(4)).toBe(false);
    expect(discardNeedsConfirm(5)).toBe(true);
  });

  it("throws a false start away at once", async () => {
    setup(recording(2));
    fireEvent.click(await screen.findByRole("button", { name: "Discard recording" }));
    await waitFor(() => expect(called("capture_cancel")).toBe(true));
  });

  it("asks before throwing a longer recording away, and Keep recording keeps it", async () => {
    setup(recording(90));
    fireEvent.click(await screen.findByRole("button", { name: "Discard recording" }));
    const dialog = screen.getByRole("alertdialog", { name: "Discard this recording?" });
    expect(dialog).toHaveTextContent("Nothing will be saved.");
    expect(screen.getByRole("button", { name: "Keep recording" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep recording" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(called("capture_cancel")).toBe(false);
  });

  it("discards on Discard", async () => {
    setup(recording(90));
    fireEvent.click(await screen.findByRole("button", { name: "Discard recording" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(called("capture_cancel")).toBe(true));
  });

  it("takes Escape at the question as Keep recording", async () => {
    setup(recording(90));
    fireEvent.click(await screen.findByRole("button", { name: "Discard recording" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(called("capture_cancel")).toBe(false);
  });

  // The pill turns key when clicked, so a stray Escape meant for another app
  // landed here and threw the recording away.
  it("does nothing on Escape, in any phase", async () => {
    setup(recording(90));
    await screen.findByRole("button", { name: "Pause recording" });
    fireEvent.keyDown(window, { key: "Escape" });
    await act(() => tauri.emitEvent("capture_state_changed", { phase: "capturing", kind: "recording" }));
    expect(screen.getByText("Starting recording…")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(called("capture_cancel")).toBe(false);
  });
});

describe("the pill", () => {
  // `-webkit-app-region` is Electron's; Tauri moves a window from this attribute.
  it("is draggable by its body", async () => {
    const { container } = setup(recording(3));
    await screen.findByRole("button", { name: "Stop recording" });
    expect(container.querySelector("[data-tauri-drag-region]")).toBeInTheDocument();
  });

  it("does not let a late first read put an older phase back", async () => {
    let answer: (p: CapturePhase) => void = () => undefined;
    tauri.onInvoke("capture_state", () => new Promise<CapturePhase>((r) => (answer = r)));
    tauri.onInvoke("capture_camera_context", () => ({ shape: null, hidden: false, deviceId: null, deviceName: null, size: "small" }));
    render(<CaptureControlsPage />);
    await act(() => tauri.emitEvent("capture_state_changed", { phase: "finalizing" }));
    await act(async () => answer(recording(10)));
    expect(screen.getByText("Saving recording…")).toBeInTheDocument();
  });
});
