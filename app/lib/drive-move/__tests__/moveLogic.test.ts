import { describe, expect, it } from "vitest";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  ALREADY_THERE,
  INSIDE_ITSELF,
  READ_ONLY_REASON,
  dragLabel,
  failedMessage,
  moveItemFor,
  moveProblem,
  moveTitle,
  movedMessage,
  normalizePath,
  rangeBetween,
  shouldShowMoveHint,
  undoRequests,
  type MoveItemResult,
} from "../moveLogic";

const file = (path: string) => ({ path, isFolder: false, name: path.split("/").pop() as string });
const folder = (path: string) => ({ path, isFolder: true, name: path.split("/").pop() as string });

const result = (over: Partial<MoveItemResult>): MoveItemResult => ({
  path: "a.txt",
  isFolder: false,
  status: "moved",
  newPath: "Reports/a.txt",
  message: null,
  clashIsFolder: false,
  replaced: false,
  ...over,
});

describe("moveProblem", () => {
  it("refuses a folder into itself or below it, but not a lookalike sibling", () => {
    expect(moveProblem([folder("Trip")], "Trip")).toBe(INSIDE_ITSELF);
    expect(moveProblem([folder("Trip")], "Trip/2024")).toBe(INSIDE_ITSELF);
    expect(moveProblem([folder("Trip")], "Trip Photos")).toBeNull();
  });

  it("refuses the folder everything already lives in", () => {
    expect(moveProblem([file("Reports/a.txt")], "Reports")).toBe(ALREADY_THERE);
    expect(moveProblem([file("a.txt"), file("b.txt")], "")).toBe(ALREADY_THERE);
    // One item from elsewhere is enough to make the move do something.
    expect(moveProblem([file("a.txt"), file("x/b.txt")], "")).toBeNull();
  });

  it("refuses everything on a drive that cannot be written", () => {
    expect(moveProblem([file("a.txt")], "Reports", READ_ONLY_REASON)).toBe(READ_ONLY_REASON);
  });

  it("compares paths in one spelling", () => {
    expect(moveProblem([file("Reports/a.txt")], "/Reports/")).toBe(ALREADY_THERE);
    expect(normalizePath("\\a\\b\\")).toBe("a/b");
  });
});

describe("moveItemFor", () => {
  it("rebuilds a folder row's path from the folder it is listed in", () => {
    const row = { name: "2024", actualFileName: "2024", isFolder: true } as FormattedUserFile;
    expect(moveItemFor(row, "Trip")).toEqual({ path: "Trip/2024", isFolder: true, name: "2024" });
  });

  it("keeps a file row's own drive-relative path", () => {
    const row = { name: "a.txt", actualFileName: "Trip/a.txt", isFolder: false } as FormattedUserFile;
    expect(moveItemFor(row, "Elsewhere").path).toBe("Trip/a.txt");
  });
});

describe("words", () => {
  it("titles the picker and labels the drag", () => {
    expect(moveTitle([file("a.txt")])).toBe('Move "a.txt"');
    expect(moveTitle([file("a.txt"), file("b.txt"), file("c.txt")])).toBe("Move 3 items");
    expect(dragLabel(3, null, null)).toBe("Move 3 items");
    expect(dragLabel(1, null, null)).toBe("Move 1 item");
    expect(dragLabel(3, "Reports", null)).toBe("Move to Reports");
    expect(dragLabel(3, "Trip", INSIDE_ITSELF)).toBe(INSIDE_ITSELF);
  });

  it("says where things went, and what did not move", () => {
    expect(movedMessage(1, "Reports")).toBe("Moved to Reports");
    expect(movedMessage(3, "Reports")).toBe("Moved 3 items to Reports");
    expect(movedMessage(0, "Reports")).toBeNull();
    expect(failedMessage([result({})])).toBeNull();
    expect(failedMessage([result({ status: "failed", message: "Nope" })])).toBe('"a.txt" couldn\'t be moved: Nope');
    expect(
      failedMessage([
        result({ status: "failed", message: "Nope" }),
        result({ path: "b.txt", status: "failed", message: "Other" }),
      ]),
    ).toBe("2 items couldn't be moved: Nope");
  });
});

describe("undoRequests", () => {
  it("moves each item back to the folder it came from, under its own name", () => {
    const undo = undoRequests([
      result({ path: "a.txt", newPath: "Reports/a (1).txt" }),
      result({ path: "x/b.txt", newPath: "Reports/b.txt" }),
      result({ path: "c.txt", status: "skipped", newPath: null }),
    ]);
    expect(undo).toEqual([
      { destination: "", items: [{ path: "Reports/a (1).txt", isFolder: false, name: "a.txt" }] },
      { destination: "x", items: [{ path: "Reports/b.txt", isFolder: false, name: "b.txt" }] },
    ]);
  });

  it("offers no Undo once a file was replaced, or when nothing moved", () => {
    expect(undoRequests([result({ replaced: true })])).toBeNull();
    expect(undoRequests([result({ status: "failed", newPath: null })])).toBeNull();
  });
});

describe("rangeBetween", () => {
  const rows = ["a", "b", "c", "d"];
  const key = (r: string) => r;

  it("selects from the anchor to the clicked row, either direction", () => {
    expect(rangeBetween(rows, key, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(rows, key, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("falls back to the clicked row when the anchor is gone", () => {
    expect(rangeBetween(rows, key, null, "c")).toEqual(["c"]);
    expect(rangeBetween(rows, key, "zz", "c")).toEqual(["c"]);
    expect(rangeBetween(rows, key, "a", "zz")).toEqual([]);
  });
});

describe("shouldShowMoveHint", () => {
  it("needs a folder and something else, and only until seen", () => {
    expect(shouldShowMoveHint([{ isFolder: true }, { isFolder: false }], false)).toBe(true);
    expect(shouldShowMoveHint([{ isFolder: true }], false)).toBe(false);
    expect(shouldShowMoveHint([{ isFolder: false }, { isFolder: false }], false)).toBe(false);
    expect(shouldShowMoveHint([{ isFolder: true }, { isFolder: false }], true)).toBe(false);
  });
});
