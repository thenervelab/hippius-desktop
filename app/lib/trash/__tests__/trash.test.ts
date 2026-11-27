import { describe, it, expect } from "vitest";
import {
  daysUntilDeleted,
  deleteForeverText,
  deletedForeverIn,
  deletedForeverPhrase,
  emptyTrashNote,
  emptyTrashText,
  locationOf,
  movedToTrashMessage,
  movingToTrashMessage,
  progressMessage,
  retentionDays,
  retentionNotice,
  undoneMessage,
} from "../copy";
import { deleteLabel, deleteScope, engineSendsDeletesToTrash, resolveDeleteMode, rowDriveLabel } from "../deleteMode";
import { failedNote } from "../trashToast";
import { clashDestinationName, rowKey, sizeLabel } from "@/app/components/page-sections/trash/trashRows";

describe("which delete runs", () => {
  it("is today's delete while the server has no Trash, whatever else is set", () => {
    expect(resolveDeleteMode(false, false, false)).toBe("legacy");
    expect(resolveDeleteMode(false, true, true)).toBe("legacy");
    expect(deleteLabel("legacy")).toBe("Delete");
  });

  it("moves to Trash by default, and deletes forever with Option or the setting", () => {
    expect(resolveDeleteMode(true, false, false)).toBe("trash");
    expect(resolveDeleteMode(true, false, true)).toBe("forever");
    expect(resolveDeleteMode(true, true, false)).toBe("forever");
    expect(deleteLabel("trash")).toBe("Move to Trash");
    expect(deleteLabel("forever")).toBe("Delete forever");
  });

  it("never deletes forever where the account may not, Option or the setting alike", () => {
    expect(resolveDeleteMode(true, true, true, false)).toBe("trash");
    expect(resolveDeleteMode(true, false, true, false)).toBe("trash");
    expect(resolveDeleteMode(false, true, true, false)).toBe("legacy");
  });

  it("reads Rust's rules per drive, and an unknown drive allows only Move to Trash", () => {
    const drives = [
      { label: "mine", canDeleteForever: true, skipsTrash: true },
      { label: "team", canDeleteForever: true, skipsTrash: false },
      { label: "theirs", canDeleteForever: false, skipsTrash: false },
    ];
    expect(deleteScope(drives, ["mine"])).toEqual({ skipsTrash: true, canDeleteForever: true });
    expect(deleteScope(drives, ["mine", "team"])).toEqual({ skipsTrash: false, canDeleteForever: true });
    expect(deleteScope(drives, ["mine", "theirs"])).toEqual({ skipsTrash: false, canDeleteForever: false });
    expect(deleteScope(drives, ["new"])).toEqual({ skipsTrash: false, canDeleteForever: false });
    expect(deleteScope(null, ["mine"])).toEqual({ skipsTrash: false, canDeleteForever: false });
    expect(rowDriveLabel({ label: undefined } as never)).toBe("default");
  });

  it("says an engine delete goes to Trash only where the drive does not skip it", () => {
    const drives = [
      { label: "mine", canDeleteForever: true, skipsTrash: true },
      { label: "team", canDeleteForever: false, skipsTrash: false },
    ];
    expect(engineSendsDeletesToTrash(true, drives, "team")).toBe(true);
    expect(engineSendsDeletesToTrash(true, drives, "mine")).toBe(false);
    expect(engineSendsDeletesToTrash(false, drives, "team")).toBe(false);
    expect(engineSendsDeletesToTrash(true, drives, "unknown")).toBe(false);
    expect(engineSendsDeletesToTrash(true, null, "team")).toBe(false);
  });
});

describe("Trash copy", () => {
  it("names one item and counts several", () => {
    expect(movedToTrashMessage(["a.txt"], 1)).toBe("Moved “a.txt” to Trash");
    expect(movedToTrashMessage(["a", "b", "c"], 3)).toBe("Moved 3 items to Trash");
    expect(movingToTrashMessage(["a.txt"])).toBe("Moving “a.txt” to Trash…");
  });

  it("says how far a large move has got, with no limit", () => {
    expect(movingToTrashMessage(["Big"], { done: 12_400, total: 30_000 })).toBe("Moving 12,400 of 30,000 files to Trash…");
    expect(progressMessage("restore", { done: 500_000, total: 1_000_000 }, 1)).toBe("Restoring 500,000 of 1,000,000 files…");
    expect(progressMessage("delete", null, 2)).toBe("Deleting 2 items…");
  });

  it("asks before deleting forever, plainly", () => {
    expect(deleteForeverText(["a.txt"])).toBe("“a.txt” will be deleted. This can't be undone.");
    expect(deleteForeverText(["a", "b"])).toBe("These 2 items will be deleted. This can't be undone.");
    expect(emptyTrashText(4)).toBe("All 4 items in Trash will be deleted. This can't be undone.");
  });

  it("says items are deleted forever after the server's retention, 30 when it names none", () => {
    expect(retentionDays(undefined)).toBe(30);
    expect(retentionDays(null)).toBe(30);
    expect(retentionDays(0)).toBe(30);
    expect(retentionDays(14)).toBe(14);
    expect(retentionNotice(30)).toBe("Items in Trash are deleted forever after 30 days.");
    expect(retentionNotice(1)).toBe("Items in Trash are deleted forever after 1 day.");
    expect(emptyTrashNote(30)).toBe("Items moved to Trash are deleted forever after 30 days.");
  });

  it("never says an item stays until someone deletes it", () => {
    for (const text of [deleteForeverText(["a"]), emptyTrashText(3), movedToTrashMessage(["a"], 1), retentionNotice(30)]) {
      expect(text).not.toMatch(/until/i);
    }
  });

  it("says what Undo could not put back", () => {
    expect(undoneMessage(1, 0)).toEqual({ title: "Put back" });
    expect(undoneMessage(0, 1).title).toBe("Couldn't put it back");
    expect(failedNote([])).toBeUndefined();
    expect(failedNote([{ name: "a", error: "Reason." }])).toBe("Reason.");
    expect(failedNote([{ name: "a", error: "x" }, { name: "b", error: "y" }])).toBe("2 items couldn't be moved to Trash.");
  });

  it("says when an item is deleted forever: today, in 1 day, in many, never negative", () => {
    const now = new Date(2026, 10, 18, 12).getTime();
    const at = (d: Date) => Math.floor(d.getTime() / 1000);
    const trashedAt = at(new Date(2026, 9, 20, 9));
    const left = (purgeAt: Date | null) => daysUntilDeleted({ trashedAt, purgeAt: purgeAt ? at(purgeAt) : null }, 30, now);

    expect(left(new Date(2026, 10, 18, 20))).toBe(0);
    expect(deletedForeverIn(0)).toBe("Today");
    expect(deletedForeverPhrase(0)).toBe("Deleted today");

    expect(left(new Date(2026, 10, 19, 1))).toBe(1);
    expect(deletedForeverIn(1)).toBe("In 1 day");
    expect(deletedForeverPhrase(1)).toBe("Deleted in 1 day");

    expect(left(new Date(2026, 10, 30, 9))).toBe(12);
    expect(deletedForeverIn(12)).toBe("In 12 days");
    expect(deletedForeverPhrase(12)).toBe("Deleted in 12 days");

    // The time has passed and the server has not got to it yet.
    expect(left(new Date(2026, 10, 18, 11))).toBeNull();
    expect(deletedForeverIn(null)).toBe("Soon");
    expect(deletedForeverPhrase(null)).toBe("Deleting soon");
  });

  it("counts from when it was trashed when the server sends no purge time", () => {
    const now = new Date(2026, 10, 18, 12).getTime();
    const trashedAt = Math.floor(new Date(2026, 10, 8, 9).getTime() / 1000);
    expect(daysUntilDeleted({ trashedAt }, 30, now)).toBe(20);
    expect(daysUntilDeleted({ trashedAt, purgeAt: null }, 14, now)).toBe(4);
    expect(daysUntilDeleted({ trashedAt }, 7, now)).toBeNull();
  });
});

describe("Trash rows", () => {
  const row = { label: "hippius", itemId: "i1", driveName: "My Drive", parentPath: "Legal/2026", isFolder: false, fileCount: 1, totalBytes: 2048 };

  it("keys a row by drive and item", () => {
    expect(rowKey(row)).toBe("hippius::i1");
    expect(rowKey({ ...row, label: "other" })).not.toBe(rowKey(row));
  });

  it("shows where it was, drive first", () => {
    expect(locationOf("My Drive", "Legal/2026")).toBe("My Drive / Legal / 2026");
    expect(locationOf("My Drive", "")).toBe("My Drive");
  });

  it("sizes a file in bytes and a folder in files", () => {
    const bytes = (n: number) => `${n} B`;
    expect(sizeLabel(row, bytes)).toBe("2048 B");
    expect(sizeLabel({ ...row, isFolder: true, fileCount: 12 }, bytes)).toBe("12 files");
    expect(sizeLabel({ ...row, isFolder: true, fileCount: 0 }, bytes)).toBe("Empty");
  });

  it("names the folder a clash goes back to, or says its folder", () => {
    expect(clashDestinationName([row])).toBe("“2026”");
    expect(clashDestinationName([{ ...row, parentPath: "" }])).toBe("“My Drive”");
    expect(clashDestinationName([row, { ...row, parentPath: "Other" }])).toBe("its folder");
  });
});
