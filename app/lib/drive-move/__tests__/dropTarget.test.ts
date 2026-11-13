import { describe, expect, it } from "vitest";
import { ALREADY_THERE, INSIDE_ITSELF, READ_ONLY_REASON, moveProblem } from "../moveLogic";
import { dropGroupRole, dropVerdict, rowDropFolder, type DropFolder } from "../dropTarget";

const file = (path: string) => ({ path, isFolder: false, name: path.split("/").pop() as string });
const folder = (path: string) => ({ path, isFolder: true, name: path.split("/").pop() as string });
const at = (path: string, name = path.split("/").pop() || "My Drive"): DropFolder => ({ path, name });

// The table as the example in the request: Folder 1 and Folder 2 both
// expanded, Folder 1/Sub expanded too.
//   Folder 1            (top level)
//     notes.txt         (listed in Folder 1)
//     Sub               (listed in Folder 1)
//       Deep            (listed in Folder 1/Sub)
//         inner.png     (listed in Folder 1/Sub/Deep)
//       a.txt           (listed in Folder 1/Sub)
//   Folder 2
//     test.pdf
//   top.txt             (listed in the folder on screen, the drive's top)
const testPdf = file("Folder 2/test.pdf");

describe("rowDropFolder", () => {
  it("is the folder itself on a folder row, at any depth", () => {
    expect(rowDropFolder(folder("Folder 1"), at(""))).toEqual(at("Folder 1"));
    expect(rowDropFolder(folder("Folder 1/Sub"), at("Folder 1"))).toEqual(at("Folder 1/Sub"));
    expect(rowDropFolder(folder("Folder 1/Sub/Deep"), at("Folder 1/Sub"))).toEqual(at("Folder 1/Sub/Deep"));
  });

  it("is the folder a file is listed in, at any depth", () => {
    expect(rowDropFolder(file("Folder 1/notes.txt"), at("Folder 1"))).toEqual(at("Folder 1"));
    expect(rowDropFolder(file("Folder 1/Sub/Deep/inner.png"), at("Folder 1/Sub/Deep"))).toEqual(
      at("Folder 1/Sub/Deep"),
    );
  });

  it("is the folder on screen for a top-level file", () => {
    expect(rowDropFolder(file("top.txt"), at("", "My Drive"))).toEqual(at("", "My Drive"));
    expect(rowDropFolder(file("Work/top.txt"), at("Work"))).toEqual(at("Work"));
  });

  it("is the expanded folder for a loading or empty row under it", () => {
    expect(rowDropFolder(null, at("Folder 1/Sub"))).toEqual(at("Folder 1/Sub"));
  });

  it("compares paths in one spelling", () => {
    expect(rowDropFolder({ path: "/Folder 1/Sub/", isFolder: true, name: "Sub" }, at(""))).toEqual({ path: "Folder 1/Sub", name: "Sub" });
  });
});

describe("dropVerdict", () => {
  it("moves a file from another expanded folder into the folder of the file it is over", () => {
    const over = rowDropFolder(file("Folder 1/notes.txt"), at("Folder 1"));
    expect(dropVerdict([testPdf], over, "Folder 1/notes.txt")).toEqual({ kind: "valid" });
  });

  it("moves into a subfolder when over its row, and into a deeper folder when over a file in it", () => {
    expect(dropVerdict([testPdf], rowDropFolder(folder("Folder 1/Sub"), at("Folder 1")), "Folder 1/Sub")).toEqual({
      kind: "valid",
    });
    const deep = rowDropFolder(file("Folder 1/Sub/Deep/inner.png"), at("Folder 1/Sub/Deep"));
    expect(deep.path).toBe("Folder 1/Sub/Deep");
    expect(dropVerdict([testPdf], deep, "Folder 1/Sub/Deep/inner.png")).toEqual({ kind: "valid" });
  });

  it("takes a drop on an expanded folder's own row", () => {
    expect(dropVerdict([testPdf], at("Folder 1"), "Folder 1")).toEqual({ kind: "valid" });
  });

  it("moves to the folder on screen when over a top-level file", () => {
    expect(dropVerdict([testPdf], rowDropFolder(file("top.txt"), at("")), "top.txt")).toEqual({ kind: "valid" });
  });

  it("does nothing over a sibling: the target is the folder it is already in", () => {
    // test.pdf over another file of Folder 2, over the Folder 2 row, or
    // over Folder 2's empty line all stand for Folder 2.
    expect(dropVerdict([testPdf], at("Folder 2"), "Folder 2/other.pdf")).toEqual({ kind: "none" });
    expect(dropVerdict([testPdf], at("Folder 2"), "Folder 2")).toEqual({ kind: "none" });
    expect(dropVerdict([testPdf], at("Folder 2"))).toEqual({ kind: "none" });
    // The refusal the picker shows for the same folder, so the two agree.
    expect(moveProblem([testPdf], "Folder 2")).toBe(ALREADY_THERE);
  });

  it("does nothing over the row being dragged", () => {
    expect(dropVerdict([testPdf], at("Folder 2"), "Folder 2/test.pdf")).toEqual({ kind: "none" });
    // A dragged folder over its own row would otherwise read as "into itself".
    expect(dropVerdict([folder("Folder 1")], at("Folder 1"), "Folder 1")).toEqual({ kind: "none" });
  });

  it("refuses a folder into itself or anything below it", () => {
    const dragged = [folder("Folder 1")];
    expect(dropVerdict(dragged, at("Folder 1"), "Folder 1/notes.txt")).toEqual({
      kind: "invalid",
      reason: INSIDE_ITSELF,
    });
    expect(dropVerdict(dragged, at("Folder 1/Sub"), "Folder 1/Sub")).toEqual({ kind: "invalid", reason: INSIDE_ITSELF });
    expect(dropVerdict(dragged, at("Folder 1/Sub/Deep"), "Folder 1/Sub/Deep/inner.png")).toEqual({
      kind: "invalid",
      reason: INSIDE_ITSELF,
    });
    // A lookalike sibling is not inside it.
    expect(dropVerdict(dragged, at("Folder 10"), "Folder 10")).toEqual({ kind: "valid" });
  });

  it("follows the same rule for a multi-select drag", () => {
    const both = [testPdf, file("top.txt")];
    // One of them already lives in Folder 2, the other does not: a move.
    expect(dropVerdict(both, at("Folder 2"), "Folder 2/other.pdf")).toEqual({ kind: "valid" });
    // Both already at the top level: nothing to do.
    expect(dropVerdict([file("a.txt"), file("b.txt")], at(""), "c.txt")).toEqual({ kind: "none" });
    // Any folder in the selection going into itself refuses the whole drop.
    expect(dropVerdict([testPdf, folder("Folder 1")], at("Folder 1/Sub"), "Folder 1/Sub")).toEqual({
      kind: "invalid",
      reason: INSIDE_ITSELF,
    });
  });

  it("says why a drive that cannot change refuses", () => {
    expect(dropVerdict([testPdf], at("Folder 1"), "Folder 1", READ_ONLY_REASON)).toEqual({
      kind: "invalid",
      reason: READ_ONLY_REASON,
    });
  });

  it("is nothing with no target or nothing dragged", () => {
    expect(dropVerdict([testPdf], null)).toEqual({ kind: "none" });
    expect(dropVerdict([], at("Folder 1"))).toEqual({ kind: "none" });
  });
});

describe("dropGroupRole", () => {
  it("outlines the target folder's row and lights every row inside it", () => {
    const target = "Folder 1";
    expect(dropGroupRole(folder("Folder 1"), "", target)).toBe("target");
    expect(dropGroupRole(file("Folder 1/notes.txt"), "Folder 1", target)).toBe("member");
    expect(dropGroupRole(folder("Folder 1/Sub"), "Folder 1", target)).toBe("member");
    expect(dropGroupRole(file("Folder 1/Sub/Deep/inner.png"), "Folder 1/Sub/Deep", target)).toBe("member");
    expect(dropGroupRole(null, "Folder 1/Sub", target)).toBe("member");
  });

  it("leaves rows outside the target alone", () => {
    const target = "Folder 1/Sub";
    expect(dropGroupRole(folder("Folder 1"), "", target)).toBeNull();
    expect(dropGroupRole(file("Folder 1/notes.txt"), "Folder 1", target)).toBeNull();
    expect(dropGroupRole(folder("Folder 2"), "", target)).toBeNull();
    expect(dropGroupRole(file("Folder 2/test.pdf"), "Folder 2", target)).toBeNull();
    // A lookalike name is not inside it.
    expect(dropGroupRole(file("Folder 1/Sub2/x.txt"), "Folder 1/Sub2", target)).toBeNull();
  });

  it("lights the whole listing when the target is the folder on screen", () => {
    expect(dropGroupRole(file("top.txt"), "", "")).toBe("member");
    expect(dropGroupRole(folder("Folder 1"), "", "")).toBe("member");
    expect(dropGroupRole(file("Work/top.txt"), "Work", "Work")).toBe("member");
  });

  it("lights nothing when nothing is targeted", () => {
    expect(dropGroupRole(folder("Folder 1"), "", null)).toBeNull();
  });
});
