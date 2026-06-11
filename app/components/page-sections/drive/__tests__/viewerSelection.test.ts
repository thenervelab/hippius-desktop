// Pins the viewer-selection invariants behind the "open a file from an
// inline-expanded folder" gallery scoping (see viewerSelection.ts):
// the opened file and the sibling list it came from move as one value,
// closing always clears the list, and an open without a list never
// inherits one — otherwise a top-level file opened after a nested one
// would show the previous folder's thumbnail rail.

import { describe, it, expect } from "vitest";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  EMPTY_VIEWER_SELECTION,
  nextViewerSelection,
} from "../shared/viewerSelection";

const makeFile = (actualFileName: string): FormattedUserFile =>
  ({
    name: actualFileName.split("/").pop() ?? actualFileName,
    actualFileName,
    size: 1,
    createdAt: 0,
    arionHash: "",
    arionCid: "",
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 0,
    isFolder: false,
    type: "private",
    isErasureCoded: false,
    mainReqHash: "",
  }) as FormattedUserFile;

describe("nextViewerSelection", () => {
  const nestedFile = makeFile("web-app/photo.jpg");
  const siblings = [
    makeFile("web-app/photo.jpg"),
    makeFile("web-app/clip.mp4"),
    makeFile("web-app/notes.pdf"),
  ];

  it("pairs a nested open with the folder's sibling list", () => {
    const selection = nextViewerSelection(nestedFile, siblings);
    expect(selection.file).toBe(nestedFile);
    expect(selection.previewList).toBe(siblings);
  });

  it("resolves a top-level open (no list) to the page fallback, never an inherited list", () => {
    const selection = nextViewerSelection(makeFile("top-level.jpg"));
    expect(selection.previewList).toBeNull();
  });

  it("clears the preview list on close, even if a list is passed alongside null", () => {
    // Guards against a future caller leaking scope through a close — a
    // closed viewer must always reopen against the page's own list unless
    // the next open explicitly provides one.
    expect(nextViewerSelection(null, siblings)).toEqual(
      EMPTY_VIEWER_SELECTION,
    );
    expect(nextViewerSelection(null)).toEqual(EMPTY_VIEWER_SELECTION);
  });
});
