// Source pins for "Copy link" on the three-dots menus.
//
// The item itself (`useCopyLinkItem`) is covered by useCopyExistingLink.test,
// and the right-click menu and the viewer by their own render tests. A render
// test of the files table or the card grid needs the whole provider stack,
// so these pins hold the two things that can only go wrong in the wiring:
// the item sits directly above Share via link, and it looks the row up under
// the same path the row's link icon and Share via link use.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function densified(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8").replace(/\s+/g, "");
}

describe("Copy link wiring", () => {
  it("puts the table menu's Copy link directly above Share via link, under the subtree's path", () => {
    const source = densified("app/components/page-sections/drive/files-table/index.tsx");
    const copy = source.indexOf("...copyLinkItem(file,linkPathFor(file,parentSubFolderPath??normalizedSubfolderPath),),");
    const share = source.indexOf('itemTitle:"Sharevialink"');
    expect(copy, "the table menu must offer Copy link, resolved like Share via link").toBeGreaterThan(-1);
    expect(share).toBeGreaterThan(copy);
    // Nothing but Share via link's own gate between the two.
    expect(source.slice(copy, share)).not.toContain("itemTitle:");
  });

  it("builds a top-level row's menu when it opens, not when the memoized row last rendered", () => {
    const source = densified("app/components/page-sections/drive/files-table/index.tsx");
    expect(source).toContain("<RowActionMenubuildItems={buildMenuItems}>");
    expect(source).toContain("items={open?buildItems():NO_ITEMS}");
  });

  it("puts the card menu's Copy link directly above Share via link", () => {
    const source = densified("app/components/page-sections/drive/card-view/index.tsx");
    const copy = source.indexOf("...copyLinkItem(file,linkPathFor(file,currentSubfolderPath),");
    const share = source.indexOf('itemTitle:"Sharevialink"');
    expect(copy, "the card menu must offer Copy link").toBeGreaterThan(-1);
    expect(share).toBeGreaterThan(copy);
    expect(source.slice(copy, share)).not.toContain("itemTitle:");
  });
});
