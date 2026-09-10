import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readCode = (rel: string) =>
  readFileSync(join(here, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("renaming a folder addresses the folder on screen", () => {
  const hook = readCode("../index.tsx");

  // Sending `actualFileName` for a folder sent a bare basename, so Rust
  // looked for it at the drive root and refused the rename.
  it("resolves the path instead of sending the displayed name", () => {
    expect(hook).toContain("driveRelativePathFor");
    expect(hook).not.toMatch(/name:\s*file\.actualFileName \|\| file\.name/);
  });

  it("uses the resolved path for a remote rename too", () => {
    expect(hook).toMatch(/const relative = relativePath\.replace/);
  });

  // The path only exists on the row if the listing puts it there.
  it("the nested listing tags folder rows with their parent", () => {
    const listing = readCode("../../use-nested-folder-listing.ts");
    expect(listing).toMatch(/parentRelativePath: entry\.is_folder \?/);
  });

  // One resolver for the same question, so a rename and a share cannot
  // disagree about which folder a row means.
  it("shares one resolver with the folder share", () => {
    expect(readCode("../../../utils/folderShareGating.ts")).toContain(
      "driveRelativePathFor",
    );
  });
});

/**
 * On the server a folder is not a record. `/browse` derives folder rows by
 * grouping FILE rows on their next path segment, so the only thing that
 * moves a folder is re-keying every record beneath it.
 *
 * Sending a folder through `rename_remote_file` therefore did one of two
 * things, both silent: it found no record at the folder's path and failed,
 * or — for a folder registered as an empty entity — it moved that marker
 * alone and left every file inside under the old prefix.
 */
describe("renaming a folder in a remote drive", () => {
  const hook = readCode("../index.tsx");

  it("uses the folder command, not the file one", () => {
    expect(hook).toContain("rename_remote_folder");
  });

  it("picks the command from whether the row is a folder", () => {
    expect(hook).toMatch(/file\.isFolder\s*\?\s*"rename_remote_folder"/);
  });

  // Both commands take the same shape, so the branch is the command name
  // only — a second invoke call is how the two argument lists drift.
  it("does not build a second argument list for it", () => {
    // `invoke<T>(` for the local branch, `invoke(` for the remote one.
    expect(hook.match(/await invoke[<(]/g) ?? []).toHaveLength(2);
  });

  // A file row must still take the file path: it IS a record, and the
  // batch walk would be wasted work.
  it("leaves file rows on the file command", () => {
    expect(hook).toContain('"rename_remote_file"');
  });
});

