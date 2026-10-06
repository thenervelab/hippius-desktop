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

const failed = (message: string, reason: "offline" | "storageFull" | "needsFolder" | "other" = "offline") => ({
  state: "failed" as const,
  message,
  reason,
  retryable: true,
});

const called = (cmd: string) => tauri.core.invoke.mock.calls.filter(([c]) => c === cmd).length;

const dismissed = () => tauri.core.invoke.mock.calls.filter(([c]) => c === "capture_preview_dismiss").length;
const listening = (event: string) => tauri.event.listen.mock.calls.filter(([e]) => e === event).length;

// Where Rust says the pointer is over the card's window; null is elsewhere.
// jsdom lays nothing out, so the card's box is 0 x 0 at the origin.
let pointer: [number, number] | null = null;

async function setup(first: CapturePreviewCard | null) {
  tauri.onInvoke("capture_preview_context", () => first);
  tauri.onInvoke("capture_preview_pointer", () => pointer);
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
    "capture_preview_edit",
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
  pointer = null;
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

  // Uploaded before its link was made: it stays until Rust says it settled,
  // so it can still say the link was copied.
  it("waits for its link before sliding away", async () => {
    await setup(
      card({ state: "uploaded", linkCopied: false }, 1, {}, { link: { state: "creating" }, linkText: "Creating link…", settled: false }),
    );
    expect(document.querySelector("[aria-live]")).toHaveTextContent("Uploaded · Creating link…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_HIDE_MS * 2);
    });
    expect(dismissed()).toBe(0);
    await act(() =>
      tauri.emitEvent(
        "capture_preview_changed",
        linked({ state: "uploaded", linkCopied: true }, 1),
      ),
    );
    expect(document.querySelector("[aria-live]")).toHaveTextContent("Uploaded · Public link copied");
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

  // macOS sends no hover to the card's window, which is never key: the card
  // asks Rust where the pointer is instead, and holds the same way.
  it("holds while Rust says the pointer is on it, though no hover event came", async () => {
    await setup(card({ state: "uploaded", linkCopied: true }));
    // A step at a time: React applies the poll's update when each act ends.
    const wait = async (ms: number) => {
      for (let t = 0; t < ms; t += 500) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });
      }
    };
    pointer = [0, 0];
    await wait(AUTO_HIDE_MS * 2);
    expect(dismissed()).toBe(0);
    pointer = [500, 500];
    await wait(AUTO_HIDE_MS - 1000);
    expect(dismissed()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(dismissed()).toBe(1);
  });

  // The first capture before anyone chose a folder: nothing went wrong, so
  // the card waits and its button asks for the folder.
  it("waits for a folder instead of saying the upload failed", async () => {
    await setup(card(failed("Kept on this computer. It uploads once you choose a folder.", "needsFolder"), 1, { retry: true }));
    expect(document.querySelector("[aria-live]")).toHaveTextContent("Waiting for a folder");
    expect(screen.queryByText("Couldn't upload")).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(called("capture_preview_retry")).toBe(1);
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

  it("reveals the file in the system's file manager from the More menu", async () => {
    await setup(linked({ state: "uploaded", linkCopied: true }, 1, { reveal: true }));
    // Not a button of its own on the row: the row keeps every label on one line.
    expect(screen.queryByRole("button", { name: /^Show in (Finder|Explorer|file manager)$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const reveal = screen.getByRole("menuitem", { name: /^Show in (Finder|Explorer|file manager)$/ });
    expect(reveal).toHaveFocus();
    fireEvent.click(reveal);
    await act(async () => {
      await Promise.resolve();
    });
    expect(called("capture_preview_reveal")).toBe(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves through the More menu with the arrow keys", async () => {
    await setup(linked({ state: "uploaded", linkCopied: true }, 1, { reveal: true, revokeLink: true }));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const [first, second] = screen.getAllByRole("menuitem");
    expect(first).toHaveFocus();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    expect(second).toHaveTextContent("Revoke link");
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(second).toHaveFocus();
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

  // "Show in folder" broke onto two lines beside Copy link, Show in Finder
  // and More. The row is now one primary, one compact secondary and at most
  // one icon button, and no label can wrap.
  it("keeps every action on one line, in every state", async () => {
    const states: CapturePreviewCard[] = [
      card({ state: "uploading" }),
      linked({ state: "syncing", linkCopied: true }, 1, { reveal: true, revokeLink: true }),
      linked({ state: "uploaded", linkCopied: true }, 1, { reveal: true, revokeLink: true }),
      card({ state: "uploaded", linkCopied: false }, 1, { mintLink: true, reveal: true }),
      card(failed("offline"), 1, { retry: true, discard: true }),
      card(failed("Your storage is full.", "storageFull"), 1, { retry: true, discard: true, upgrade: true }),
      card({ ...failed("offline"), retryable: false }),
    ];
    for (const [i, c] of states.entries()) {
      const view = await setup({ ...c, id: i + 1 });
      const row = screen.getByTestId("capture-actions");
      const buttons = Array.from(row.querySelectorAll("button"));
      expect(buttons.length, `state ${i}`).toBeLessThanOrEqual(3);
      for (const b of buttons) {
        const icon = b.classList.contains("size-8");
        if (!icon) expect(b, `state ${i}: ${b.textContent}`).toHaveClass("whitespace-nowrap");
        else expect(b, `state ${i}`).toHaveAttribute("aria-label");
      }
      // At most one takes the spare room; the rest are sized to their labels.
      expect(buttons.filter((b) => b.classList.contains("flex-1")).length, `state ${i}`).toBe(1);
      view.unmount();
    }
  });

  it("turns Discard into an icon when Upgrade and Retry are there too", async () => {
    await setup(card(failed("Your storage is full.", "storageFull"), 1, { retry: true, discard: true, upgrade: true }));
    const discard = screen.getByRole("button", { name: "Discard" });
    expect(discard).toHaveAttribute("title", "Discard");
    expect(discard).not.toHaveTextContent("Discard");
    fireEvent.click(discard);
    await act(async () => {
      await Promise.resolve();
    });
    expect(called("capture_preview_discard")).toBe(1);
  });

  // Like macOS's thumbnail opening Markup: a screenshot's picture opens the
  // editor, and the More menu says so in words for the keyboard.
  it("opens the editor from a screenshot's picture and from the More menu", async () => {
    await setup(linked({ state: "uploaded", linkCopied: true }, 1, { edit: true }));
    const picture = screen.getByRole("button", { name: `Edit ${FILE}` });
    fireEvent.click(picture);
    await act(async () => {
      await Promise.resolve();
    });
    expect(called("capture_preview_edit")).toBe(1);
    expect(called("capture_preview_show_in_folder")).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const item = screen.getByRole("menuitem", { name: "Edit screenshot" });
    expect(item).toHaveFocus();
    fireEvent.click(item);
    await act(async () => {
      await Promise.resolve();
    });
    expect(called("capture_preview_edit")).toBe(2);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the picture as Show in folder when Rust offers no Edit", async () => {
    await setup(linked({ state: "uploaded", linkCopied: true }, 1));
    expect(screen.getByRole("button", { name: `Show ${FILE} in its folder` })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Edit ${FILE}` })).toBeNull();
  });

  it("offers nothing Rust did not", async () => {
    await setup(card({ state: "uploaded", linkCopied: false }));
    for (const name of ["Retry", "Discard", "Upgrade", "Create link", "More"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /^Show in (Finder|Explorer|file manager)$/ })).toBeNull();
  });
});
