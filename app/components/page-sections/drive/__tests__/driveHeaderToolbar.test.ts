import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const header = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../DriveHeader.tsx"),
  "utf8",
);

/**
 * The breadcrumb + toolbar row of the drive (non-recent) layout.
 *
 * Anchored on the row's own opening tag, not on a character window around
 * the breadcrumb: the recent-files layout has its own row a few hundred
 * characters away, and a window wide enough to miss by caught that one's
 * classes instead.
 */
const ROW_START = header.indexOf('className="flex items-center gap-x-4');
// `{actionButtons}` appears in the recent-files layout too, and earlier in
// the file, so the end of this row is searched from the row's own start.
const toolbarRow = header.slice(
  ROW_START,
  header.indexOf("</div>", header.indexOf("{actionButtons}", ROW_START)),
);

/**
 * The toolbar sits at the right edge, and must not move as you go deeper.
 *
 * `justify-between` cannot express that: it pushes the two groups apart on a
 * shared line, but on a wrapped line the actions are the only group and it
 * leaves them at the START. So the same buttons sat right at shallow depths
 * and left at deeper ones. `ml-auto` belongs to the actions group itself, so
 * it holds the right edge on whichever line the group lands on.
 */
describe("the drive header's toolbar row", () => {
  it("was actually found", () => {
    expect(ROW_START).toBeGreaterThan(-1);
    expect(toolbarRow.length).toBeGreaterThan(50);
  });

  it("holds the right edge without justify-between", () => {
    expect(toolbarRow).not.toContain("justify-between");
    expect(toolbarRow).toContain("ml-auto");
  });

  // A deep breadcrumb has to be able to wrap: the alternative is a row that
  // overflows horizontally, which the app forbids at every width.
  it("still wraps", () => {
    expect(toolbarRow).toContain("flex-wrap");
  });

  // Wrapped rows need vertical spacing too; a single `gap` that only reads as
  // horizontal leaves the two lines touching.
  it("spaces the wrapped lines apart", () => {
    expect(toolbarRow).toMatch(/gap-y-\d/);
  });
});

/**
 * A Viewer is offered no way to write, on either upload path.
 *
 * The header has two: the local buttons, which go through
 * `resolveUploadAction`, and the REMOTE block, which does not. The role gate
 * reached only the first, so a Viewer browsing a shared drive was still shown
 * New Folder, Folder and File — on a drive the server refuses every write to.
 */
describe("the header's write controls on a read-only drive", () => {
  it("gates the remote upload block on the role, not just on having a label", () => {
    const block = header.slice(header.indexOf("{remoteUpload &&"));
    expect(block.slice(0, 200)).toContain("!isReadOnlyDrive");
  });

  // The local path keeps its own gate; both must hold.
  it("gates the local upload buttons too", () => {
    expect(header).toContain("isReadOnlyDrive,");
  });
});
