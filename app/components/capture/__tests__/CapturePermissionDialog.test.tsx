import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

import CapturePermissionDialog from "../CapturePermissionDialog";
import { captureDialogAtom, capturePermissionPaneAtom } from "@/app/lib/capture/captureFlow";

function renderOpen(pane: string | null) {
  const store = createStore();
  store.set(captureDialogAtom, { kind: "permission" });
  store.set(capturePermissionPaneAtom, pane);
  render(
    <Provider store={store}>
      <CapturePermissionDialog />
    </Provider>,
  );
  return store;
}

beforeEach(() => {
  invokeMock.mockReset();
  toastError.mockReset();
});

describe("the Screen Recording permission dialog", () => {
  it("names the pane as this Mac names it", () => {
    renderOpen("Screen & System Audio Recording");
    expect(screen.getByText(/Privacy & Security → Screen & System Audio Recording/)).toBeInTheDocument();
  });

  it("falls back to the older name when Rust could not tell", () => {
    renderOpen(null);
    expect(screen.getByText(/Privacy & Security → Screen Recording/)).toBeInTheDocument();
  });

  // Rust decides: macOS's own prompt the first time, System Settings after.
  it("asks Rust, and says what to do when macOS is prompting", async () => {
    invokeMock.mockResolvedValue("prompted");
    renderOpen("Screen Recording");
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("capture_request_permission"));
    expect(await screen.findByText("macOS is asking now. Choose Allow, then relaunch Hippius.")).toBeInTheDocument();
  });

  it("stays open, with no extra line, when Rust opened System Settings", async () => {
    invokeMock.mockResolvedValue("openedSettings");
    const store = renderOpen("Screen Recording");
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("capture_request_permission"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(store.get(captureDialogAtom)).toEqual({ kind: "permission" });
    expect(screen.queryByText(/macOS is asking now/)).toBeNull();
  });

  it("closes when the permission is already granted", async () => {
    invokeMock.mockResolvedValue("granted");
    const store = renderOpen("Screen Recording");
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    await waitFor(() => expect(store.get(captureDialogAtom)).toBeNull());
  });

  it("shows a refusal as a message", async () => {
    invokeMock.mockRejectedValue({ kind: "Other", message: "Could not open System Settings." });
    renderOpen("Screen Recording");
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Could not open System Settings."));
  });
});
