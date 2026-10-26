import { describe, expect, it } from "vitest";

import type { FolderRow } from "@/components/page-sections/drive/folder-list/folderRows";
import { parseFolderGrantLabel, parseSharedDriveLabel } from "@/app/lib/shared-drives/sharedDriveLabel";
import {
  folderGrantRoute,
  joinedDriveRoute,
  ownDriveRoute,
  ownDriveRows,
  sharedByMeLoading,
  sharedByMeRows,
} from "../sharedDrivesState";

const OWNER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const HASH = "a".repeat(16);

function row(name: string, extra: Partial<FolderRow> = {}): FolderRow {
  return { id: name, folderName: name, presence: "on-this-device", lastModified: 0, ...extra };
}

const sharing = (memberCount: number, totalInviteCount = 0) => ({
  memberCount,
  liveInviteCount: totalInviteCount,
  totalInviteCount,
});

describe("sharedByMeRows", () => {
  it("keeps only own drives shared as a whole", () => {
    const rows = [
      row("Team"),
      row("Links only"),
      row("Private"),
      row("Theirs", { ownerSs58: OWNER }),
    ];
    const byLabel = new Map([
      ["Team", sharing(3)],
      ["Links only", sharing(0, 1)],
      ["Private", sharing(0)],
      ["Theirs", sharing(5)],
    ]);
    expect(sharedByMeRows(rows, byLabel).map((r) => r.folderName)).toEqual(["Team", "Links only"]);
  });

  it("leaves out a drive whose sharing is not known, rather than guessing", () => {
    expect(sharedByMeRows([row("Unknown")], new Map())).toEqual([]);
  });

  it("counts a drive with only lapsed links as shared", () => {
    const lapsed = { memberCount: 0, liveInviteCount: 0, totalInviteCount: 2 };
    expect(sharedByMeRows([row("Old")], new Map([["Old", lapsed]]))).toHaveLength(1);
  });
});

describe("ownDriveRows", () => {
  it("drops drives another account owns", () => {
    expect(ownDriveRows([row("Mine"), row("Theirs", { ownerSs58: OWNER })]).map((r) => r.folderName)).toEqual([
      "Mine",
    ]);
  });
});

describe("sharedByMeLoading", () => {
  it("waits for the drives and for their sharing", () => {
    expect(sharedByMeLoading({ foldersLoading: true, sharingPending: false })).toBe(true);
    expect(sharedByMeLoading({ foldersLoading: false, sharingPending: true })).toBe(true);
    expect(sharedByMeLoading({ foldersLoading: false, sharingPending: false })).toBe(false);
  });
});

describe("routes out of the page", () => {
  it("opens a drive synced here by its label, and a cloud-only one as remote", () => {
    const local = row("Team", { local: { id: "team-1" } as FolderRow["local"] });
    expect(ownDriveRoute(local)).toBe("/files?openLabel=team-1");
    const remote = row("Archive", { presence: "other-device" });
    expect(ownDriveRoute(remote)).toBe("/files?openLabel=Archive&openRemote=1");
  });

  it("opens a joined drive by its browse label, with its name for the breadcrumb", () => {
    const url = new URL(
      `app://x${joinedDriveRoute({ ownerSs58: OWNER, folderHash: HASH, displayLabel: "Design team" })}`,
    );
    expect(url.pathname).toBe("/files");
    expect(url.searchParams.get("openRemote")).toBe("1");
    expect(url.searchParams.get("openName")).toBe("Design team");
    expect(parseSharedDriveLabel(url.searchParams.get("openLabel"))).toEqual({
      ownerSs58: OWNER,
      folderHash: HASH,
    });
  });

  it("opens a shared folder rooted at that folder", () => {
    const url = new URL(
      `app://x${folderGrantRoute({ ownerSs58: OWNER, folderHash: HASH, pathPrefix: "Clients/ACME", folderName: "ACME" })}`,
    );
    expect(url.searchParams.get("openName")).toBe("ACME");
    expect(parseFolderGrantLabel(url.searchParams.get("openLabel"))?.pathPrefix).toBe("Clients/ACME");
  });
});
