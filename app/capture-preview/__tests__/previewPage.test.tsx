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
  card(status, id, { copyLink: true, ...actions }, {
    link: { state: "public", copied: true },
    linkText: "Public link copied",
    linkNote: "Anyone with the link can view. Never expires.",
  });

const failed = (message: string, reason: "offline" | "storageFull" | "needsFolder" | "other" = "offline") => ({
  state: "failed" as const,
  message,
  reason,
  retryable: true,
});

const called = (cmd: string) => tauri.core.invoke.mock.calls.filter(([c]) => c === cmd).length;

const dismissed = () => tauri.core.invoke.mock.calls.filter(([c]) => c === "capture_preview_dismiss").length;
const listening = (event: string) => tauri.event.listen.mock.calls.filter(([e]) => e === event).length;

/** Moves the fake clock on, `performance.now()` included, and lets React catch up. */
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

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

  // Reaching for a button must never race the card, and leaving it must not
  // start the wait over: it goes when the time it had left runs out.
  it("holds while the pointer is on it and runs on with the time it had left", async () => {
    await setup(card({ state: "uploaded", linkCopied: true }));
    const node = screen.getByTestId("capture-card");
    const bar = () => screen.getByTestId("auto-hide-timer").firstElementChild as HTMLElement;
    expect(bar().style.animationPlayState).toBe("running");
    expect(bar().style.animationDelay).toBe("0ms");
    await advance(6_000);
    fireEvent.pointerEnter(node);
    await advance(AUTO_HIDE_MS * 2);
    expect(dismissed()).toBe(0);
    // The timer bar stays put, paused where the countdown stopped, so the
    // card does not change height.
    expect(bar().style.animationPlayState).toBe("paused");
    expect(bar().style.animationDelay).toBe("-6000ms");
    fireEvent.pointerLeave(node);
    // And carries on from that same point.
    expect(bar().style.animationPlayState).toBe("running");
    expect(bar().style.animationDelay).toBe("-6000ms");
    await advance(3_900);
    expect(dismissed()).toBe(0);
    await advance(200);
    expect(dismissed()).toBe(1);
  });

  // Pointed at while it uploads: the countdown starts held when the link
  // settles, and the whole time is still there once the pointer leaves.
  it("starts held when the pointer is already on it as it settles", async () => {
    await setup(card({ state: "uploading" }));
    fireEvent.pointerEnter(screen.getByTestId("capture-card"));
    await act(() => tauri.emitEvent("capture_preview_changed", card({ state: "uploaded", linkCopied: true })));
    const bar = screen.getByTestId("auto-hide-timer").firstElementChild as HTMLElement;
    expect(bar.style.animationPlayState).toBe("paused");
    expect(bar.style.animationDelay).toBe("0ms");
    await advance(AUTO_HIDE_MS * 2);
    expect(dismissed()).toBe(0);
    fireEvent.pointerLeave(screen.getByTestId("capture-card"));
    await advance(AUTO_HIDE_MS - 100);
    expect(dismissed()).toBe(0);
    await advance(200);
    expect(dismissed()).toBe(1);
  });

  it("adds several holds up to the whole time", async () => {
    await setup(card({ state: "uploaded", linkCopied: true }));
    const node = screen.getByTestId("capture-card");
    for (const ran of [2_000, 3_000, 4_000]) {
      await advance(ran);
      fireEvent.pointerEnter(node);
      await advance(AUTO_HIDE_MS * 3);
      fireEvent.pointerLeave(node);
    }
    // Nine seconds ran in three goes: one is left.
    await advance(900);
    expect(dismissed()).toBe(0);
    await advance(200);
    expect(dismissed()).toBe(1);
  });

  it("keeps only the moment that was left after a hold near the end", async () => {
    await setup(card({ state: "uploaded", linkCopied: true }));
    const node = screen.getByTestId("capture-card");
    await advance(AUTO_HIDE_MS - 250);
    fireEvent.pointerEnter(node);
    await advance(AUTO_HIDE_MS * 6);
    expect(dismissed()).toBe(0);
    fireEvent.pointerLeave(node);
    await advance(200);
    expect(dismissed()).toBe(0);
    await advance(100);
    expect(dismissed()).toBe(1);
  });

  // macOS sends no hover to the card's window, which is never key: the card
  // asks Rust where the pointer is instead, and holds the same way.
  it("holds while Rust says the pointer is on it, though no hover event came", async () => {
    await setup(card({ state: "uploaded", linkCopied: true }));
    // A step at a time: React applies the poll's update when each act ends.
    const wait = async (ms: number) => {
      for (let t = 0; t < ms; t += 500) {
        await advance(500);
      }
    };
    await wait(5_000);
    pointer = [0, 0];
    await wait(AUTO_HIDE_MS * 2);
    expect(dismissed()).toBe(0);
    pointer = [500, 500];
    // About five seconds were left, not the whole time again.
    await wait(4_000);
    expect(dismissed()).toBe(0);
    await wait(1_500);
    expect(dismissed()).toBe(1);
  });

  // On Windows and Linux the keyboard can reach the card's buttons; focus
  // there holds it like the pointer, and leaving runs on with what was left.
  it("holds while keyboard focus is in it", async () => {
    await setup(linked({ state: "uploaded", linkCopied: true }, 1, { reveal: true }));
    await advance(7_000);
    const copy = screen.getByRole("button", { name: "Copy link" });
    act(() => copy.focus());
    await advance(AUTO_HIDE_MS * 2);
    // Moving to the next button keeps it held.
    act(() => screen.getByRole("button", { name: "More" }).focus());
    await advance(AUTO_HIDE_MS * 2);
    expect(dismissed()).toBe(0);
    act(() => (document.activeElement as HTMLElement).blur());
    await advance(2_900);
    expect(dismissed()).toBe(0);
    await advance(200);
    expect(dismissed()).toBe(1);
  });

  // A clicked button keeps focus on Windows, with no focus ring: that is the
  // pointer's business, or the card would stay until the window lost focus.
  it("is not held by a click's focus, which draws no focus ring", async () => {
    await setup(linked({ state: "uploaded", linkCopied: true }));
    const copy = screen.getByRole("button", { name: "Copy link" });
    const matches = copy.matches.bind(copy);
    vi.spyOn(copy, "matches").mockImplementation((selector: string) => selector !== ":focus-visible" && matches(selector));
    act(() => copy.focus());
    await advance(AUTO_HIDE_MS + 10);
    expect(dismissed()).toBe(1);
  });

  // A WebView that cannot read `:focus-visible` holds on any focus. Switching
  // to another app leaves the button as the page's active element, so the
  // card must still let go then, and stay let go when it draws again.
  it("lets go when its window loses focus, even where any focus holds it", async () => {
    await setup(linked({ state: "uploaded", linkCopied: true }));
    await advance(3_000);
    const copy = screen.getByRole("button", { name: "Copy link" });
    const matches = copy.matches.bind(copy);
    vi.spyOn(copy, "matches").mockImplementation((selector: string) => {
      if (selector === ":focus-visible") throw new SyntaxError(`unknown selector ${selector}`);
      return matches(selector);
    });
    act(() => copy.focus());
    await advance(AUTO_HIDE_MS);
    expect(dismissed()).toBe(0);
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      fireEvent.blur(copy);
      expect(copy).toHaveFocus();
      // Anything that draws the card again: here a pointer passing over it.
      fireEvent.pointerEnter(screen.getByTestId("capture-card"));
      fireEvent.pointerLeave(screen.getByTestId("capture-card"));
      await advance(6_900);
      expect(dismissed()).toBe(0);
      await advance(200);
      expect(dismissed()).toBe(1);
    } finally {
      hasFocus.mockRestore();
    }
  });

  // The item that had the keyboard goes with its menu, and no blur reaches
  // the card: it must still let go.
  it("lets go once a menu item chosen from the keyboard closes the menu", async () => {
    await setup(linked({ state: "uploaded", linkCopied: true }, 1, { revokeLink: true }));
    await advance(4_000);
    const more = screen.getByRole("button", { name: "More" });
    act(() => more.focus());
    fireEvent.click(more);
    const revoke = screen.getByRole("menuitem", { name: "Revoke link" });
    expect(revoke).toHaveFocus();
    await advance(AUTO_HIDE_MS * 2);
    expect(dismissed()).toBe(0);
    fireEvent.click(revoke);
    expect(screen.queryByRole("menu")).toBeNull();
    await advance(5_900);
    expect(dismissed()).toBe(0);
    await advance(200);
    expect(dismissed()).toBe(1);
  });

  it("gives a newly settled card the whole time", async () => {
    await setup(card({ state: "uploaded", linkCopied: true }));
    await advance(8_000);
    fireEvent.pointerEnter(screen.getByTestId("capture-card"));
    await act(() => tauri.emitEvent("capture_preview_changed", card({ state: "uploading" }, 2)));
    await act(() => tauri.emitEvent("capture_preview_changed", card({ state: "uploaded", linkCopied: true }, 2)));
    fireEvent.pointerLeave(screen.getByTestId("capture-card"));
    await advance(AUTO_HIDE_MS - 100);
    expect(dismissed()).toBe(0);
    await advance(200);
    expect(dismissed()).toBe(1);
    expect(tauri.core.invoke.mock.calls.find(([c]) => c === "capture_preview_dismiss")?.[1]).toEqual({ id: 2 });
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
    // Who can open the link has its own line, with where it went in its tooltip.
    expect(screen.getByText("Anyone with the link can view. Never expires.")).toHaveAttribute("title", "Work › Captures");
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

  // A capture's link is public and never expires; the card says so in the
  // destination's place, so it keeps its height, and More opens Shared Links.
  it("says a public link never expires, and opens Shared Links to change it", async () => {
    await setup(linked({ state: "uploaded", linkCopied: true }, 1, { revokeLink: true, manageLink: true }));
    const note = screen.getByTestId("capture-link-note");
    expect(note).toHaveTextContent("Anyone with the link can view. Never expires.");
    expect(note).toHaveClass("truncate");
    expect(note).toHaveAttribute("title", "Work › Captures");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage link" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(called("capture_preview_manage_link")).toBe(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers Manage link only when Rust does", async () => {
    await setup(linked({ state: "uploaded", linkCopied: true }, 1, { revokeLink: true }));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: "Manage link" })).toBeNull();
  });

  // "Show in folder" broke onto two lines beside Copy link, Show in Finder
  // and More. The row is now one primary, one compact secondary and at most
  // one icon button, and no label can wrap.
  it("keeps every action on one line, in every state", async () => {
    const states: CapturePreviewCard[] = [
      card({ state: "uploading" }),
      linked({ state: "syncing", linkCopied: true }, 1, { reveal: true, revokeLink: true }),
      linked({ state: "uploaded", linkCopied: true }, 1, { reveal: true, revokeLink: true, manageLink: true }),
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

describe("a recording stopped at the Free plan's limit", () => {
  const NOTICE = "Free recordings stop at 5 minutes. Upgrade for longer recordings.";
  const capped = (status: CapturePreviewCard["status"], actions: Partial<Actions> = {}) =>
    card(status, 1, { upgrade: true, ...actions }, { kind: "recording", notice: NOTICE, settled: false });

  it("says why in Rust's words, with Upgrade where Show in folder was", async () => {
    await setup(capped({ state: "uploaded", linkCopied: true }, { copyLink: true }));
    expect(screen.getByTestId("capture-notice")).toHaveTextContent(NOTICE);
    expect(screen.queryByText("Work › Captures")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show in folder" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(called("capture_preview_upgrade")).toBe(1);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled();
  });

  // Rust holds the card (not settled) so the line is not missed.
  it("stays until it is closed", async () => {
    await setup(capped({ state: "uploaded", linkCopied: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_HIDE_MS * 2);
    });
    expect(dismissed()).toBe(0);
  });

  it("keeps its actions on one line while it uploads and once it is in", async () => {
    const states = [
      capped({ state: "uploading" }),
      capped({ state: "syncing", linkCopied: true }, { copyLink: true, reveal: true, revokeLink: true }),
    ];
    for (const [i, c] of states.entries()) {
      const view = await setup({ ...c, id: i + 1 });
      const buttons = Array.from(screen.getByTestId("capture-actions").querySelectorAll("button"));
      expect(buttons.length, `state ${i}`).toBeLessThanOrEqual(3);
      expect(buttons.filter((b) => b.classList.contains("flex-1")).length, `state ${i}`).toBe(1);
      view.unmount();
    }
  });

  it("shows the drive as before for any other card", async () => {
    await setup(card({ state: "uploaded", linkCopied: true }));
    expect(screen.queryByTestId("capture-notice")).toBeNull();
    expect(screen.getByText("Work › Captures")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show in folder" })).toBeInTheDocument();
  });
});
