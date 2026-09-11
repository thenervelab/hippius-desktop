import { describe, it, expect } from "vitest";
import { canRenameFile, remoteDriveLabel } from "../renameGating";
import { REMOTE_SOURCE_PREFIX } from "@/app/lib/hooks/use-nested-folder-listing";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const row = (over: Partial<FormattedUserFile> = {}): FormattedUserFile =>
  ({ name: "a.jpg", isAssigned: true, ...over }) as FormattedUserFile;

describe("canRenameFile — cloud-only rows", () => {
  // A browsed remote drive renames on the SERVER, so having nothing on
  // disk is no longer a reason to refuse. The drive to rename in comes
  // from the row's own source.
  it("allows a row inside a browsed remote drive", () => {
    expect(
      canRenameFile(row({ source: `${REMOTE_SOURCE_PREFIX}Camera Uploads` })),
    ).toBe(true);
  });

  // The bug this fixes: a remote FILE row deliberately carries NO source
  // (that absence is what marks it cloud-only for download and preview
  // routing), so a gate reading the `remote://` sentinel enabled rename on
  // a remote folder while every file inside it stayed disabled.
  it("allows a FILE inside a browsed remote drive, which carries no source", () => {
    expect(
      canRenameFile(
        row({ fileId: "abc", source: undefined, remoteDriveLabel: "Camera Uploads" }),
      ),
    ).toBe(true);
  });

  // A search hit from some other drive has no folder context — renaming
  // the wrong drive's file is worse than not offering it.
  it("still refuses a cloud-only search hit", () => {
    expect(canRenameFile(row({ fileId: "abc", source: undefined }))).toBe(false);
  });

  it("still refuses a pending download", () => {
    expect(
      canRenameFile(row({ fileId: "abc", syncStatus: "pending" })),
    ).toBe(false);
  });

  // An empty label after the prefix names no drive.
  it("refuses a remote source with no drive name", () => {
    expect(canRenameFile(row({ source: REMOTE_SOURCE_PREFIX }))).toBe(false);
  });

  it("still refuses a row that has not finished uploading", () => {
    expect(
      canRenameFile(row({ isAssigned: false, source: `${REMOTE_SOURCE_PREFIX}Drive` })),
    ).toBe(false);
  });

  it("leaves an ordinary local row renameable", () => {
    expect(canRenameFile(row({ source: "/Users/a/Drive/a.jpg" }))).toBe(true);
  });
});

describe("remoteDriveLabel", () => {
  // The gate and the rename itself must resolve the drive identically, or
  // a row offers Rename and then fails on the way to the server.
  it("names the drive for both row shapes", () => {
    expect(remoteDriveLabel(row({ remoteDriveLabel: "Camera Uploads" }))).toBe(
      "Camera Uploads",
    );
    expect(
      remoteDriveLabel(row({ source: `${REMOTE_SOURCE_PREFIX}Camera Uploads` })),
    ).toBe("Camera Uploads");
  });

  it("names no drive for a local row or a bare search hit", () => {
    expect(remoteDriveLabel(row({ source: "/Users/a/Drive/a.jpg" }))).toBeNull();
    expect(remoteDriveLabel(row({ fileId: "abc" }))).toBeNull();
  });
});
