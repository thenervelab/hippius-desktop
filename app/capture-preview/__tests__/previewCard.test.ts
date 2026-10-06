import { describe, expect, it } from "vitest";
import { cardView, destinationText, wantsProgress } from "@/app/capture-preview/previewCard";
import type { CapturePreviewCard } from "@/app/lib/tauri/capture";
import type { RemoteUploadProgress } from "@/app/lib/remote-upload/remoteUploadFeed";
import type { FileProgress } from "@/app/lib/types/syncSnapshot";

const NAME = "Recording 2026-09-29 at 15.42.10.mp4";

const NO_ACTIONS = { retry: false, discard: false, copyLink: false, mintLink: false, revokeLink: false, reveal: false, upgrade: false };

const card = (status: CapturePreviewCard["status"], over: Partial<CapturePreviewCard> = {}): CapturePreviewCard => ({
  id: 1,
  kind: "recording",
  fileName: NAME,
  driveLabel: "Work",
  driveName: "Work",
  remote: false,
  status,
  relPath: `Captures/${NAME}`,
  link: { state: "none" },
  actions: NO_ACTIONS,
  ...over,
});

const failed = (message = "offline") => ({ state: "failed" as const, message, reason: "offline" as const, retryable: true });

const remote = (over: Partial<RemoteUploadProgress> = {}): RemoteUploadProgress => ({
  batchId: 1,
  path: `Captures/${NAME}`,
  fileName: NAME,
  label: "Work",
  bytesTransferred: 62,
  totalBytes: 100,
  status: "inProgress",
  ...over,
});

const engine = (over: Partial<FileProgress> = {}): FileProgress =>
  ({
    path: `/Users/me/Work/Captures/${NAME}`,
    fileName: NAME,
    label: "Work",
    action: "upload",
    status: "inProgress",
    progressPercent: 40,
    bytesEncrypted: 100,
    bytesTransferred: 40,
    totalBytes: 100,
    ...over,
  }) as FileProgress;

describe("a direct upload", () => {
  it("follows this capture's own upload row", () => {
    expect(cardView(card({ state: "uploading" }), remote(), []).text).toBe("Uploading · 62%");
  });

  it("ignores another file's row, or the same name in another drive", () => {
    expect(cardView(card({ state: "uploading" }), remote({ path: "Captures/x.png" }), []).percent).toBeNull();
    expect(cardView(card({ state: "uploading" }), remote({ label: "Photos" }), []).percent).toBeNull();
  });

  it("holds at 99 until Rust says it is uploaded, then says Rust's line about the link", () => {
    expect(cardView(card({ state: "uploading" }), remote({ bytesTransferred: 100 }), []).percent).toBe(99);
    const done = cardView(card({ state: "uploaded", linkCopied: true }, { linkText: "Public link copied" }), null, []);
    expect(done).toMatchObject({ percent: 100, done: true, text: "Uploaded · Public link copied" });
    expect(cardView(card({ state: "uploaded", linkCopied: false }), null, []).text).toBe("Uploaded");
  });

  it("says it failed; Rust's reason is on its own line", () => {
    expect(cardView(card(failed()), null, [])).toMatchObject({ failed: true, waiting: false, done: false, text: "Couldn't upload" });
  });

  it("waits, not fails, while nobody has chosen where captures go", () => {
    const waiting = card({ state: "failed", message: "Kept", reason: "needsFolder", retryable: true });
    expect(cardView(waiting, null, [])).toMatchObject({ failed: true, waiting: true, text: "Waiting for a folder" });
  });
});

describe("a capture in a synced drive", () => {
  const syncing = card({ state: "syncing", linkCopied: true });

  it("waits for the sync queue to pick it up", () => {
    expect(cardView(syncing, null, [])).toMatchObject({ percent: null, text: "Saved · waiting for sync", done: false });
  });

  it("follows the sync engine's row for this file, joined on its path in the drive", () => {
    expect(cardView(syncing, null, [engine()]).text).toBe("Uploading · 40%");
    expect(cardView(syncing, null, [engine({ label: "Other" })]).percent).toBeNull();
    // Same name, another folder: not this capture.
    expect(cardView(syncing, null, [engine({ path: `/Users/me/Work/Old/${NAME}` })]).percent).toBeNull();
    // A Windows path joins too.
    expect(cardView(syncing, null, [engine({ path: `C:\\Users\\me\\Work\\Captures\\${NAME}` })]).percent).toBe(40);
  });

  // Rust follows the row and moves the card itself; a progress row never
  // finishes or fails the card on its own.
  it("leaves done and failed to Rust", () => {
    expect(cardView(syncing, null, [engine({ status: "completed", bytesTransferred: 100 })])).toMatchObject({
      done: false,
      failed: false,
      percent: 99,
    });
    expect(cardView(syncing, null, [engine({ status: "error" })])).toMatchObject({ done: false, failed: false });
    expect(cardView(card({ state: "uploaded", linkCopied: true }), null, [])).toMatchObject({ done: true });
  });
});

describe("wantsProgress", () => {
  it("listens only while there is an upload to follow", () => {
    expect(wantsProgress(null)).toBe(false);
    expect(wantsProgress(card({ state: "uploading" }))).toBe(true);
    expect(wantsProgress(card({ state: "syncing", linkCopied: false }))).toBe(true);
    expect(wantsProgress(card({ state: "uploaded", linkCopied: true }))).toBe(false);
    expect(wantsProgress(card(failed("x")))).toBe(false);
  });
});

it("names where the file went", () => {
  expect(destinationText(card({ state: "uploading" }))).toBe("Work › Captures");
});

describe("following a synced capture", () => {
  // A name macOS wrote decomposed ("e" plus a combining accent) is the same
  // file as the composed name Rust gave the card.
  it("joins the engine's row in either Unicode form", () => {
    const composed = "Capture d\u2019\u00e9cran 2026-09-30 \u00e0 13.53.34.png";
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    const c = card({ state: "syncing", linkCopied: true }, { fileName: composed, relPath: `Captures/${composed}` });
    const row = engine({ path: `Captures/${decomposed}`, fileName: decomposed });
    expect(cardView(c, null, [row]).text).toBe("Uploading · 40%");
  });

  it("is finished only when Rust says it settled", () => {
    const creating = card({ state: "uploaded", linkCopied: false }, { link: { state: "creating" }, settled: false });
    expect(cardView(creating, null, [])).toMatchObject({ done: true, settled: false });
    const settled = card({ state: "uploaded", linkCopied: true }, { settled: true });
    expect(cardView(settled, null, [])).toMatchObject({ done: true, settled: true });
    // A card from before Rust sent `settled` is finished once uploaded.
    expect(cardView(card({ state: "uploaded", linkCopied: true }), null, []).settled).toBe(true);
    expect(cardView(card({ state: "syncing", linkCopied: true }), null, []).settled).toBe(false);
  });
});
