import { describe, expect, it } from "vitest";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  canShareFolderGrant,
  folderGrantPathPrefix,
  folderShareInviteOffered,
} from "@/app/lib/utils/folderGrantGating";
import {
  offersShareAction,
  offersWriteAction,
} from "@/app/lib/utils/folderShareGating";
import { writableMemberDriveLabels } from "@/app/lib/shared-drives/driveRowSharing";
import { makeFolderGrantLabel } from "@/app/lib/shared-drives/sharedDriveLabel";

const folder = (label: string): FormattedUserFile =>
  ({ name: "Clients", isFolder: true, label }) as FormattedUserFile;

describe("folderShareInviteOffered", () => {
  it("is always on behind the folder-roles flag, whatever the server says", () => {
    expect(folderShareInviteOffered(true, { folder_grants: false })).toBe(true);
    expect(folderShareInviteOffered(true, null)).toBe(true);
  });

  it("waits for the capability without the flag", () => {
    expect(folderShareInviteOffered(false, { folder_grants: true })).toBe(true);
    expect(folderShareInviteOffered(false, { folder_grants: false })).toBe(false);
    expect(folderShareInviteOffered(false, null), "unknown reads as off").toBe(false);
  });
});

describe("canShareFolderGrant", () => {
  it("offers it on own drives once folder invites are offered", () => {
    expect(canShareFolderGrant(folder("mine"), true)).toBe(true);
    expect(canShareFolderGrant(folder("mine"), false)).toBe(false);
    expect(canShareFolderGrant(folder("team"), true, new Set(["team"]))).toBe(false);
  });

  it("lets a drive Manager share a folder in somebody else's drive", () => {
    const manageable = new Set(["team"]);
    expect(canShareFolderGrant(folder("team"), true, new Set(["team"]), manageable)).toBe(true);
    expect(canShareFolderGrant(folder("viewer"), true, new Set(["viewer"]), manageable)).toBe(false);
  });

  it("never from inside a granted folder: only owners and drive Managers mint folder invites", () => {
    const grant = makeFolderGrantLabel({ ownerSs58: "5O", folderHash: "h", pathPrefix: "Clients" });
    // A grant label is somebody else's drive on its own, and never manageable.
    expect(canShareFolderGrant(folder(grant), true)).toBe(false);
  });

  it("never for a file", () => {
    expect(canShareFolderGrant({ ...folder("mine"), isFolder: false }, true)).toBe(false);
  });
});

describe("folderGrantPathPrefix", () => {
  it("resolves a nested row against the view it is listed in, not the drive root", () => {
    const nested = { name: "Photos", actualFileName: "Photos", isFolder: true, label: "mine" } as FormattedUserFile;
    expect(folderGrantPathPrefix(nested, "Trips/2026")).toBe("Trips/2026/Photos");
    expect(folderGrantPathPrefix(nested, null)).toBe("Photos");
  });
});

/**
 * An Editor holder of a granted folder gets exactly what HCFS #475 lets a
 * writer holder do from the desktop: upload and new folder (the view's write
 * gate), rename, and a public folder link. Not "Share folder" (folder
 * invites are for owners and drive Managers). A Viewer gets none of it.
 */
describe("what a granted folder's role offers", () => {
  const grant = (role: string) => ({ ownerSs58: "5O", folderHash: "h", pathPrefix: `F-${role}`, role });
  const editor = makeFolderGrantLabel(grant("writer"));
  const viewer = makeFolderGrantLabel(grant("reader"));
  const writable = writableMemberDriveLabels([], [grant("writer"), grant("reader")]);

  it("lets an Editor rename and share by link, never mint a folder invite", () => {
    expect(offersWriteAction(folder(editor), undefined, writable)).toBe(true);
    expect(
      offersShareAction(folder(editor), undefined, {
        memberFolderShares: true,
        writableMemberDriveLabels: writable,
      }),
    ).toBe(true);
    expect(canShareFolderGrant(folder(editor), true)).toBe(false);
  });

  it("gives a Viewer none of the writes", () => {
    expect(offersWriteAction(folder(viewer), undefined, writable)).toBe(false);
    expect(
      offersShareAction(folder(viewer), undefined, {
        memberFolderShares: true,
        writableMemberDriveLabels: writable,
      }),
    ).toBe(false);
  });
});
