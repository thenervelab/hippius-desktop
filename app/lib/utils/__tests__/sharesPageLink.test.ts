import { describe, expect, it } from "vitest";

import { activeShareRowId } from "@/app/(pages)/shares/shareRowDisplay";
import type { FolderShareSummary, ShareSummary } from "@/app/lib/tauri/shares";
import {
  fileShareRowId,
  folderShareRowId,
  parseSharesHighlight,
  SHARES_HIGHLIGHT_PARAM,
  sharesPageHref,
} from "../sharesPageLink";

/** What the shares page reads back from a link the badge built. */
function idsFromHref(href: string): Set<string> {
  const query = href.split("?")[1] ?? "";
  return parseSharesHighlight(new URLSearchParams(query).get(SHARES_HIGHLIGHT_PARAM));
}

describe("sharesPageHref", () => {
  it("is the bare page when there is nothing to highlight", () => {
    expect(sharesPageHref([])).toBe("/shares");
    expect(idsFromHref("/shares").size).toBe(0);
  });

  it("names the rows the table will highlight, for both kinds", () => {
    // The badge and the table derive ids separately; this is the contract
    // that lets the page find the row the badge was clicked for.
    const file = { shareToken: "tok/with+chars=" } as ShareSummary;
    const folder = { tokenHash: "ab".repeat(32) } as FolderShareSummary;

    const href = sharesPageHref([
      folderShareRowId(folder.tokenHash),
      fileShareRowId(file.shareToken),
    ]);

    expect(idsFromHref(href)).toEqual(
      new Set([
        activeShareRowId({ kind: "folder", folder }),
        activeShareRowId({ kind: "file", file }),
      ]),
    );
  });
});

describe("parseSharesHighlight", () => {
  it("ignores blanks and stray separators", () => {
    expect(parseSharesHighlight(" file:a, ,folder:b,")).toEqual(
      new Set(["file:a", "folder:b"]),
    );
    expect(parseSharesHighlight(null).size).toBe(0);
    expect(parseSharesHighlight("").size).toBe(0);
  });
});
