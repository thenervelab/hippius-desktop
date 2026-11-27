import { describe, expect, it } from "vitest";

import { PART_LIST_MIN_BYTES, partHashesTarget } from "../useFilePartHashes";

const PATH_ID = "ab".repeat(32);
const SEARCH_ID = "cd".repeat(32);

const file = (over: Record<string, unknown> = {}) => ({
  isFolder: false,
  size: PART_LIST_MIN_BYTES,
  arionCid: "ef".repeat(32),
  arionHash: PATH_ID,
  label: "Docs",
  ...over,
});

describe("partHashesTarget", () => {
  it("asks for a large file by its drive and path id", () => {
    expect(partHashesTarget(file())).toEqual({ label: "Docs", pathHash: PATH_ID });
  });

  it("does not ask for a file that fits one part", () => {
    expect(partHashesTarget(file({ size: PART_LIST_MIN_BYTES - 1 }))).toBeNull();
  });

  it("does not ask for a folder or a file with no content hash yet", () => {
    expect(partHashesTarget(file({ isFolder: true }))).toBeNull();
    expect(partHashesTarget(file({ arionCid: "" }))).toBeNull();
    expect(partHashesTarget(file({ arionCid: "pending" }))).toBeNull();
  });

  it("prefers a search hit's server id and a browsed drive's label", () => {
    expect(
      partHashesTarget(file({ fileId: SEARCH_ID, remoteDriveLabel: "Team", label: "Other" })),
    ).toEqual({ label: "Team", pathHash: SEARCH_ID });
  });

  it("does not ask without a drive or with an id that is not a path hash", () => {
    expect(partHashesTarget(file({ label: undefined }))).toBeNull();
    expect(partHashesTarget(file({ arionHash: "Qm123" }))).toBeNull();
  });
});
