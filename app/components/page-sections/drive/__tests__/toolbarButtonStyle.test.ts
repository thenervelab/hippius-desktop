import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { TOOLBAR_BUTTON_GAP } from "../uploadActions";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");

/** Every button in the upload/sync toolbar family. */
const FAMILY = [
  "../DriveHeader.tsx",
  "../AddFileButton.tsx",
  "../RemoteUploadButton.tsx",
  "../RemoteFolderUploadButton.tsx",
  "../RemoteNewFolderButton.tsx",
];

/**
 * These buttons sit side by side in one row, so their spacing has to come
 * from one place. Left per-button it drifted to 10px, 8px and 7px at
 * once, and the widest of them read as a gap rather than as spacing.
 */
describe("upload toolbar button spacing", () => {
  it.each(FAMILY)("%s takes its gap from the shared constant", (file) => {
    expect(read(file)).toContain("TOOLBAR_BUTTON_GAP");
  });

  it.each(FAMILY)("%s hardcodes no gap of its own", (file) => {
    // The gap classes this replaced. A new literal here is the drift.
    expect(read(file)).not.toMatch(/gap-\[(?:10|8|7)px\]/);
  });

  it("is a small gap, not the old 10px", () => {
    expect(TOOLBAR_BUTTON_GAP).toBe("gap-1.5");
  });
});

/**
 * The drive page's folder-list toolbar is a compact 12px row. `AddButton`
 * defaults its glyph to 16px to match its OWN 14px label, which is right
 * everywhere else and wrong here — beside a 12px sibling the arrow read
 * as oversized. The caller scales it because only the caller can see the
 * neighbours.
 */
describe("the compact folder-list toolbar", () => {
  const page = read("../DriveOnboarding.tsx");
  // The JSX element, not `useRef<AddButtonRef>` — a bare "<AddButton"
  // matches the type parameter too, and then this window lands on the
  // hooks at the top of the file instead of the toolbar.
  const at = page.indexOf("<AddButton\n");
  const toolbar = page.slice(Math.max(0, at - 2000), at + 600);

  it("finds the toolbar's upload-file button", () => {
    expect(at).toBeGreaterThan(-1);
  });

  it("scales the upload-file glyph to the row", () => {
    expect(toolbar).toMatch(/iconClassName="size-3\.5"/);
  });

  it("matches the Upload Folder button standing beside it", () => {
    const sibling = toolbar.match(/<ArrowUpToLine className="(size-[\d.]+)/);
    expect(sibling?.[1]).toBe("size-3.5");
  });
});
