import { describe, expect, it } from "vitest";
import { parentOf, rowPercent, uploadsInFolder } from "../uploadingHere";
import type { RemoteUploadProgress } from "@/app/lib/remote-upload/remoteUploadFeed";
import type { FileProgress } from "@/app/lib/types/syncSnapshot";

const row = (path: string, over: Partial<RemoteUploadProgress> = {}): RemoteUploadProgress => ({
  batchId: 1,
  path,
  fileName: path.split("/").pop() ?? path,
  label: "Work",
  bytesTransferred: 30,
  totalBytes: 100,
  status: "inProgress",
  ...over,
});

describe("uploadsInFolder", () => {
  const rows = {
    a: row("Captures/Recording.mp4"),
    b: row("Captures/Screenshot.png", { status: "completed" }),
    c: row("Captures/Deeper/x.png"),
    d: row("Photos/y.png"),
    e: row("Captures/z.png", { label: "Other" }),
    f: row("root.png"),
  };

  it("lists unfinished uploads into exactly this folder of this drive", () => {
    expect(uploadsInFolder(rows, "Work", "Captures").map((r) => r.path)).toEqual(["Captures/Recording.mp4"]);
    expect(uploadsInFolder(rows, "Work", "/Captures/").map((r) => r.path)).toEqual(["Captures/Recording.mp4"]);
    expect(uploadsInFolder(rows, "Work", "").map((r) => r.path)).toEqual(["root.png"]);
  });

  it("lists nothing without a drive", () => {
    expect(uploadsInFolder(rows, null, "Captures")).toEqual([]);
  });

  // A capture into a drive synced here is saved into the folder and uploaded
  // by the sync engine, never through remote_upload_progress.
  it("shows the sync engine's uploads into this folder too, once per path", () => {
    const engine = (path: string, over: Partial<FileProgress> = {}) =>
      ({
        path,
        fileName: path.split("/").pop() ?? path,
        label: "Work",
        action: "upload",
        status: "inProgress",
        progressPercent: 10,
        bytesEncrypted: 0,
        bytesTransferred: 10,
        totalBytes: 100,
        ...over,
      }) as FileProgress;
    const files = [
      engine("Captures/Screenshot 1.png"),
      engine("Captures/Recording.mp4"),
      engine("Captures/done.png", { status: "completed" }),
      engine("Captures/down.png", { action: "download" }),
      engine("Photos/elsewhere.png"),
    ];
    expect(uploadsInFolder(rows, "Work", "Captures", files).map((r) => r.path)).toEqual([
      "Captures/Recording.mp4",
      "Captures/Screenshot 1.png",
    ]);
  });

  it("keeps a failed upload in view so it is not silently lost", () => {
    expect(uploadsInFolder({ a: row("Captures/a.mp4", { status: "error" }) }, "Work", "Captures")).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("finds a path's folder", () => {
    expect(parentOf("Captures/a.mp4")).toBe("Captures");
    expect(parentOf("/a/b/c.png")).toBe("a/b");
    expect(parentOf("a.png")).toBe("");
  });

  it("has no percentage until bytes move", () => {
    expect(rowPercent(row("a", { status: "encrypting" }))).toBeNull();
    expect(rowPercent(row("a"))).toBe(30);
  });
});
