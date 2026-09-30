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

type Actions = CapturePreviewCard["actions"];
const NO_ACTIONS: Actions = { retry: false, discard: false, copyLink: false, mintLink: false, revokeLink: false, reveal: false, upgrade: false };
const FILE = "Screenshot 2026-09-30 at 10.00.00.png";

const card = (
  status: CapturePreviewCard["status"],
  id = 1,
  actions: Partial<Actions> = {},
  over: Partial<CapturePreviewCard> = {},
): CapturePreviewCard => ({
  id,
  kind: "screenshot",
  fileName: FILE,
  driveLabel: "Work",
  driveName: "Work",
  remote: false,
  status,
  relPath: `Captures/${FILE}`,
  link: { state: "none" },
  actions: { ...NO_ACTIONS, ...actions },
  ...over,
});

const linked = (status: CapturePreviewCard["status"], id = 1, actions: Partial<Actions> = {}) =>
  card(status, id, { copyLink: true, ...actions }, { link: { state: "public", copied: true }, linkText: "Public link copied" });

const failed = (message: string, reason: "offline" | "storageFull" | "other" = "offline") => ({
  state: "failed" as const,
  message,
  reason,
  retryable: true,
});

const called = (cmd: string) => tauri.core.invoke.mock.calls.filter(([c]) => c === cmd).length;

const dismissed = () => tauri.core.invoke.mock.calls.filter(([c]) => c === "capture_preview_dismiss").length;
const listening = (event: string) => tauri.event.listen.mock.calls.filter(([e]) => e === event).length;

async function setup(first: CapturePreviewCard | null) {
  tauri.onInvoke("capture_preview_context", () => first);
  tauri.onInvoke("capture_preview_dismiss", () => null);
  for (const cmd of [
    "capture_preview_copy_link",
    "capture_preview_retry",
    "capture_preview_discard",
    "capture_preview_mint_link",
    "capture_preview_revoke_link",
    "capture_preview_reveal",
    "capture_preview_upgrade",
    "capture_preview_show_in_folder",
  ]) {
    tauri.onInvoke(cmd, () => null);
  }
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
    await setup(card({ state: "uploading" }));
    expect(screen.getByRole("button", { name: "Copy link" })).toBeDisabled();
  });

  it("says Copied for a moment, and a new card does not inherit it", async () => {
    await setup(linked({ state: "uploaded", linkCopied: true }));
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    await act(() => tauri.emitEvent("capture_preview_changed", card({ state: "uploading" }, 2)));
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("announces only its status line", async () => {
    await setup(linked({ state: "uploaded", linkCopied: true }));
    const live = document.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    // Rust words the link; the card says it as it is.
    expect(live[0]).toHaveTextContent("Uploaded · Public link copied");
    // Where it went has its own line.
    expect(screen.getByText("Work › Captures")).toBeInTheDocument();
  });

  it("keeps a long failure to one line, with the whole of it in the tooltip", async () => {
    const message = "The upload could not reach the server after several tries. It is kept, and Retry sends it again.";
    await setup(card(failed(message), 1, { retry: true, discard: true }));
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

describe("the card's actions (Rust decides which)", () => {
  it("retries or discards a failed capture", async () => {
    await setup(card(failed("offline"), 1, { retry: true, discard: true }));
    expect(screen.queryByRole("button", { name: /Upgrade/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(called("capture_preview_retry")).toBe(1);
    expect(called("capture_preview_discard")).toBe(1);
  });

  it("offers Upgrade when the plan is full, which opens the plans in the main window", async () => {
    await setup(card(failed("Your storage is full.", "storageFull"), 1, { retry: true, discard: true, upgrade: true }));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(called("capture_preview_upgrade")).toBe(1);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("points a synced capture that failed at its folder, with no Retry (the sync queue retries it)", async () => {
    await setup(card({ ...failed("offline"), retryable: false }));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show in folder" })).toBeInTheDocument();
  });

  it("offers Create link for a capture in the drive without one", async () => {
    await setup(card({ state: "uploaded", linkCopied: false }, 1, { mintLink: true }));
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(called("capture_preview_mint_link")).toBe(1);
  });

  it("reveals the file in the system's file manager", async () => {
    await setup(linked({ state: "uploaded", linkCopied: true }, 1, { reveal: true }));
    fireEvent.click(screen.getByRole("button", { name: /^Show in (Finder|Explorer|file manager)$/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(called("capture_preview_reveal")).toBe(1);
  });

  it("revokes the link from the More menu, and Escape closes the menu", async () => {
    await setup(linked({ state: "uploaded", linkCopied: true }, 1, { revokeLink: true }));
    const more = screen.getByRole("button", { name: "More" });
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "Revoke link" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(more).toHaveFocus();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Revoke link" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(called("capture_preview_revoke_link")).toBe(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers nothing Rust did not", async () => {
    await setup(card({ state: "uploaded", linkCopied: false }));
    for (const name of ["Retry", "Discard", "Upgrade", "Create link", "More"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /^Show in (Finder|Explorer|file manager)$/ })).toBeNull();
  });
});
