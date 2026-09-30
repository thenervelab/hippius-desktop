import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

import CapturePermissionDialog from "../CapturePermissionDialog";
import { captureDialogAtom, capturePermissionPaneAtom } from "@/app/lib/capture/captureFlow";

type Status = { state: "granted" | "notAsked" | "asked" | "stale"; adHocSigned: boolean };

/**
 * Answer each command the dialog calls. `status` may be a list: the dialog
 * re-reads it after every press, so a press can move it on.
 */
function backend(opts: { status?: Status | Status[]; request?: unknown; reset?: unknown; relaunch?: unknown }) {
  const statuses = Array.isArray(opts.status) ? [...opts.status] : [opts.status ?? { state: "asked", adHocSigned: false }];
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "capture_permission_status":
        return Promise.resolve(statuses.length > 1 ? statuses.shift() : statuses[0]);
      case "capture_request_permission":
        return opts.request instanceof Error || (opts.request && typeof opts.request === "object")
          ? Promise.reject(opts.request)
          : Promise.resolve(opts.request ?? "openedSettings");
      case "capture_reset_permission":
        return Promise.resolve(opts.reset ?? "prompted");
      case "capture_relaunch_for_permission":
        return opts.relaunch ? Promise.reject(opts.relaunch) : Promise.resolve();
      default:
        return Promise.reject(new Error(`unexpected ${cmd}`));
    }
  });
}

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
  it("names the pane as this Mac names it", async () => {
    backend({});
    renderOpen("Screen & System Audio Recording");
    expect(screen.getByText(/Privacy & Security → Screen & System Audio Recording/)).toBeInTheDocument();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("capture_permission_status"));
  });

  it("falls back to the older name when Rust could not tell", async () => {
    backend({});
    renderOpen(null);
    expect(screen.getByText(/Privacy & Security → Screen Recording/)).toBeInTheDocument();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("capture_permission_status"));
  });

  // First press for this build: Rust asks macOS, which is what puts Hippius
  // into the list. The dialog says what to do with macOS's message.
  it("offers Allow when macOS has not been asked, and explains the prompt", async () => {
    backend({ status: [{ state: "notAsked", adHocSigned: false }, { state: "asked", adHocSigned: false }], request: "prompted" });
    renderOpen("Screen Recording");
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("capture_request_permission"));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "macOS is asking now. Choose Open System Settings in its message, switch Hippius on, then relaunch Hippius.",
    );
    // Asked now: the next press opens System Settings.
    expect(await screen.findByRole("button", { name: "Open System Settings" })).toBeInTheDocument();
  });

  it("stays open, with no extra line, when Rust opened System Settings", async () => {
    backend({ status: { state: "asked", adHocSigned: false }, request: "openedSettings" });
    const store = renderOpen("Screen Recording");
    fireEvent.click(await screen.findByRole("button", { name: "Open System Settings" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("capture_request_permission"));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([c]) => c === "capture_permission_status")).toHaveLength(2));
    expect(store.get(captureDialogAtom)).toEqual({ kind: "permission" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("closes when the permission is already granted", async () => {
    backend({ request: "granted" });
    const store = renderOpen("Screen Recording");
    fireEvent.click(await screen.findByRole("button", { name: "Open System Settings" }));
    await waitFor(() => expect(store.get(captureDialogAtom)).toBeNull());
  });

  it("shows a refusal as a message", async () => {
    backend({ request: { kind: "Other", message: "Could not open System Settings." } });
    renderOpen("Screen Recording");
    fireEvent.click(await screen.findByRole("button", { name: "Open System Settings" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Could not open System Settings."));
  });

  // The relaunch goes through Rust, which remembers it; a plain restart
  // would leave a stale entry afterwards looking like "asked".
  it("relaunches through Rust", async () => {
    backend({});
    renderOpen("Screen Recording");
    fireEvent.click(screen.getByRole("button", { name: "Relaunch Hippius" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("capture_relaunch_for_permission"));
  });

  it("shows a failed relaunch", async () => {
    backend({ relaunch: { kind: "Other", message: "Could not restart." } });
    renderOpen("Screen Recording");
    fireEvent.click(screen.getByRole("button", { name: "Relaunch Hippius" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Could not restart."));
  });

  // Relaunched for the grant and still denied: an entry macOS will not
  // apply to this build. Say how to clear it and offer to do it.
  it("explains a stale entry and resets it with Allow again", async () => {
    backend({
      status: [{ state: "stale", adHocSigned: false }, { state: "asked", adHocSigned: false }],
      reset: "prompted",
    });
    renderOpen("Screen & System Audio Recording");
    expect(await screen.findByText(/still can.t record the screen after relaunching/)).toBeInTheDocument();
    expect(screen.getByText(/remove Hippius with the minus button, then press\s+Allow again/)).toBeInTheDocument();
    expect(screen.getByText("Screen & System Audio Recording")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open System Settings" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Allow again" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("capture_reset_permission"));
    expect(invokeMock).not.toHaveBeenCalledWith("capture_request_permission");
    expect(await screen.findByRole("status")).toHaveTextContent("macOS is asking now.");
    // Back to the ordinary steps, ready for the relaunch.
    expect(await screen.findByRole("button", { name: "Open System Settings" })).toBeInTheDocument();
  });

  it("gives the manual steps when the entry could not be reset", async () => {
    backend({
      status: [{ state: "stale", adHocSigned: false }, { state: "asked", adHocSigned: false }],
      reset: "openedSettings",
    });
    renderOpen("Screen Recording");
    fireEvent.click(await screen.findByRole("button", { name: "Allow again" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "couldn't remove the old entry itself. In Screen Recording, select Hippius, remove it with the minus button",
    );
  });

  it("warns that an ad hoc build loses the permission on every rebuild", async () => {
    backend({ status: { state: "notAsked", adHocSigned: true } });
    renderOpen("Screen Recording");
    expect(await screen.findByText(/built without a signing certificate/)).toBeInTheDocument();
  });

  it("says nothing about signing for a signed build", async () => {
    backend({ status: { state: "notAsked", adHocSigned: false } });
    renderOpen("Screen Recording");
    await screen.findByRole("button", { name: "Allow" });
    expect(screen.queryByText(/signing certificate/)).toBeNull();
  });
});
