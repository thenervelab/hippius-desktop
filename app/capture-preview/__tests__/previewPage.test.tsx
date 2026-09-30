import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { CapturePreviewCard } from "@/app/lib/tauri/capture";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

import CapturePreviewPage from "../page";
import { AUTO_HIDE_MS } from "../previewCard";

const card = (status: CapturePreviewCard["status"], id = 1): CapturePreviewCard => ({
  id,
  kind: "screenshot",
  fileName: "Screenshot 2026-09-30 at 10.00.00.png",
  driveLabel: "Work",
  driveName: "Work",
  remote: false,
  status,
});

const dismissed = () => tauri.core.invoke.mock.calls.filter(([c]) => c === "capture_preview_dismiss").length;
const listening = (event: string) => tauri.event.listen.mock.calls.filter(([e]) => e === event).length;

async function setup(first: CapturePreviewCard | null) {
  tauri.onInvoke("capture_preview_context", () => first);
  tauri.onInvoke("capture_preview_dismiss", () => null);
  tauri.onInvoke("capture_preview_copy_link", () => null);
  const view = render(<CapturePreviewPage />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  tauri.reset();
  vi.useFakeTimers({ shouldAdvanceTime: false });
});
afterEach(() => vi.useRealTimers());

describe("the preview card", () => {
  it("slides away on its own once uploaded", async () => {
    await setup(card({ state: "uploaded", linkCopied: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_HIDE_MS + 10);
    });
    expect(dismissed()).toBe(1);
  });

  // Reaching for a button must never race the card.
  it("holds while the pointer is on it and starts the full time again on leave", async () => {
    await setup(card({ state: "uploaded", linkCopied: true }));
    const node = screen.getByTestId("capture-card");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_HIDE_MS - 1000);
    });
    fireEvent.pointerEnter(node);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_HIDE_MS * 2);
    });
    expect(dismissed()).toBe(0);
    // The timer bar stays put, paused, so the card does not change height.
    const bar = screen.getByTestId("auto-hide-timer").firstElementChild as HTMLElement;
    expect(bar.style.animationPlayState).toBe("paused");
    fireEvent.pointerLeave(node);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_HIDE_MS - 1000);
    });
    expect(dismissed()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(dismissed()).toBe(1);
  });

  it("offers Copy link only once a link exists", async () => {
    await setup(card({ state: "uploaded", linkCopied: false }));
    expect(screen.getByRole("button", { name: "Copy link" })).toBeDisabled();
  });

  it("says Copied for a moment, and a new card does not inherit it", async () => {
    await setup(card({ state: "uploaded", linkCopied: true }));
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    await act(() => tauri.emitEvent("capture_preview_changed", card({ state: "uploading" }, 2)));
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("announces only its status line", async () => {
    await setup(card({ state: "uploaded", linkCopied: true }));
    const live = document.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveTextContent("Uploaded · link copied");
    // Where it went has its own line.
    expect(screen.getByText("Work › Captures")).toBeInTheDocument();
  });

  it("keeps a long failure to one line, with the whole of it in the tooltip", async () => {
    const message = "The upload could not reach the server after several tries. It is kept, and Retry sends it again.";
    await setup(card({ state: "failed", message }));
    const line = screen.getByText(message);
    expect(line).toHaveClass("line-clamp-1");
    expect(line).toHaveAttribute("title", message);
  });

  // The card is prewarmed hidden at every capture start; the sync engine
  // emits up to four snapshots a second.
  it("listens to upload progress only while there is an upload", async () => {
    await setup(null);
    expect(listening("sync_progress_snapshot")).toBe(0);
    await act(() => tauri.emitEvent("capture_preview_changed", card({ state: "uploading" })));
    expect(listening("sync_progress_snapshot")).toBe(1);
    expect(listening("remote_upload_progress")).toBe(1);
    await act(() => tauri.emitEvent("capture_preview_changed", card({ state: "uploaded", linkCopied: true })));
    await act(() => tauri.emitEvent("sync_progress_snapshot", { files: [], effectiveInProgress: false }));
    // Unsubscribed: the listener set is empty again, so a new capture listens afresh.
    await act(() => tauri.emitEvent("capture_preview_changed", card({ state: "syncing", linkCopied: true }, 3)));
    expect(listening("sync_progress_snapshot")).toBe(2);
  });
});
