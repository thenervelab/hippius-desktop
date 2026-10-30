import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ShareSummary } from "@/app/lib/tauri/shares";
import { buildShareIndex, captureSharesFrom, newestShare, shareLookups } from "../fileLinks";

function share(overrides: Partial<ShareSummary>): ShareSummary {
  return {
    shareToken: "t",
    filename: "f",
    plaintextSize: 1,
    ciphertextSize: 1,
    mimeType: "image/png",
    createdAt: "2026-10-30T09:00:00Z",
    expiresAt: null,
    shareUrl: "https://console.hippius.com/s/t#k=1",
    isPrivate: false,
    folderLabel: null,
    relativePath: null,
    ...overrides,
  };
}

interface FileLinkCase {
  note: string;
  file: { label: string; path: string; size: number | null };
  link: { filename: string; size: number; origin: { label: string; path: string } | null };
  belongs: boolean;
}

// The same fixture Rust's `link_belongs_to_file` is held to, so the link icon
// a row shows and the link its Copy link copies are found by one rule.
const cases = JSON.parse(
  readFileSync(resolve(process.cwd(), "src-tauri/tests/fixtures/file_link_cases.json"), "utf8"),
) as FileLinkCase[];

describe("which links belong to a file (FE ⇔ Rust link_belongs_to_file)", () => {
  it("loads a non-empty shared fixture", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.note, c] as const))("%s", (_note, c) => {
    const index = buildShareIndex([
      share({
        filename: c.link.filename,
        plaintextSize: c.link.size,
        folderLabel: c.link.origin?.label ?? null,
        relativePath: c.link.origin?.path ?? null,
      }),
    ]);
    const found = captureSharesFrom(shareLookups(index), c.file.label, c.file.path, c.file.size ?? undefined);
    expect(found.length > 0).toBe(c.belongs);
  });
});

describe("the share index", () => {
  it("files a link made here under its drive and path, and one made elsewhere under its name", () => {
    const here = share({ shareToken: "here", folderLabel: "Docs", relativePath: "a.png", filename: "a.png" });
    const elsewhere = share({ shareToken: "web", filename: "Screenshot 2026-10-30 at 11.58.27.png" });
    const lookups = shareLookups(buildShareIndex([here, elsewhere]));
    expect(lookups.getSharesFor("Docs", "a.png")).toEqual([here]);
    expect(lookups.getSharesFor("Docs", "b.png")).toEqual([]);
    expect(lookups.getSharesFor(null, "a.png")).toEqual([]);
    expect(lookups.getUnplacedSharesNamed("Screenshot 2026-10-30 at 11.58.27.png")).toEqual([elsewhere]);
    expect(lookups.getUnplacedSharesNamed(undefined)).toEqual([]);
  });

  it("names the newest link the file's", () => {
    const old = share({ shareToken: "old", createdAt: "2026-10-01T00:00:00Z" });
    const fresh = share({ shareToken: "new", createdAt: "2026-10-30T00:00:00Z" });
    expect(newestShare([old, fresh])?.shareToken).toBe("new");
    expect(newestShare([])).toBeNull();
  });
});
