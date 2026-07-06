import { describe, expect, it } from "vitest";
import { mergeUploadFeed } from "../mergeUploadFeed";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { FileProgress } from "@/app/lib/types/syncSnapshot";

function completed(
  name: string,
  opts: Partial<FormattedUserFile> = {},
): FormattedUserFile {
  return {
    name,
    actualFileName: name,
    size: 100,
    createdAt: 1_000,
    arionHash: name,
    arionCid: "",
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    label: "Docs",
    syncStatus: "synced",
    ...opts,
  };
}

function progress(
  path: string,
  status: FileProgress["status"],
  opts: Partial<FileProgress> = {},
): FileProgress {
  return {
    path,
    fileName: path,
    label: "Docs",
    action: "upload",
    status,
    progressPercent: 0,
    bytesEncrypted: 0,
    bytesTransferred: 0,
    totalBytes: 200,
    ...opts,
  };
}

describe("mergeUploadFeed", () => {
  it("returns the server completed list when nothing is in flight", () => {
    const out = mergeUploadFeed({
      recentUploads: [completed("a.png"), completed("b.png")],
      snapshotFiles: [],
      limit: 50,
    });
    expect(out.map((f) => f.name)).toEqual(["a.png", "b.png"]);
    expect(out.every((f) => f.feedStatus === "completed")).toBe(true);
  });

  it("orders uploading first, then failed, then completed", () => {
    const out = mergeUploadFeed({
      recentUploads: [completed("done.png")],
      snapshotFiles: [
        progress("fail.png", "error", { error: "402" }),
        progress("up.png", "inProgress", { progressPercent: 40 }),
      ],
      limit: 50,
    });
    expect(out.map((f) => f.feedStatus)).toEqual([
      "uploading",
      "failed",
      "completed",
    ]);
    expect(out.map((f) => f.name)).toEqual(["up.png", "fail.png", "done.png"]);
  });

  it("maps live statuses and carries progress + error through", () => {
    const out = mergeUploadFeed({
      recentUploads: [],
      snapshotFiles: [
        progress("up.png", "inProgress", { progressPercent: 73 }),
        progress("enc.png", "encrypting", { progressPercent: 12 }),
        progress("wait.png", "pending"),
        progress("bad.png", "error", { error: "Insufficient credits" }),
      ],
      limit: 50,
    });
    const by = (n: string) => out.find((f) => f.name === n)!;
    expect(by("up.png").feedStatus).toBe("uploading");
    expect(by("up.png").progressPercent).toBe(73);
    expect(by("enc.png").feedStatus).toBe("uploading"); // encrypting reads as uploading
    expect(by("wait.png").feedStatus).toBe("pending");
    expect(by("bad.png").feedStatus).toBe("failed");
    expect(by("bad.png").errorMessage).toBe("Insufficient credits");
  });

  it("dedups a file present both in flight and on the server (live wins)", () => {
    const out = mergeUploadFeed({
      recentUploads: [completed("report.pdf", { actualFileName: "report.pdf" })],
      snapshotFiles: [progress("report.pdf", "inProgress", { progressPercent: 50 })],
      limit: 50,
    });
    expect(out).toHaveLength(1);
    expect(out[0].feedStatus).toBe("uploading");
    expect(out[0].progressPercent).toBe(50);
  });

  it("drops a completed live row the server already has, keeping the server's real time", () => {
    // A just-finished file lingers in the snapshot as `completed` while also
    // appearing in the server list. The live row would re-stamp createdAt to
    // now() on every merge (→ perpetual "Just now"); the server row's real
    // createdAt must win.
    const out = mergeUploadFeed({
      recentUploads: [completed("ahmadrao.jpg", { createdAt: 1_234 })],
      snapshotFiles: [progress("ahmadrao.jpg", "completed")],
      limit: 50,
    });
    expect(out).toHaveLength(1);
    expect(out[0].feedStatus).toBe("completed");
    expect(out[0].createdAt).toBe(1_234);
  });

  it("keeps a completed live row when the server list does not yet have it", () => {
    // Before the server list refreshes, the just-finished file is only in the
    // snapshot — keep it so it stays visible (its createdAt≈now reads "Just now").
    const out = mergeUploadFeed({
      recentUploads: [],
      snapshotFiles: [progress("fresh.jpg", "completed")],
      limit: 50,
    });
    expect(out).toHaveLength(1);
    expect(out[0].feedStatus).toBe("completed");
  });

  it("treats the same name in different drives as distinct rows", () => {
    const out = mergeUploadFeed({
      recentUploads: [completed("x.png", { label: "Docs" })],
      snapshotFiles: [progress("x.png", "inProgress", { label: "Photos" })],
      limit: 50,
    });
    expect(out).toHaveLength(2);
  });

  it("ignores non-upload snapshot entries (downloads/deletes)", () => {
    const out = mergeUploadFeed({
      recentUploads: [],
      snapshotFiles: [
        progress("down.png", "inProgress", { action: "download" }),
        progress("del.png", "completed", { action: "remote_delete" }),
      ],
      limit: 50,
    });
    expect(out).toHaveLength(0);
  });

  it("derives the display name from the basename of a nested path", () => {
    const out = mergeUploadFeed({
      recentUploads: [],
      snapshotFiles: [progress("Work/2024/report.pdf", "inProgress")],
      limit: 50,
    });
    expect(out[0].name).toBe("report.pdf");
    expect(out[0].actualFileName).toBe("Work/2024/report.pdf");
  });

  it("caps the result at the limit, keeping the highest-priority rows", () => {
    const out = mergeUploadFeed({
      recentUploads: [completed("c1.png"), completed("c2.png"), completed("c3.png")],
      snapshotFiles: [progress("live.png", "inProgress")],
      limit: 2,
    });
    expect(out.map((f) => f.name)).toEqual(["live.png", "c1.png"]);
  });

  it("dedups across a leading-slash path difference (snapshot vs server)", () => {
    // macOS/APFS hands the snapshot a leading slash; the server mapper trims
    // it. Without normalization these split into two rows and the completed
    // live row re-stamps "Just now" forever. They must collapse to one.
    const out = mergeUploadFeed({
      recentUploads: [completed("a.png", { actualFileName: "a.png", createdAt: 7 })],
      snapshotFiles: [progress("/a.png", "completed")],
      limit: 50,
    });
    expect(out).toHaveLength(1);
    expect(out[0].createdAt).toBe(7); // server row (real time) won
  });

  it("keeps a retained completed row until the server confirms it", () => {
    // After the live row has left snapshot.files but before the server refetch
    // lands, the retained row keeps the finished file visible (no flicker-out).
    const retained = mergeUploadFeed({
      recentUploads: [],
      snapshotFiles: [progress("done.png", "completed")],
      limit: 50,
    });
    const out = mergeUploadFeed({
      recentUploads: [],
      snapshotFiles: [], // gone from the live snapshot
      retainedCompleted: retained,
      limit: 50,
    });
    expect(out.map((f) => f.name)).toEqual(["done.png"]);
    expect(out[0].feedStatus).toBe("completed");
  });

  it("drops a retained row once the server list includes it", () => {
    const retained = mergeUploadFeed({
      recentUploads: [],
      snapshotFiles: [progress("done.png", "completed")],
      limit: 50,
    });
    const out = mergeUploadFeed({
      recentUploads: [completed("done.png", { createdAt: 99 })],
      snapshotFiles: [],
      retainedCompleted: retained,
      limit: 50,
    });
    expect(out).toHaveLength(1);
    expect(out[0].createdAt).toBe(99); // server row (real time), not the retained stamp
  });

  it("keeps retained completed rows below active/failed rows", () => {
    const retained = mergeUploadFeed({
      recentUploads: [],
      snapshotFiles: [progress("old.png", "completed")],
      limit: 50,
    });
    const out = mergeUploadFeed({
      recentUploads: [],
      snapshotFiles: [
        progress("up.png", "inProgress", { progressPercent: 20 }),
        progress("bad.png", "error", { error: "x" }),
      ],
      retainedCompleted: retained,
      limit: 50,
    });
    expect(out.map((f) => f.feedStatus)).toEqual([
      "uploading",
      "failed",
      "completed",
    ]);
  });
});
