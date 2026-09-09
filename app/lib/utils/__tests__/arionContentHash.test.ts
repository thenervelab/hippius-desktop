import { describe, expect, it } from "vitest";

import { arionContentHash, fileTrackerUrl } from "../arionContentHash";

const HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("arionContentHash", () => {
  it("returns a 64-hex digest", () => {
    expect(arionContentHash({ arionCid: HEX })).toBe(HEX);
  });

  it("returns a legacy IPFS CID", () => {
    expect(arionContentHash({ arionCid: "Qm123abc" })).toBe("Qm123abc");
  });

  it("returns null for a folder even when a cid is present", () => {
    expect(arionContentHash({ arionCid: HEX, isFolder: true })).toBeNull();
  });

  it("returns null when the cid is missing, blank, or pending", () => {
    expect(arionContentHash({})).toBeNull();
    expect(arionContentHash({ arionCid: "" })).toBeNull();
    expect(arionContentHash({ arionCid: "   " })).toBeNull();
    expect(arionContentHash({ arionCid: "pending" })).toBeNull();
    expect(arionContentHash({ arionCid: null })).toBeNull();
  });

  it("does not consult a path-id field — only arionCid", () => {
    const row = { arionCid: "", arionHash: HEX };
    expect(arionContentHash(row)).toBeNull();
  });
});

describe("fileTrackerUrl", () => {
  it("builds the Hipstats file-tracker URL from the content hash", () => {
    expect(fileTrackerUrl(HEX)).toBe(
      `https://hipstats.com/file-tracker/${HEX}`,
    );
  });
});
