import { describe, expect, it } from "vitest";
import { canRetry, cardView, destinationText } from "@/app/capture-preview/previewCard";
import type { CapturePreviewCard } from "@/app/lib/tauri/capture";
import type { RemoteUploadProgress } from "@/app/lib/remote-upload/remoteUploadFeed";
import type { FileProgress } from "@/app/lib/types/syncSnapshot";

const NAME = "Recording 2026-09-29 at 15.42.10.mp4";

const card = (status: CapturePreviewCard["status"]): CapturePreviewCard => ({
  id: 1,
  kind: "recording",
  fileName: NAME,
  driveLabel: "Work",
  driveName: "Work",
  remote: false,
  status,
});

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
    expect(cardView(card({ state: "uploading" }), remote({ fileName: "x.png" }), []).percent).toBeNull();
    expect(cardView(card({ state: "uploading" }), remote({ label: "Photos" }), []).percent).toBeNull();
  });

  it("holds at 99 until Rust says it is uploaded", () => {
    expect(cardView(card({ state: "uploading" }), remote({ bytesTransferred: 100 }), []).percent).toBe(99);
    const done = cardView(card({ state: "uploaded", linkCopied: true }), null, []);
    expect(done).toMatchObject({ percent: 100, done: true, text: "Uploaded · link copied" });
  });

  it("offers Retry when it failed", () => {
    expect(cardView(card({ state: "failed", message: "offline" }), null, []).failed).toBe(true);
    expect(canRetry(card({ state: "failed", message: "offline" }))).toBe(true);
    expect(canRetry(card({ state: "syncing", linkCopied: true }))).toBe(false);
  });
});

describe("a capture in a synced drive", () => {
  const syncing = card({ state: "syncing", linkCopied: true });

  it("waits for the sync queue to pick it up", () => {
    expect(cardView(syncing, null, [])).toMatchObject({ percent: null, text: "Saved · waiting for sync", done: false });
  });

  it("follows the sync engine's row for this file", () => {
    expect(cardView(syncing, null, [engine()]).text).toBe("Uploading · 40%");
    expect(cardView(syncing, null, [engine({ label: "Other" })]).percent).toBeNull();
  });

  it("is done when the sync engine says so, not before", () => {
    expect(cardView(syncing, null, [engine({ status: "completed" })])).toMatchObject({ done: true, percent: 100 });
    expect(cardView(syncing, null, [engine({ status: "error" })])).toMatchObject({ failed: true, done: false });
  });
});

it("names where the file went", () => {
  expect(destinationText(card({ state: "uploading" }))).toBe("Work › Captures");
});
