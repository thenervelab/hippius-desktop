import { describe, it, expect } from "vitest";
import {
  applyRemoteUpload,
  capWidgetFiles,
  COMPLETED_RETAINED,
  MAX_WIDGET_FILES,
  mergeRemoteUploads,
  type RemoteUploadProgress,
} from "../remoteUploadFeed";
import type { FileProgress, SyncSnapshot } from "@/app/lib/types/syncSnapshot";

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
  batchId: 1,
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

describe("applyRemoteUpload", () => {
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

  // The widget is the record that an upload happened, and a timer that
  // swept it took that record away seconds after the upload ended.
  it("keeps a finished batch until another upload starts", () => {
    let map = applyRemoteUpload({}, row({ path: "a.jpg", status: "completed" }));
    map = applyRemoteUpload(map, row({ path: "b.jpg", status: "error" }));
    expect(Object.keys(map)).toHaveLength(2);
  });

  // The regression a derived boundary reintroduces: a small file settles
  // before the next file's first event, which is indistinguishable from a
  // new upload unless the id says otherwise.
  it("keeps a settled row when the next file of the SAME batch starts", () => {
    let map = applyRemoteUpload({}, row({ path: "a.jpg", status: "completed" }));
    map = applyRemoteUpload(map, row({ path: "b.jpg", status: "pending" }));
    expect(Object.keys(map)).toHaveLength(2);
  });

  it("clears the previous batch when a new one starts", () => {
    let map = applyRemoteUpload({}, row({ path: "a.jpg", status: "completed" }));
    map = applyRemoteUpload(map, row({ path: "b.jpg", status: "error" }));
    map = applyRemoteUpload(map, row({ batchId: 2, path: "c.jpg", status: "pending" }));
    expect(Object.keys(map)).toEqual(["c.jpg"]);
  });

  // A new batch can start while the previous one is still uploading —
  // the user can pick again without waiting — and the old rows still go.
  it("clears an unfinished previous batch too", () => {
    let map = applyRemoteUpload({}, row({ path: "a.jpg", status: "inProgress" }));
    map = applyRemoteUpload(map, row({ batchId: 2, path: "b.jpg", status: "pending" }));
    expect(Object.keys(map)).toEqual(["b.jpg"]);
  });
});

describe("capWidgetFiles", () => {
  const file = (
    status: FileProgress["status"],
    name: string,
  ): FileProgress => ({
    path: name,
    fileName: name,
    label: "l",
    action: "upload",
    status,
    progressPercent: 0,
    bytesEncrypted: 0,
    bytesTransferred: 0,
    totalBytes: 1,
  });

  it("leaves a short list alone", () => {
    const files = [file("inProgress", "a"), file("completed", "b")];
    expect(capWidgetFiles(files)).toHaveLength(2);
  });

  // Same product cap as the engine's rows — the widget is about four rows
  // tall and both lists render in it.
  it("never exceeds the widget's row cap", () => {
    const files = Array.from({ length: 40 }, (_, i) => file("pending", `f${i}`));
    expect(capWidgetFiles(files)).toHaveLength(MAX_WIDGET_FILES);
  });

  // A blind truncate drops completed rows first — they sort last — so in
  // a batch bigger than the cap a finished upload never appears at all.
  it("keeps recent completions visible in a saturated list", () => {
    const files = [
      ...Array.from({ length: 20 }, (_, i) => file("inProgress", `a${i}`)),
      ...Array.from({ length: 20 }, (_, i) => file("completed", `c${i}`)),
    ];
    const capped = capWidgetFiles(files);
    expect(capped).toHaveLength(MAX_WIDGET_FILES);
    expect(capped.filter((f) => f.status === "completed")).toHaveLength(COMPLETED_RETAINED);
  });

  it("puts errors first, then in-flight, then pending, then completed", () => {
    const capped = capWidgetFiles([
      file("completed", "done"),
      file("pending", "waiting"),
      file("inProgress", "moving"),
      file("error", "broken"),
    ]);
    expect(capped.map((f) => f.fileName)).toEqual(["broken", "moving", "waiting", "done"]);
  });
});
