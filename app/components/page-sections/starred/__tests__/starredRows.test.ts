import { describe, expect, it } from "vitest";

import type { StarredItem } from "@/app/lib/tauri/starred";
import { isCloudOnlyRow } from "@/app/lib/utils/cloudOnly";
import { canRenameFile } from "@/app/lib/utils/renameGating";
import { driveRelativePathFor } from "@/app/lib/utils/driveRelativePath";
import { resolveRowRelativePath } from "@/app/lib/utils/rowRelativePath";
import { isSelectableRow } from "@/app/lib/utils/selectableRow";
import { starTargetFor } from "@/app/lib/starred/starState";
import { arionContentHash } from "@/app/lib/utils/arionContentHash";
import { partHashesTarget } from "@/app/lib/hooks/useFilePartHashes";
import {
  arrangeStarredItems,
  matchesStarredSearch,
  starredFolderHref,
  starredItemRow,
} from "../starredRows";

const FILE_ID = "ab".repeat(32);

function starredItem(overrides: Partial<StarredItem> = {}): StarredItem {
  const kind = overrides.kind ?? "file";
  return {
    key: `5Me|0123456789abcdef|${kind}:${overrides.name ?? "plan.pdf"}`,
    kind,
    ownerSs58: "5Me",
    folderHash: "0123456789abcdef",
    name: "plan.pdf",
    path: "Work/plan.pdf",
    fileId: kind === "file" ? FILE_ID : null,
    size: 100,
    createdAt: 1_790_000_000,
    fileCount: null,
    isOwn: true,
    driveName: "Docs",
    location: "Docs / Work",
    openLabel: "Docs",
    openRemote: false,
    openName: null,
    openPath: "Work",
    uploadedBy: null,
    uploadedByName: null,
    arionCid: "",
    ...overrides,
  };
}

describe("matchesStarredSearch", () => {
  it("needs every word, in any order, in any case", () => {
    expect(matchesStarredSearch("Q3 Tax Report.pdf", "report tax")).toBe(true);
    expect(matchesStarredSearch("Q3 Tax Report.pdf", "REPORT  q3")).toBe(true);
    expect(matchesStarredSearch("Q3 Tax Report.pdf", "report budget")).toBe(false);
    expect(matchesStarredSearch("anything", "   ")).toBe(true);
  });
});

describe("arrangeStarredItems", () => {
  const items = [
    starredItem({ name: "b.pdf", size: 1, createdAt: 30 }),
    starredItem({ kind: "folder", name: "Zeta", fileId: null, size: 50, createdAt: 10 }),
    starredItem({ name: "a.pdf", size: 9, createdAt: 20 }),
    starredItem({ kind: "drive", name: "Photos", fileId: null, size: 5, createdAt: 40 }),
  ];
  const names = (list: StarredItem[]) => list.map((i) => i.name);

  it("lists drives, then folders, then files, by name to start with", () => {
    expect(names(arrangeStarredItems(items, ""))).toEqual(["Photos", "Zeta", "a.pdf", "b.pdf"]);
  });

  it("sorts inside each group, and keeps the groups whatever the sort", () => {
    expect(names(arrangeStarredItems(items, "", { key: "size", dir: "desc" }))).toEqual([
      "Photos",
      "Zeta",
      "a.pdf",
      "b.pdf",
    ]);
    expect(names(arrangeStarredItems(items, "", { key: "date", dir: "desc" }))).toEqual([
      "Photos",
      "Zeta",
      "b.pdf",
      "a.pdf",
    ]);
    expect(names(arrangeStarredItems(items, "", { key: "name", dir: "desc" }))).toEqual([
      "Photos",
      "Zeta",
      "b.pdf",
      "a.pdf",
    ]);
  });

  it("shows only what the search matches", () => {
    expect(names(arrangeStarredItems(items, "PDF a"))).toEqual(["a.pdf"]);
  });
});

describe("starredItemRow", () => {
  it("shows a file of a drive synced here as the Drive's local row", () => {
    const row = starredItemRow(starredItem(), "/Users/me/Docs/")!;
    expect(row.source).toBe("/Users/me/Docs/Work/plan.pdf");
    expect(row.actualFileName).toBe("Work/plan.pdf");
    expect(row.label).toBe("Docs");
    // On disk: preview, download and delete take the local path.
    expect(row.fileId).toBeUndefined();
    expect(isCloudOnlyRow(row)).toBe(false);
    // Its star still names it by id.
    expect(row.arionHash).toBe(FILE_ID);
    expect(canRenameFile(row)).toBe(true);
  });

  it("shows a file of a drive browsed from the server as a server row it can rename there", () => {
    const row = starredItemRow(starredItem({ openRemote: true, openLabel: "Old" }), null)!;
    expect(row.fileId).toBe(FILE_ID);
    expect(row.source).toBeUndefined();
    expect(row.remoteDriveLabel).toBe("Old");
    expect(isCloudOnlyRow(row)).toBe(true);
    expect(canRenameFile(row)).toBe(true);
  });

  it("gives File Details a starred file's Arion hash, as a Drive row does", () => {
    const cid = "cd".repeat(32);
    // Synced here and browsed from the server alike.
    for (const row of [
      starredItemRow(starredItem({ arionCid: cid }), "/Users/me/Docs")!,
      starredItemRow(starredItem({ arionCid: cid, openRemote: true, openLabel: "Old" }), null)!,
    ]) {
      expect(arionContentHash(row)).toBe(cid);
    }
    // A large one asks for its parts by its drive and id, as in the Drive.
    const large = starredItemRow(starredItem({ arionCid: cid, size: 20_000_000 }), "/Users/me/Docs")!;
    expect(partHashesTarget(large)).toEqual({ label: "Docs", pathHash: FILE_ID });
    // Not hashed yet: File Details says so, as for a Drive row.
    expect(arionContentHash(starredItemRow(starredItem(), "/Users/me/Docs")!)).toBeNull();
  });

  it("gives a folder its full path, which every Drive path resolver keeps as it is", () => {
    const local = starredItemRow(starredItem({ kind: "folder", name: "Q3", openPath: "Work/Q3", fileId: null }), "/d")!;
    expect(local.isFolder).toBe(true);
    expect(local.name).toBe("Q3");
    // The table's own base is "" (the rows come from many folders), and it
    // re-annotates a selected top-level folder with that base: the path must
    // survive both.
    expect(local.actualFileName).toBe("Work/Q3");
    expect(driveRelativePathFor(local)).toBe("Work/Q3");
    expect(driveRelativePathFor({ ...local, parentRelativePath: "" }, "")).toBe("Work/Q3");
    expect(resolveRowRelativePath("", local.actualFileName ?? "")).toBe("Work/Q3");
    expect(local.source).toBe("/d/Work/Q3");
    expect(local.location).toBe("Docs / Work");
    const remote = starredItemRow(
      starredItem({ kind: "folder", name: "Q3", openPath: "Work/Q3", openRemote: true, fileId: null }),
      null,
    )!;
    expect(remote.source).toBe("remote://Docs");
    expect(isCloudOnlyRow(remote)).toBe(true);
  });

  it("shows a drive as a row for the whole drive, which no folder action may touch", () => {
    const synced = starredItemRow(starredItem({ kind: "drive", name: "Docs", fileId: null, openPath: "" }), "/d/")!;
    expect(synced).toMatchObject({ isFolder: true, isDriveRoot: true, actualFileName: "", source: "/d", label: "Docs" });
    expect(synced.location).toBeUndefined();
    // Never selected for a bulk Delete or Move: its source is the sync root.
    expect(isSelectableRow(synced)).toBe(false);
    // Its star is the drive's.
    expect(starTargetFor(synced)).toEqual({ kind: "drive", name: "Docs", label: "Docs" });
    const browsed = starredItemRow(
      starredItem({ kind: "drive", name: "Team", fileId: null, openPath: "", openRemote: true, openLabel: "shared:5O~0123456789abcdef" }),
      null,
    )!;
    expect(browsed.source).toBe("remote://shared:5O~0123456789abcdef");
    expect(browsed.remoteDriveLabel).toBe("shared:5O~0123456789abcdef");
  });
});

describe("starredFolderHref", () => {
  const names = new Map([["shared:5O~0123456789abcdef", "Team"]]);

  it("opens a starred folder, or a folder inside one, right on the Starred page", () => {
    const folder = starredItemRow(starredItem({ kind: "folder", name: "Q3", openPath: "Work/Q3", fileId: null }), "/d")!;
    expect(starredFolderHref(folder, undefined, names)).toBe("/starred?openLabel=Docs&openSubfolder=Work%2FQ3");
    // A child of the expanded folder: a bare name, beside its parent's path.
    const child = { ...folder, name: "Jan", actualFileName: "Jan", parentRelativePath: "Work/Q3", source: "/d/Work/Q3/Jan" };
    expect(starredFolderHref(child, "Work/Q3", names)).toBe("/starred?openLabel=Docs&openSubfolder=Work%2FQ3%2FJan");
  });

  it("opens a drive at its root, and a shared one from the server with its name", () => {
    const drive = starredItemRow(
      starredItem({ kind: "drive", name: "Team", fileId: null, openPath: "", openRemote: true, openLabel: "shared:5O~0123456789abcdef" }),
      null,
    )!;
    const href = new URL(starredFolderHref(drive, undefined, names)!, "https://x");
    expect(href.pathname).toBe("/starred");
    expect(Object.fromEntries(href.searchParams)).toEqual({
      openLabel: "shared:5O~0123456789abcdef",
      openRemote: "1",
      openName: "Team",
    });
  });

  it("has nowhere to open for a row with no drive", () => {
    expect(starredFolderHref({ ...starredItemRow(starredItem(), null), label: undefined }, undefined, names)).toBeNull();
  });
});
