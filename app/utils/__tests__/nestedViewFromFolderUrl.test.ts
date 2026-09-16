import { describe, expect, it } from "vitest";

import { generateFolderUrl } from "@/app/utils/folderUrlUtils";
import { isNestedFolderView } from "@/lib/utils/filesViewMode";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * `isNestedFolderView` wants BOTH `folderName` and `subFolderPath`, so the
 * question worth a test is not what it does with a pair handed to it, but
 * whether the URL the app actually builds carries both.
 *
 * It is not obvious that it does. `buildFolderPath` returns an empty
 * `subFolderPath` when no main folder is set, which reads like the first level
 * in would have only half the pair. It does not: `generateFolderUrl` defaults
 * `mainFolderActualName` to the clicked folder's own name, so the main folder
 * is always set by the time the path is built.
 *
 * SCOPE, because it is easy to over-read these: this covers clicking a folder
 * row from INSIDE a drive's listing, the only entry point that builds a URL.
 * Opening a drive from the Drive page's folder list is a different path
 * entirely — it sets state in `DriveContainer` and changes no URL — so none of
 * this says anything about whether the plan card is visible there. That is
 * `driveAtFolderListAtom`, pinned in `plan-chip/__tests__/planCardWiring.test.ts`
 * and `lib/utils/__tests__/filesViewMode.test.ts`. Reading these tests as
 * covering it is what left the card on screen one level in.
 */

const folder = (name: string): FormattedUserFile =>
  ({
    name,
    actualFileName: name,
    isFolder: true,
    arionHash: `hash-${name}`,
    source: "/Users/someone/Documents",
    mainReqHash: "req-1",
  }) as unknown as FormattedUserFile;

/** The URL bar at a drive's root: none of the folder params are set yet. */
const atRoot = (_name: string, fallback = "") => fallback;

/** A getter over the params a previous navigation put in the URL. */
const atParams =
  (params: Record<string, string>) =>
  (name: string, fallback = "") =>
    params[name] ?? fallback;

describe("nested-view detection over the URLs a folder row really builds", () => {
  it("counts a drive's root as not nested, so the card shows there", () => {
    expect(
      isNestedFolderView({
        folderName: atRoot("folderName") || null,
        subFolderPath: atRoot("subFolderPath") || null,
      }),
    ).toBe(false);
  });

  it("carries both params on the FIRST click into a top-level folder", () => {
    const { queryParams } = generateFolderUrl(folder("Documents"), atRoot);

    expect(queryParams.folderName).toBe("Documents");
    // The one that could plausibly have been empty here, and is not.
    expect(queryParams.subFolderPath).toBe("Documents");
    expect(isNestedFolderView(queryParams)).toBe(true);
  });

  it("keeps both params a second level down", () => {
    const first = generateFolderUrl(folder("Documents"), atRoot).queryParams;
    const second = generateFolderUrl(
      folder("barat photos"),
      atParams(first),
    ).queryParams;

    expect(second.subFolderPath).toBe("Documents/barat photos");
    expect(isNestedFolderView(second)).toBe(true);
  });

  it("stays nested when a row inside an expanded subtree is clicked", () => {
    // These pass the parent path explicitly rather than reading the URL,
    // because the URL still points at an ancestor several levels up.
    const { queryParams } = generateFolderUrl(
      folder("2024"),
      atRoot,
      "Documents/barat photos",
    );

    expect(queryParams.subFolderPath).toBe("Documents/barat photos/2024");
    expect(isNestedFolderView(queryParams)).toBe(true);
  });
});
