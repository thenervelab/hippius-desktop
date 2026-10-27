import { describe, expect, it } from "vitest";

import type { FolderRow } from "@/components/page-sections/drive/folder-list/folderRows";
import { parseFolderGrantLabel, parseSharedDriveLabel } from "@/app/lib/shared-drives/sharedDriveLabel";
import {
  UNKNOWN_FIGURE,
  effectiveSharedDrivesFilter,
  folderGrantRoute,
  formatSharedDriveListTotals,
  joinedDriveRoute,
  ownDriveRoute,
  ownDriveRows,
  ownDriveStatRow,
  sharedByMeLoading,
  sharedByMeRows,
  sharedDriveListTotals,
  sharedDrivesPageSlices,
  showSharedDrivesTabs,
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

describe("the tabs' filter", () => {
  it("shows the tabs only when both kinds exist", () => {
    expect(showSharedDrivesTabs({ withYou: 2, byYou: 1 })).toBe(true);
    expect(showSharedDrivesTabs({ withYou: 0, byYou: 1 })).toBe(false);
    expect(showSharedDrivesTabs({ withYou: 2, byYou: 0 })).toBe(false);
  });

  it("falls back to all when the chosen kind has emptied, leaving no tab to leave it by", () => {
    expect(effectiveSharedDrivesFilter("by-you", { withYou: 2, byYou: 1 })).toBe("by-you");
    expect(effectiveSharedDrivesFilter("by-you", { withYou: 2, byYou: 0 })).toBe("all");
    expect(effectiveSharedDrivesFilter("with-you", { withYou: 0, byYou: 3 })).toBe("all");
    expect(effectiveSharedDrivesFilter("all", { withYou: 2, byYou: 1 })).toBe("all");
  });
});

describe("the totals", () => {
  const known = (totalBytes: number, fileCount: number) => ({ hasStats: true, totalBytes, fileCount });
  const unknown = { hasStats: false, totalBytes: 0, fileCount: 0 };
  const fmt = (n: number) => `${n} B`;

  it("sums the drives whose size is known and leaves the rest out", () => {
    expect(sharedDriveListTotals([known(10, 1), unknown, known(5, 2)])).toEqual({
      isEmpty: false,
      isUnknown: false,
      totalBytes: 15,
      fileCount: 3,
    });
  });

  it("says empty for no drives and unknown when none could be sized", () => {
    expect(sharedDriveListTotals([])).toMatchObject({ isEmpty: true, isUnknown: false });
    expect(sharedDriveListTotals([unknown, unknown])).toMatchObject({ isEmpty: false, isUnknown: true });
  });

  it("words empty as zero, unknown as a dash, and a sum through the formatter", () => {
    expect(formatSharedDriveListTotals(sharedDriveListTotals([]), fmt)).toEqual({ size: "0 B", files: 0 });
    expect(formatSharedDriveListTotals(sharedDriveListTotals([unknown]), fmt)).toEqual({
      size: UNKNOWN_FIGURE,
      files: UNKNOWN_FIGURE,
    });
    expect(formatSharedDriveListTotals(sharedDriveListTotals([known(7, 3)]), fmt)).toEqual({
      size: "7 B",
      files: 3,
    });
  });

  it("reads an own drive with no size as unknown, and a missing count as none", () => {
    expect(ownDriveStatRow({ totalBytes: undefined, fileCount: 4 }).hasStats).toBe(false);
    expect(ownDriveStatRow({ totalBytes: 0, fileCount: undefined })).toEqual(known(0, 0));
  });
});

describe("sharedDrivesPageSlices", () => {
  it("takes your drives first and the ones shared with you after", () => {
    expect(sharedDrivesPageSlices({ byYou: 10, withYou: 3, start: 0, end: 8 })).toEqual({
      byYou: { start: 0, end: 8 },
      withYou: { start: 0, end: 0 },
    });
    expect(sharedDrivesPageSlices({ byYou: 10, withYou: 3, start: 8, end: 13 })).toEqual({
      byYou: { start: 8, end: 10 },
      withYou: { start: 0, end: 3 },
    });
  });

  it("pages one kind alone when the other is filtered out", () => {
    expect(sharedDrivesPageSlices({ byYou: 0, withYou: 12, start: 8, end: 12 })).toEqual({
      byYou: { start: 0, end: 0 },
      withYou: { start: 8, end: 12 },
    });
  });
});
