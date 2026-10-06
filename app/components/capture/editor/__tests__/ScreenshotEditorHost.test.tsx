import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

const h = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  notifyFilesMutated: vi.fn(async () => undefined),
}));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/app/lib/utils/fileMutationEvents", () => ({ notifyFilesMutated: h.notifyFilesMutated }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ id: "qc" }) }));
vi.mock("@/app/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Abc" }) }));
// `next/dynamic` resolves the real editor; the stand-in shows which session
// is open and lets the test close it with or without a save.
vi.mock("next/dynamic", () => ({
  default: () =>
    function FakeEditor({ onClose }: { onClose: (o: unknown) => void }) {
      return (
        <div role="dialog" aria-label="editor">
          <button type="button" onClick={() => onClose(null)}>
            close
          </button>
          <button
            type="button"
            onClick={() => onClose({ title: "Saved a copy", message: "Saved as \"a (edited).png\" next to the original.", fileName: "a (edited).png", offerLink: true })}
          >
            save copy
          </button>
          <button type="button" onClick={() => onClose({ title: "Saved", message: "Saved. Links you shared before still show the earlier picture.", fileName: "a.png", offerLink: false })}>
            save stale
          </button>
        </div>
      );
    },
}));

import ScreenshotEditorHost from "../ScreenshotEditorHost";

beforeEach(() => {
  tauri.reset();
  tauri.onInvoke("capture_editor_context", () => null);
  h.toast.success.mockClear();
  h.toast.error.mockClear();
  h.notifyFilesMutated.mockClear();
});

describe("the editor in the main window", () => {
  it("opens over the page when Rust says a picture is open, and closes without a toast", async () => {
    render(<ScreenshotEditorHost />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => tauri.emitEvent("capture_editor_open", 3));
    expect(screen.getByRole("dialog", { name: "editor" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.notifyFilesMutated).not.toHaveBeenCalled();
  });

  it("shows a picture already open when the window loads", async () => {
    tauri.onInvoke("capture_editor_context", () => ({ session: 9 }));
    render(<ScreenshotEditorHost />);
    expect(await screen.findByRole("dialog", { name: "editor" })).toBeInTheDocument();
  });

  it("after a save, refreshes the file lists and offers Copy link, which Rust answers", async () => {
    tauri.onInvoke("capture_editor_copy_saved_link", () => ({ status: "copied", url: "https://x/s/1", reused: false }));
    render(<ScreenshotEditorHost />);
    await act(async () => tauri.emitEvent("capture_editor_open", 4));
    fireEvent.click(screen.getByRole("button", { name: "save copy" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(h.notifyFilesMutated).toHaveBeenCalledWith({ id: "qc" }, "5Abc");
    const [title, options] = h.toast.success.mock.calls[0] as [string, { description: string; action: { label: string; onClick: () => void } }];
    expect(title).toBe("Saved a copy");
    expect(options.description).toContain("next to the original");
    expect(options.action.label).toBe("Copy link");
    await act(async () => options.action.onClick());
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Link copied"));
    expect(tauri.core.invoke.mock.calls.some(([c]) => c === "capture_editor_copy_saved_link")).toBe(true);
  });

  it("offers no Copy link when Rust has none to give, and says Rust's reason when copying fails", async () => {
    render(<ScreenshotEditorHost />);
    await act(async () => tauri.emitEvent("capture_editor_open", 5));
    fireEvent.click(screen.getByRole("button", { name: "save stale" }));
    const [, options] = h.toast.success.mock.calls[0] as [string, { action?: unknown }];
    expect(options.action).toBeUndefined();

    tauri.onInvoke("capture_editor_copy_saved_link", () => ({ status: "failed", message: "You're offline. Create the link when you're back online." }));
    await act(async () => tauri.emitEvent("capture_editor_open", 6));
    fireEvent.click(screen.getByRole("button", { name: "save copy" }));
    const [, withLink] = h.toast.success.mock.calls[1] as [string, { action: { onClick: () => void } }];
    await act(async () => withLink.action.onClick());
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("You're offline. Create the link when you're back online."));
  });
});
