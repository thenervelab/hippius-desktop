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
 * The toolbar must not move as you go deeper.
 *
 * With `justify-between`, the actions sat at the right edge while the
 * breadcrumb was short, and then jumped to the LEFT of a second line the
 * moment the breadcrumb grew enough to wrap them — so the same buttons were
 * in two different places depending on how deep the folder was.
 */
describe("the drive header's toolbar row", () => {
  it("was actually found", () => {
    expect(ROW_START).toBeGreaterThan(-1);
    expect(toolbarRow.length).toBeGreaterThan(50);
  });

  it("aligns left rather than pushing the actions to the far edge", () => {
    expect(toolbarRow).not.toContain("justify-between");
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
