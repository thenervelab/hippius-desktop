import { describe, expect, it } from "vitest";
import { destinationText, hidesItself, statusText, uploadPercent } from "@/app/capture-preview/previewCard";
import type { CapturePreviewCard } from "@/app/lib/tauri/capture";
import type { RemoteUploadProgress } from "@/app/lib/remote-upload/remoteUploadFeed";

const card = (status: CapturePreviewCard["status"]): CapturePreviewCard => ({
  id: 1,
  kind: "recording",
  fileName: "Recording 2026-09-29 at 15.42.10.mp4",
  driveLabel: "Work",
  driveName: "Work",
  remote: false,
  status,
});

const row = (over: Partial<RemoteUploadProgress> = {}): RemoteUploadProgress => ({
  batchId: 1,
  path: "Captures/Recording 2026-09-29 at 15.42.10.mp4",
  fileName: "Recording 2026-09-29 at 15.42.10.mp4",
  label: "Work",
  bytesTransferred: 62,
  totalBytes: 100,
  status: "inProgress",
  ...over,
});

describe("uploadPercent", () => {
  it("follows this capture's own upload row", () => {
    expect(uploadPercent(card({ state: "uploading" }), row())).toBe(62);
  });

  it("ignores another file's row, or the same name in another drive", () => {
    expect(uploadPercent(card({ state: "uploading" }), row({ fileName: "other.png" }))).toBeNull();
    expect(uploadPercent(card({ state: "uploading" }), row({ label: "Photos" }))).toBeNull();
  });

  it("holds at 99 until Rust says it is uploaded", () => {
    expect(uploadPercent(card({ state: "uploading" }), row({ bytesTransferred: 100 }))).toBe(99);
    expect(uploadPercent(card({ state: "uploaded", linkCopied: true }), null)).toBe(100);
  });

  it("has no number while encrypting", () => {
    expect(uploadPercent(card({ state: "uploading" }), row({ totalBytes: 0 }))).toBeNull();
  });
});

describe("the card's words", () => {
  it("names where the file went", () => {
    expect(destinationText(card({ state: "uploading" }))).toBe("Work › Captures");
  });

  it("describes each step", () => {
    expect(statusText(card({ state: "uploading" }), null)).toBe("Preparing upload…");
    expect(statusText(card({ state: "uploading" }), 40)).toBe("Uploading · 40%");
    expect(statusText(card({ state: "uploaded", linkCopied: true }), 100)).toBe("Uploaded · link copied");
    expect(statusText(card({ state: "uploaded", linkCopied: false }), 100)).toBe("Uploaded · no link");
    expect(statusText(card({ state: "failed", message: "offline" }), null)).toBe("Couldn't upload");
  });

  it("hides itself only once the file is uploaded", () => {
    expect(hidesItself(card({ state: "uploaded", linkCopied: true }))).toBe(true);
    expect(hidesItself(card({ state: "uploading" }))).toBe(false);
    expect(hidesItself(card({ state: "failed", message: "x" }))).toBe(false);
  });
});
