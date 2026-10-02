import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

import MicMeter from "../MicMeter";

const calls = (cmd: string) => tauri.core.invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
const lit = (container: HTMLElement) => container.querySelectorAll(".bg-\\[\\#30D158\\]").length;

describe("the capture bar's microphone meter", () => {
  let generation = 0;
  const getUserMedia = vi.fn();

  beforeEach(() => {
    tauri.reset();
    generation = 0;
    tauri.onInvoke("capture_mic_meter_start", () => ++generation);
    tauri.onInvoke("capture_mic_meter_stop", () => null);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
    });
  });

  afterEach(() => {
    getUserMedia.mockReset();
  });

  /**
   * WebKit lets one page capture at a time: a microphone opened here muted
   * the camera bubble (black), and the bubble reopening muted this. The level
   * comes from Rust instead.
   */
  it("never opens the microphone in the webview", async () => {
    const { unmount } = render(<MicMeter deviceId="BuiltInMicrophoneDevice" />);
    await waitFor(() => expect(calls("capture_mic_meter_start")).toEqual([{ device: "BuiltInMicrophoneDevice" }]));
    unmount();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("lights bars from Rust's level and goes dark when unmounted", async () => {
    const { container, unmount } = render(<MicMeter deviceId={null} />);
    await waitFor(() => expect(calls("capture_mic_meter_start")).toEqual([{ device: null }]));
    await act(() => tauri.emitEvent("capture_mic_level", 0.6));
    expect(lit(container)).toBe(3);
    unmount();
    await waitFor(() => expect(calls("capture_mic_meter_stop")).toEqual([{ generation: 1 }]));
  });

  /** A stop that lands after the new start must not end the new meter. */
  it("stops only the meter it started when the microphone changes", async () => {
    const { rerender, unmount } = render(<MicMeter deviceId="a" />);
    await waitFor(() => expect(calls("capture_mic_meter_start")).toHaveLength(1));
    rerender(<MicMeter deviceId="b" />);
    await waitFor(() => expect(calls("capture_mic_meter_start")).toEqual([{ device: "a" }, { device: "b" }]));
    await waitFor(() => expect(calls("capture_mic_meter_stop")).toEqual([{ generation: 1 }]));
    unmount();
    await waitFor(() => expect(calls("capture_mic_meter_stop")).toEqual([{ generation: 1 }, { generation: 2 }]));
  });

  it("stays dark where there is no meter", async () => {
    tauri.onInvoke("capture_mic_meter_start", () => null);
    const { container, unmount } = render(<MicMeter deviceId={null} />);
    await waitFor(() => expect(calls("capture_mic_meter_start")).toHaveLength(1));
    expect(lit(container)).toBe(0);
    unmount();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls("capture_mic_meter_stop")).toEqual([]);
  });
});
