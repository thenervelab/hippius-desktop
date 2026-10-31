import { describe, expect, it } from "vitest";

import type { FolderRow } from "@/components/page-sections/drive/folder-list/folderRows";
import { parseFolderGrantLabel, parseSharedDriveLabel } from "@/app/lib/shared-drives/sharedDriveLabel";
import { resolveFolderListPage } from "@/components/page-sections/drive/folder-list/folderListPaging";
import {
  SHARED_DRIVES_PAGE_SIZE,
  UNKNOWN_FIGURE,
  effectiveSharedDrivesFilter,
  folderGrantRoute,
  formatSharedDriveListTotals,
  joinedDriveRoute,
  ownDriveRoute,
  ownDriveRows,
  ownDriveStatRow,
  resolveSharedDrivesContent,
  sharedByMeRows,
  sharedByYouStatus,
  sharedDriveListTotals,
  sharedDrivesPageSlices,
  sharedDrivesTabCount,
  sharedWithYouStatus,
  showSharedDrivesTabs,
  type SharedKind,
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

describe("sharedByYouStatus", () => {
  const base = {
    foldersLoading: false,
    foldersFailed: false,
    ownDriveCount: 2,
    sharingPending: false,
    sharingFailed: false,
    sharingAnswered: 2,
  };

  it("waits for the drives and then for their sharing", () => {
    expect(sharedByYouStatus({ ...base, foldersLoading: true })).toBe("loading");
    expect(sharedByYouStatus({ ...base, sharingPending: true })).toBe("loading");
    expect(sharedByYouStatus(base)).toBe("ready");
  });

  it("is an error, never none, when the drive listing failed", () => {
    expect(sharedByYouStatus({ ...base, foldersFailed: true })).toBe("error");
  });

  it("is an error when the sharing query failed", () => {
    expect(sharedByYouStatus({ ...base, sharingFailed: true })).toBe("error");
  });

  it("is an error when not one own drive got an answer (the IPC drops a drive whose listings both failed)", () => {
    expect(sharedByYouStatus({ ...base, sharingAnswered: 0 })).toBe("error");
    // Some answered: the ones that did are shown.
    expect(sharedByYouStatus({ ...base, sharingAnswered: 1 })).toBe("ready");
  });

  it("is a real none with no own drives, asking nothing about sharing", () => {
    expect(sharedByYouStatus({ ...base, ownDriveCount: 0, sharingAnswered: 0 })).toBe("ready");
  });
});

describe("sharedWithYouStatus", () => {
  it("waits for the memberships and the folder grants", () => {
    expect(sharedWithYouStatus({ memberships: "idle", grantsSettled: true })).toBe("loading");
    expect(sharedWithYouStatus({ memberships: "loading", grantsSettled: true })).toBe("loading");
    expect(sharedWithYouStatus({ memberships: "ready", grantsSettled: false })).toBe("loading");
    expect(sharedWithYouStatus({ memberships: "ready", grantsSettled: true })).toBe("ready");
  });

  it("is an error for a failed fetch, and a quiet none for a server with the feature off", () => {
    expect(sharedWithYouStatus({ memberships: "error", grantsSettled: true })).toBe("error");
    expect(sharedWithYouStatus({ memberships: "unavailable", grantsSettled: true })).toBe("ready");
  });

  it("is an error when the folders shared with you could not be listed, never none", () => {
    expect(sharedWithYouStatus({ memberships: "ready", grantsSettled: true, grantsFailed: true })).toBe("error");
    expect(sharedWithYouStatus({ memberships: "unavailable", grantsSettled: true, grantsFailed: true })).toBe(
      "error",
    );
    // Still waiting on the drives: that comes first.
    expect(sharedWithYouStatus({ memberships: "loading", grantsSettled: true, grantsFailed: true })).toBe("loading");
  });
});

describe("routes into a drive", () => {
  // On this page, not the Drive page: the trail then starts at Shared
  // Drives and Back from the drive's root returns to this list.
  it("opens a drive synced here by its label, and a cloud-only one as remote", () => {
    const local = row("Team", { local: { id: "team-1" } as FolderRow["local"] });
    expect(ownDriveRoute(local)).toBe("/shared-drives?openLabel=team-1");
    const remote = row("Archive", { presence: "other-device" });
    expect(ownDriveRoute(remote)).toBe("/shared-drives?openLabel=Archive&openRemote=1");
  });

  it("opens a joined drive by its browse label, with its name for the breadcrumb", () => {
    const url = new URL(
      `app://x${joinedDriveRoute({ ownerSs58: OWNER, folderHash: HASH, displayLabel: "Design team" })}`,
    );
    expect(url.pathname).toBe("/shared-drives");
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
    expect(url.pathname).toBe("/shared-drives");
    expect(url.searchParams.get("openName")).toBe("ACME");
    expect(parseFolderGrantLabel(url.searchParams.get("openLabel"))?.pathPrefix).toBe("Clients/ACME");
  });
});

const ready = (count: number): SharedKind => ({ status: "ready", count });
const loading = (count = 0): SharedKind => ({ status: "loading", count });
const failed = (count = 0): SharedKind => ({ status: "error", count });

describe("the tabs", () => {
  it("show once both kinds have answered and anything is listed, even with one kind", () => {
    expect(showSharedDrivesTabs({ withYou: ready(2), byYou: ready(1) })).toBe(true);
    expect(showSharedDrivesTabs({ withYou: ready(0), byYou: ready(1) })).toBe(true);
    expect(showSharedDrivesTabs({ withYou: ready(2), byYou: ready(0) })).toBe(true);
  });

  it("do not show with nothing either way, or while a kind is still loading", () => {
    expect(showSharedDrivesTabs({ withYou: ready(0), byYou: ready(0) })).toBe(false);
    expect(showSharedDrivesTabs({ withYou: loading(), byYou: ready(3) })).toBe(false);
    expect(showSharedDrivesTabs({ withYou: ready(3), byYou: loading() })).toBe(false);
  });

  it("show beside a failed kind when the other has rows, so the failed tab can say so", () => {
    expect(showSharedDrivesTabs({ withYou: failed(), byYou: ready(2) })).toBe(true);
    expect(showSharedDrivesTabs({ withYou: failed(), byYou: ready(0) })).toBe(false);
  });

  it("apply the chosen filter only while drawn", () => {
    expect(effectiveSharedDrivesFilter("by-you", true)).toBe("by-you");
    expect(effectiveSharedDrivesFilter("by-you", false)).toBe("all");
    expect(effectiveSharedDrivesFilter("with-you", false)).toBe("all");
  });

  it("count a kind that failed as unknown, never zero, and All with it", () => {
    expect(sharedDrivesTabCount([ready(2), ready(3)])).toBe(5);
    expect(sharedDrivesTabCount([ready(0)])).toBe(0);
    expect(sharedDrivesTabCount([failed()])).toBeUndefined();
    expect(sharedDrivesTabCount([ready(2), failed()])).toBeUndefined();
  });
});

describe("resolveSharedDrivesContent", () => {
  const resolve = (filter: "all" | "with-you" | "by-you", byYou: SharedKind, withYou: SharedKind, planKnown = true) =>
    resolveSharedDrivesContent({ filter, byYou, withYou, planKnown });

  it("holds the skeleton until both kinds answer, never an early empty", () => {
    expect(resolve("all", loading(), ready(0))).toEqual({ kind: "loading" });
    expect(resolve("all", ready(0), loading())).toEqual({ kind: "loading" });
  });

  it("shows rows that arrived, with a placeholder for a kind still loading", () => {
    expect(resolve("all", ready(2), loading())).toEqual({ kind: "rows", pending: true, failed: [] });
    expect(resolve("all", ready(2), ready(1))).toEqual({ kind: "rows", pending: false, failed: [] });
  });

  it("is empty only when everything in scope answered with nothing", () => {
    expect(resolve("all", ready(0), ready(0))).toEqual({ kind: "empty", scope: "all" });
  });

  it("is a tab's own empty state when that tab is empty and the other is not", () => {
    expect(resolve("with-you", ready(4), ready(0))).toEqual({ kind: "empty", scope: "with-you" });
    expect(resolve("by-you", ready(0), ready(4))).toEqual({ kind: "empty", scope: "by-you" });
  });

  it("ignores a kind the tab leaves out, loading or failed", () => {
    expect(resolve("by-you", ready(3), loading())).toEqual({ kind: "rows", pending: false, failed: [] });
    expect(resolve("by-you", ready(0), failed())).toEqual({ kind: "empty", scope: "by-you" });
  });

  it("is an error, not empty, when a kind in scope failed and nothing else is listed", () => {
    expect(resolve("all", failed(), failed())).toEqual({ kind: "error", scope: "all" });
    expect(resolve("all", ready(0), failed())).toEqual({ kind: "error", scope: "all" });
    expect(resolve("with-you", ready(5), failed())).toEqual({ kind: "error", scope: "with-you" });
  });

  it("shows the rows it has and names the kind that failed", () => {
    expect(resolve("all", ready(3), failed())).toEqual({ kind: "rows", pending: false, failed: ["with-you"] });
    // Folder grants listed while the drive memberships failed.
    expect(resolve("with-you", ready(0), failed(1))).toEqual({ kind: "rows", pending: false, failed: ["with-you"] });
  });

  it("waits for the plan before an empty state, which words its button by plan", () => {
    expect(resolve("all", ready(0), ready(0), false)).toEqual({ kind: "loading" });
    // Rows and errors do not depend on the plan.
    expect(resolve("all", ready(1), ready(0), false)).toEqual({ kind: "rows", pending: false, failed: [] });
    expect(resolve("all", failed(), ready(0), false)).toEqual({ kind: "error", scope: "all" });
  });
});

describe("paging", () => {
  it("is ten to a page, and draws no pager for ten or fewer", () => {
    expect(SHARED_DRIVES_PAGE_SIZE).toBe(10);
    expect(resolveFolderListPage({ total: 10, page: 1, pageSize: SHARED_DRIVES_PAGE_SIZE }).showPager).toBe(false);
    expect(resolveFolderListPage({ total: 11, page: 1, pageSize: SHARED_DRIVES_PAGE_SIZE })).toMatchObject({
      showPager: true,
      totalPages: 2,
    });
  });

  it("clamps a page left past the end when drives go away", () => {
    expect(resolveFolderListPage({ total: 10, page: 2, pageSize: SHARED_DRIVES_PAGE_SIZE })).toMatchObject({
      page: 1,
      start: 0,
      end: 10,
    });
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
