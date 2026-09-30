import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

const h = vi.hoisted(() => ({
  push: vi.fn(),
  toastError: vi.fn(),
  notifyFilesMutated: vi.fn(),
  openAppWindow: vi.fn(async () => undefined),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("sonner", () => ({ toast: { error: h.toastError } }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@/app/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Grw" }) }));
vi.mock("@/app/lib/utils/fileMutationEvents", () => ({ notifyFilesMutated: h.notifyFilesMutated }));
vi.mock("@/app/lib/tray/trayWindowActions", () => ({ openAppWindow: h.openAppWindow }));
vi.mock("@/app/lib/featureFlags", () => ({ SCREEN_CAPTURE_ENABLED: true }));
vi.mock("../CaptureDestinationDialog", () => ({ default: () => null }));
vi.mock("../CapturePermissionDialog", () => ({ default: () => null }));

import CaptureHost from "../CaptureHost";
import { useStartCapture } from "@/app/lib/capture/useStartCapture";
import { captureDialogAtom, capturePermissionPaneAtom, captureSupportedAtom } from "@/app/lib/capture/captureFlow";

beforeEach(() => {
  tauri.reset();
  h.push.mockReset();
  h.toastError.mockReset();
  h.notifyFilesMutated.mockReset();
  h.openAppWindow.mockClear();
  tauri.onInvoke("capture_support", () => ({
    supported: true,
    recording: true,
    cameraOnly: true,
    screenRecordingPermission: true,
    permissionPane: "Screen & System Audio Recording",
  }));
  tauri.onInvoke("capture_sync_shortcut", () => null);
  tauri.onInvoke("capture_start", () => null);
});

function mountHost() {
  const store = createStore();
  render(
    <Provider store={store}>
      <CaptureHost />
    </Provider>,
  );
  return store;
}

describe("CaptureHost", () => {
  it("learns what the platform can do and registers the saved shortcut", async () => {
    const store = mountHost();
    await waitFor(() => expect(store.get(captureSupportedAtom)).toBe(true));
    expect(store.get(capturePermissionPaneAtom)).toBe("Screen & System Audio Recording");
    await waitFor(() => expect(tauri.core.invoke.mock.calls.some(([c]) => c === "capture_sync_shortcut")).toBe(true));
  });

  it("opens the drive's Captures folder on Show in folder", async () => {
    mountHost();
    await act(() =>
      tauri.emitEvent("capture_show_in_folder", { label: "Work", remote: false, subfolder: "Captures", fileName: "a.png" }),
    );
    // The capture's own name rides along, so its row is pointed out.
    expect(h.push).toHaveBeenCalledWith("/files?openLabel=Work&openSubfolder=Captures&openFile=a.png");
  });

  it("refreshes the file lists when a capture lands, and says when one failed", async () => {
    mountHost();
    await act(() => tauri.emitEvent("capture_delivered", { fileName: "a.png" }));
    expect(h.notifyFilesMutated).toHaveBeenCalledWith({}, "5Grw");
    await act(() => tauri.emitEvent("capture_failed", { message: "Could not upload the capture.", cardShowing: false }));
    expect(h.toastError).toHaveBeenCalledWith("Could not upload the capture.");
  });

  // The preview card already says it; a toast would say it twice.
  it("leaves a failure the card is showing to the card", async () => {
    mountHost();
    await act(() => tauri.emitEvent("capture_failed", { message: "Could not upload the capture.", cardShowing: true }));
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("opens the plans on the card's Upgrade", async () => {
    mountHost();
    await act(() => tauri.emitEvent("capture_open_plans", null));
    expect(h.push).toHaveBeenCalledWith("/settings?section=billing");
  });

  it("starts a capture from the shortcut and the tray, on the last mode or the asked one", async () => {
    mountHost();
    await act(() => tauri.emitEvent("capture_shortcut_pressed", null));
    expect(tauri.core.invoke).toHaveBeenCalledWith("capture_start", { kind: null, mode: null });
    await act(() => tauri.emitEvent("hippius:tray-capture", { kind: "screenshot", mode: "area" }));
    expect(tauri.core.invoke).toHaveBeenCalledWith("capture_start", { kind: "screenshot", mode: "area" });
  });
});

describe("useStartCapture's answer to a refusal", () => {
  function hook() {
    const store = createStore();
    const wrapper = ({ children }: { children: React.ReactNode }) => <Provider store={store}>{children}</Provider>;
    const { result } = renderHook(() => useStartCapture(), { wrapper });
    return { store, start: result.current };
  }

  it("brings the app forward and asks for a drive, resuming the same capture after", async () => {
    tauri.onInvoke("capture_start", () => {
      throw { kind: "NotReady", subkind: "CAPTURE_DESTINATION_UNSET", message: "Choose a drive" };
    });
    const { store, start } = hook();
    await act(() => start("recording", "window"));
    expect(h.openAppWindow).toHaveBeenCalled();
    expect(store.get(captureDialogAtom)).toEqual({ kind: "destination", resume: { kind: "recording", mode: "window" } });
  });

  it("brings the app forward and explains the macOS permission", async () => {
    tauri.onInvoke("capture_start", () => {
      throw { kind: "NotReady", subkind: "SCREEN_RECORDING_PERMISSION", message: "Allow screen recording" };
    });
    const { store, start } = hook();
    await act(() => start());
    expect(h.openAppWindow).toHaveBeenCalled();
    expect(store.get(captureDialogAtom)).toEqual({ kind: "permission" });
  });

  it("shows anything else as a message, without a dialog", async () => {
    tauri.onInvoke("capture_start", () => {
      throw { kind: "Validation", message: "Screen capture is not supported here yet." };
    });
    const { store, start } = hook();
    await act(() => start());
    expect(h.toastError).toHaveBeenCalledWith("Screen capture is not supported here yet.");
    expect(store.get(captureDialogAtom)).toBeNull();
    expect(h.openAppWindow).not.toHaveBeenCalled();
  });
});
