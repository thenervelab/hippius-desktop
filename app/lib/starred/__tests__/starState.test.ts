import { describe, expect, it } from "vitest";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { starKey, type StarScope } from "@/app/lib/tauri/starred";
import {
  canStar,
  driveStarTarget,
  resolveStarred,
  starBatchFailure,
  starBatchToast,
  starTargetFor,
  starToast,
  STARS_FULL_MESSAGE,
  targetStarKey,
} from "../starState";

const OWNER = "5Own";
const HASH = "0123456789abcdef";
const FILE_ID = "ab".repeat(32);
const drive: StarScope = { ownerSs58: OWNER, folderHash: HASH, rootPath: "" };
const grant: StarScope = { ownerSs58: OWNER, folderHash: HASH, rootPath: "Shared/Team" };

function row(overrides: Partial<FormattedUserFile> = {}): FormattedUserFile {
  return {
    name: "report.pdf",
    actualFileName: "Work/report.pdf",
    createdAt: 0,
    arionHash: FILE_ID,
    arionCid: "",
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    label: "Docs",
    syncStatus: "synced",
    ...overrides,
  };
}

// The key is a contract with Rust (`StarResult.key`, `StarredItem.key`), so
// its exact spelling is pinned here as Rust pins it.
describe("starKey", () => {
  it("names a file by its id, a folder by its path, a drive as the drive", () => {
    expect(starKey(drive, "file", FILE_ID)).toBe(`5Own|0123456789abcdef|f:${"ab".repeat(32)}`);
    expect(starKey(drive, "folder", "A/B")).toBe("5Own|0123456789abcdef|d:A/B");
    expect(starKey(drive, "drive")).toBe("5Own|0123456789abcdef|drive");
  });

  it("puts a granted folder in front of every path, and names the grant's root as its drive", () => {
    expect(starKey(grant, "drive")).toBe("5Own|0123456789abcdef|d:Shared/Team");
    expect(starKey(grant, "folder", "X")).toBe("5Own|0123456789abcdef|d:Shared/Team/X");
    // A file is named by its id wherever the grant is rooted.
    expect(starKey(grant, "file", FILE_ID)).toBe(`5Own|0123456789abcdef|f:${FILE_ID}`);
  });

  it("trims the slashes a path may carry and lowercases a file id", () => {
    expect(starKey(drive, "folder", "/A/B/")).toBe("5Own|0123456789abcdef|d:A/B");
    expect(starKey(drive, "file", FILE_ID.toUpperCase())).toBe(`5Own|0123456789abcdef|f:${FILE_ID}`);
  });
});

describe("resolveStarred", () => {
  it("prefers this session's toggle, then the row's favorite, then the Starred list", () => {
    expect(resolveStarred(false, true, true)).toBe(false);
    expect(resolveStarred(true, false, false)).toBe(true);
    expect(resolveStarred(undefined, false, true)).toBe(false);
    expect(resolveStarred(undefined, true, false)).toBe(true);
    // Absent (or null) means the listing did not say: the list decides.
    expect(resolveStarred(undefined, undefined, true)).toBe(true);
    expect(resolveStarred(undefined, null, false)).toBe(false);
  });
});

describe("starTargetFor / canStar", () => {
  it("names a synced file by its 64-hex id and its drive label", () => {
    expect(starTargetFor(row())).toEqual({ kind: "file", name: "report.pdf", label: "Docs", fileId: FILE_ID });
  });

  it("prefers the server id, and the browsed drive's label", () => {
    const id = "cd".repeat(32);
    expect(starTargetFor(row({ fileId: id, arionHash: "", label: "x", remoteDriveLabel: "shared:5O~0123456789abcdef" }))).toEqual({
      kind: "file",
      name: "report.pdf",
      label: "shared:5O~0123456789abcdef",
      fileId: id,
    });
  });

  it("names a folder by its path from the view's root", () => {
    const folder = row({ name: "Trips", actualFileName: "Trips", isFolder: true, arionHash: "" });
    expect(starTargetFor(folder, "Photos/2026")).toEqual({
      kind: "folder",
      name: "Trips",
      label: "Docs",
      path: "Photos/2026/Trips",
    });
    expect(starTargetFor({ ...folder, parentRelativePath: "Deep" }, "ignored")?.path).toBe("Deep/Trips");
  });

  it("offers nothing for what is not on the server", () => {
    // Still uploading, only on this computer, or no id yet.
    expect(canStar(row({ syncStatus: "uploading" }))).toBe(false);
    expect(canStar(row({ syncStatus: "excluded" }))).toBe(false);
    expect(canStar(row({ syncStatus: "hidden" }))).toBe(false);
    expect(canStar(row({ isAssigned: false }))).toBe(false);
    expect(canStar(row({ arionHash: "" }))).toBe(false);
    expect(canStar(row({ arionHash: "Qm-not-a-path-hash" }))).toBe(false);
    expect(canStar(row({ tempData: { uploadTime: 1 } }))).toBe(false);
    // No drive to put the star in.
    expect(canStar(row({ label: undefined }))).toBe(false);
    // A download still pending is on the server already.
    expect(canStar(row({ syncStatus: "pending", fileId: FILE_ID }))).toBe(true);
  });

  it("keys a target by its drive's scope, and not before the scope is known", () => {
    const target = starTargetFor(row())!;
    expect(targetStarKey(target, null)).toBeNull();
    expect(targetStarKey(target, drive)).toBe(`5Own|0123456789abcdef|f:${FILE_ID}`);
    expect(targetStarKey(driveStarTarget("grant:x", "Team"), grant)).toBe("5Own|0123456789abcdef|d:Shared/Team");
  });
});

describe("toasts", () => {
  it("says what happened, with curly quotes around the name", () => {
    expect(starToast("plan.pdf", true)).toBe('"plan.pdf" added to Starred');
    expect(starToast("plan.pdf", false)).toBe('"plan.pdf" removed from Starred');
    expect(starBatchToast(3, true)).toBe("3 items added to Starred");
    expect(starBatchToast(3, false)).toBe("3 items removed from Starred");
    expect(starBatchToast(1, true)).toBe("1 item added to Starred");
  });

  it("puts a failed batch in one sentence, the 1,000 cap first", () => {
    expect(starBatchFailure(2, 1, true, true)).toBe(STARS_FULL_MESSAGE);
    expect(starBatchFailure(2, 0, true, false)).toBe("Couldn't star 2 items. Try again.");
    expect(starBatchFailure(1, 3, false, false)).toBe("Couldn't unstar 1 item. Try again. 3 items removed from Starred.");
  });
});
