import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import CaptureDestinationDialog from "../CaptureDestinationDialog";
import { captureDialogAtom } from "@/app/lib/capture/captureFlow";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The real picker reads drive atoms and a remote listing; the dialog only
// needs a label back from it.
vi.mock("@/components/ui/SyncFolderSelect", () => ({
  default: ({ onChange }: { onChange: (label: string, path: string, remote: boolean) => void }) => (
    <button type="button" onClick={() => onChange("Work", "/Users/me/Work", false)}>
      pick Work
    </button>
  ),
}));

function renderOpen(
  resumeMode: "area" | "window" | "screen" | null,
  resumeKind: "screenshot" | "recording" | null = resumeMode ? "screenshot" : null,
) {
  const store = createStore();
  store.set(captureDialogAtom, {
    kind: "destination",
    resume: resumeMode && resumeKind ? { kind: resumeKind, mode: resumeMode } : null,
  });
  render(
    <Provider store={store}>
      <CaptureDestinationDialog />
    </Provider>,
  );
  return store;
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => (cmd === "capture_get_destination" ? null : undefined));
});

describe("CaptureDestinationDialog", () => {
  // The dialog opens BECAUSE a capture was refused for want of a drive; making
  // the user start that capture again after choosing one is the step it exists
  // to save.
  it("carries straight on into the capture that was waiting for a drive", async () => {
    const store = renderOpen("window");
    fireEvent.click(screen.getByText("pick Work"));
    fireEvent.click(screen.getByRole("button", { name: "Save and capture" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("capture_start", { kind: "screenshot", mode: "window" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("capture_set_destination", {
      destination: { label: "Work", displayName: "Work" },
    });
    // Saved before the capture starts, or the retry is refused the same way.
    const order = invokeMock.mock.calls.map(([cmd]) => cmd);
    expect(order.indexOf("capture_set_destination")).toBeLessThan(order.indexOf("capture_start"));
    expect(store.get(captureDialogAtom)).toBeNull();
  });

  it("only saves when opened to change the drive", async () => {
    renderOpen(null);
    fireEvent.click(screen.getByText("pick Work"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("capture_set_destination", expect.anything()));
    expect(invokeMock).not.toHaveBeenCalledWith("capture_start", expect.anything());
  });

  it("cannot be saved before a drive is picked", () => {
    renderOpen("area");
    expect(screen.getByRole("button", { name: "Save and capture" })).toBeDisabled();
  });
});
