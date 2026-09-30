import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);
vi.mock("@/app/lib/featureFlags", () => ({ SCREEN_CAPTURE_ENABLED: true }));

import TrayCaptureButton from "../TrayCaptureButton";

beforeEach(() => {
  tauri.reset();
  tauri.onInvoke("hide_tray_panel", () => null);
});

describe("the tray's Capture button", () => {
  it("is a labelled button, and hides the popover before asking the app to capture", async () => {
    tauri.onInvoke("capture_support", () => ({ supported: true, recording: true }));
    render(<TrayCaptureButton />);
    const button = await screen.findByRole("button", { name: "Capture" });
    fireEvent.click(button);
    await waitFor(() => expect(tauri.event.emit).toHaveBeenCalledWith("hippius:tray-capture", {}));
    const hide = tauri.core.invoke.mock.calls.findIndex(([c]) => c === "hide_tray_panel");
    const hideOrder = tauri.core.invoke.mock.invocationCallOrder[hide];
    expect(hideOrder).toBeLessThan(tauri.event.emit.mock.invocationCallOrder[0]);
  });

  // The header's other buttons must not jump sideways when support arrives.
  it("holds its place, hidden, while support is being asked", () => {
    tauri.onInvoke("capture_support", () => new Promise(() => undefined));
    const { container } = render(<TrayCaptureButton />);
    const slot = container.querySelector("button");
    expect(slot).toHaveClass("invisible");
    expect(slot).toBeDisabled();
  });

  it("is gone where the platform cannot capture", async () => {
    tauri.onInvoke("capture_support", () => ({ supported: false, recording: false }));
    const { container } = render(<TrayCaptureButton />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
