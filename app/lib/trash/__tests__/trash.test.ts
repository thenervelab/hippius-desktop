import { describe, it, expect } from "vitest";
import {
  deleteForeverText,
  deletedWhen,
  emptyTrashText,
  locationOf,
  movedToTrashMessage,
  movingToTrashMessage,
  progressMessage,
  undoneMessage,
} from "../copy";
import { deleteLabel, resolveDeleteMode, skipTrashKey } from "../deleteMode";
import { ENGINE_SENDS_DELETES_TO_TRASH } from "../engine";
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

  it("keeps the setting per account", () => {
    expect(skipTrashKey("5Alice")).not.toBe(skipTrashKey("5Bob"));
  });

  it("does not tell anyone an engine delete goes to Trash until the engine trashes", () => {
    expect(ENGINE_SENDS_DELETES_TO_TRASH).toBe(false);
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

  it("never mentions a time limit", () => {
    for (const text of [deleteForeverText(["a"]), emptyTrashText(3), movedToTrashMessage(["a"], 1)]) {
      expect(text).not.toMatch(/days?|purge|automatic/i);
    }
  });

  it("says what Undo could not put back", () => {
    expect(undoneMessage(1, 0)).toEqual({ title: "Put back" });
    expect(undoneMessage(0, 1).title).toBe("Couldn't put it back");
    expect(failedNote([])).toBeUndefined();
    expect(failedNote([{ name: "a", error: "Reason." }])).toBe("Reason.");
    expect(failedNote([{ name: "a", error: "x" }, { name: "b", error: "y" }])).toBe("2 items couldn't be moved to Trash.");
  });

  it("dates a deletion by days, then by date", () => {
    const now = new Date(2026, 10, 18, 12).getTime();
    const at = (d: Date) => Math.floor(d.getTime() / 1000);
    expect(deletedWhen(at(new Date(2026, 10, 18, 1)), now)).toBe("Today");
    expect(deletedWhen(at(new Date(2026, 10, 17, 23)), now)).toBe("Yesterday");
    expect(deletedWhen(at(new Date(2026, 10, 13, 9)), now)).toBe("5 days ago");
    expect(deletedWhen(at(new Date(2026, 9, 3, 9)), now)).toBe("Oct 3");
    expect(deletedWhen(at(new Date(2025, 9, 3, 9)), now)).toBe("Oct 3, 2025");
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
