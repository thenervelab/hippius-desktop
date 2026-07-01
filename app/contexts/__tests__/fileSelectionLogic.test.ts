import { describe, it, expect } from "vitest";
import {
  selectionKey,
  removeDescendantsFromSelection,
} from "@/app/contexts/fileSelectionLogic";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

// Build the minimal shape the cascade reads: label, isFolder, the name fields,
// and parentRelativePath. `actualFileName` is the sync-root-relative path for
// files and the basename for folders (mirrors production).
function file(
  actualFileName: string,
  opts: { label?: string } = {}
): FormattedUserFile {
  return {
    name: actualFileName.split("/").pop() ?? actualFileName,
    actualFileName,
    isFolder: false,
    label: opts.label ?? "default",
  } as FormattedUserFile;
}

function folder(
  name: string,
  opts: { parent?: string; label?: string } = {}
): FormattedUserFile {
  return {
    name,
    actualFileName: name,
    isFolder: true,
    parentRelativePath: opts.parent ?? "",
    label: opts.label ?? "default",
  } as FormattedUserFile;
}

describe("selectionKey", () => {
  it("keys a file by label + path", () => {
    expect(selectionKey(file("docs/a.txt"))).toBe("file:default::docs/a.txt");
  });

  it("keys a folder by label + parent + basename", () => {
    expect(selectionKey(folder("photos", { parent: "trips" }))).toBe(
      "folder:default::trips/photos"
    );
  });

  it("disambiguates same-named folders in different locations", () => {
    expect(selectionKey(folder("photos", { parent: "a" }))).not.toBe(
      selectionKey(folder("photos", { parent: "b" }))
    );
  });

  it("disambiguates the same path across drives via label", () => {
    expect(selectionKey(file("a.txt", { label: "x" }))).not.toBe(
      selectionKey(file("a.txt", { label: "y" }))
    );
  });
});

describe("removeDescendantsFromSelection", () => {
  const target = folder("photos"); // folderFullPath = "photos"

  it("drops a file directly under the folder", () => {
    const result = removeDescendantsFromSelection([file("photos/a.jpg")], target);
    expect(result).toEqual([]);
  });

  it("drops a nested descendant folder and its files", () => {
    const sel = [
      folder("2024", { parent: "photos" }),
      file("photos/2024/x.jpg"),
    ];
    expect(removeDescendantsFromSelection(sel, target)).toEqual([]);
  });

  it("keeps the folder row itself", () => {
    const sel = [target];
    expect(removeDescendantsFromSelection(sel, target)).toEqual([target]);
  });

  it("does NOT drop a sibling whose name shares the folder's prefix", () => {
    // The classic prefix-boundary bug: "photos" must not subsume "photosBackup".
    const sibling = file("photosBackup/a.jpg");
    expect(removeDescendantsFromSelection([sibling], target)).toEqual([sibling]);
    const siblingFolder = folder("photosBackup");
    expect(removeDescendantsFromSelection([siblingFolder], target)).toEqual([
      siblingFolder,
    ]);
  });

  it("keeps a same-path descendant that belongs to a different drive label", () => {
    const other = file("photos/a.jpg", { label: "otherDrive" });
    expect(removeDescendantsFromSelection([other], target)).toEqual([other]);
  });

  it("keeps unrelated selections untouched", () => {
    const keep = [file("docs/readme.md"), folder("music")];
    expect(removeDescendantsFromSelection(keep, target)).toEqual(keep);
  });

  it("is a no-op on an empty selection", () => {
    expect(removeDescendantsFromSelection([], target)).toEqual([]);
  });

  it("drops only descendants, preserving siblings in the same parent", () => {
    const sel = [file("photos/a.jpg"), file("docs/b.txt"), folder("photos")];
    expect(removeDescendantsFromSelection(sel, target)).toEqual([
      file("docs/b.txt"),
      folder("photos"),
    ]);
  });
});
