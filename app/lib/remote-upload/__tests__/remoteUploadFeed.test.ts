import { describe, it, expect } from "vitest";
import {
  applyRemoteUpload,
  mergeRemoteUploads,
  pruneRemoteUploads,
  REMOTE_UPLOAD_LINGER_MS,
  type RemoteUploadProgress,
} from "../remoteUploadFeed";
import type { SyncSnapshot } from "@/app/lib/types/syncSnapshot";

const EMPTY: SyncSnapshot = {
  isActive: false,
  overallPercent: 0,
  progressBytes: 0,
  bytesExpected: 0,
  totalFiles: 0,
  completedFiles: 0,
  failedFiles: 0,
  retryInSecs: 0,
  lastError: null,
  expectedUploads: 0,
  expectedDownloads: 0,
  expectedLocalDeletes: 0,
  expectedRemoteDeletes: 0,
  startedAt: null,
  completedAt: null,
  files: [],
  widgetState: "idle",
  widgetVisible: false,
  combinedProgressBytes: 0,
  combinedBytesExpected: 0,
  deletedCount: 0,
  syncedCount: 0,
  actualTotal: 0,
  statusVariant: "progress",
  syncDirection: "upload",
  effectiveInProgress: false,
  effectiveCompleted: false,
};

const row = (over: Partial<RemoteUploadProgress> = {}): RemoteUploadProgress => ({
  path: "Photos/a.jpg",
  fileName: "a.jpg",
  label: "Camera Uploads",
  bytesTransferred: 50,
  totalBytes: 100,
  status: "inProgress",
  ...over,
});

describe("mergeRemoteUploads", () => {
  it("leaves the snapshot untouched when nothing is uploading", () => {
    expect(mergeRemoteUploads(EMPTY, {})).toBe(EMPTY);
  });

  // Without this the row exists inside a widget that never opens, which
  // is indistinguishable from the upload not being tracked at all.
  it("opens the widget for an upload the engine never sees", () => {
    const merged = mergeRemoteUploads(EMPTY, { "Photos/a.jpg": row() });
    expect(merged.widgetVisible).toBe(true);
    expect(merged.isActive).toBe(true);
    expect(merged.files).toHaveLength(1);
    expect(merged.files[0].fileName).toBe("a.jpg");
    expect(merged.files[0].action).toBe("upload");
  });

  it("adds to the engine's rows rather than replacing them", () => {
    const withEngineRow: SyncSnapshot = {
      ...EMPTY,
      files: [{ ...EMPTY.files[0], path: "x", fileName: "x", label: "l", action: "upload", status: "inProgress", progressPercent: 0, bytesEncrypted: 0, bytesTransferred: 0, totalBytes: 10 }],
      totalFiles: 1,
    };
    const merged = mergeRemoteUploads(withEngineRow, { "Photos/a.jpg": row() });
    expect(merged.files).toHaveLength(2);
    expect(merged.totalFiles).toBe(2);
  });

  // hcfs reports CIPHERTEXT bytes, which exceed the plaintext total. A bar
  // past 100% reads as a bug.
  it("never reports more than complete", () => {
    const merged = mergeRemoteUploads(EMPTY, {
      "Photos/a.jpg": row({ bytesTransferred: 5_000, totalBytes: 100 }),
    });
    expect(merged.files[0].progressPercent).toBeLessThanOrEqual(100);
    expect(merged.overallPercent).toBeLessThanOrEqual(100);
  });

  it("counts a finished upload as completed, not still running", () => {
    const merged = mergeRemoteUploads(EMPTY, {
      "Photos/a.jpg": row({ status: "completed", bytesTransferred: 100 }),
    });
    expect(merged.completedFiles).toBe(1);
    expect(merged.isActive).toBe(false);
  });

  it("counts a failure as failed and carries its reason", () => {
    const merged = mergeRemoteUploads(EMPTY, {
      "Photos/a.jpg": row({ status: "error", error: "Upload failed: 402" }),
    });
    expect(merged.failedFiles).toBe(1);
    expect(merged.files[0].error).toBe("Upload failed: 402");
  });

  it("does not divide by zero on an empty file", () => {
    const merged = mergeRemoteUploads(EMPTY, {
      "Photos/a.jpg": row({ bytesTransferred: 0, totalBytes: 0 }),
    });
    expect(merged.files[0].progressPercent).toBe(0);
  });
});

describe("applyRemoteUpload / pruneRemoteUploads", () => {
  it("keys rows by path so same-named files in different folders stay apart", () => {
    let map = applyRemoteUpload({}, row({ path: "A/a.jpg" }));
    map = applyRemoteUpload(map, row({ path: "B/a.jpg" }));
    expect(Object.keys(map)).toHaveLength(2);
  });

  it("replaces a row as it progresses rather than appending", () => {
    let map = applyRemoteUpload({}, row({ bytesTransferred: 10 }));
    map = applyRemoteUpload(map, row({ bytesTransferred: 90 }));
    expect(Object.keys(map)).toHaveLength(1);
    expect(map["Photos/a.jpg"].bytesTransferred).toBe(90);
  });

  // Deleting on completion makes a fast upload flash and vanish, which
  // reads as a glitch rather than as done.
  it("keeps a finished row until the linger window passes", () => {
    const t = 1_000;
    const map = applyRemoteUpload({}, row({ status: "completed" }), t);
    expect(Object.keys(pruneRemoteUploads(map, t + 1))).toHaveLength(1);
    expect(
      Object.keys(pruneRemoteUploads(map, t + REMOTE_UPLOAD_LINGER_MS + 1)),
    ).toHaveLength(0);
  });

  it("never prunes a row that is still uploading", () => {
    const map = applyRemoteUpload({}, row(), 0);
    expect(Object.keys(pruneRemoteUploads(map, 10_000_000))).toHaveLength(1);
  });
});
