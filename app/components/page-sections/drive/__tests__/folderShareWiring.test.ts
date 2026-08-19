// Source pins for the folder-share path wiring.
//
// `folderShareGating.test.ts` covers the pure resolver, and it passed while the
// call sites fed it the WRONG base path — a nested folder resolved against the
// page's path instead of the expanded subtree's, so "Share via link" on
// `Trips/Photos` minted a link for a root-level `Photos`. The defect lived
// entirely in the wiring, which is exactly what a pure test cannot see.
//
// A render-level test would need the whole provider stack (auth, query client,
// router, jotai) around a table with an expanded subtree. These pins are the
// cheap layer that targets the specific mistake; the repo already uses the
// technique in Rust (`tests/keep_awake_wiring.rs`, the `spawn_backfill` pin).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Source with all whitespace stripped, so formatting can't break the pin. */
function densified(relativePath: string): string {
  const source = readFileSync(join(process.cwd(), relativePath), "utf8");
  return source.replace(/\s+/g, "");
}

describe("folder share path wiring", () => {
  it("resolves the files-table share item against the expanded subtree's path", () => {
    const source = densified(
      "app/components/page-sections/drive/files-table/index.tsx",
    );

    expect(
      source.includes(
        "shareTargetFor(file,parentSubFolderPath??normalizedSubfolderPath",
      ),
      "the share menu item must resolve against `parentSubFolderPath ?? normalizedSubfolderPath` — " +
        "the same base the delete and retry items use. Passing the bare page path resolves a " +
        "nested folder row at the drive root and shares a different folder of the same name.",
    ).toBe(true);
  });

  it("hands the right-click menu the row annotated with its parent path", () => {
    const source = densified(
      "app/components/page-sections/drive/files-table/ExpandedFolderRows.tsx",
    );

    expect(
      source.includes("onRowContextMenu?.(event,annotatedChild"),
      "the context menu must receive `annotatedChild`, not the raw `childFile`: a nested folder " +
        "row carries only a basename, and the menu's share handler resolves its path from " +
        "`parentRelativePath`, which only the annotated row has.",
    ).toBe(true);
  });
});
