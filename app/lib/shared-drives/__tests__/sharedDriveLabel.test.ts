import { describe, it, expect } from "vitest";
import {
  isSharedDriveLabel,
  makeSharedDriveLabel,
  parseSharedDriveLabel,
} from "../sharedDriveLabel";

const IDENTITY = { ownerSs58: "5Owner", folderHash: "abc123" };

describe("the shared-drive browse label", () => {
  it("round-trips the wire identity", () => {
    expect(parseSharedDriveLabel(makeSharedDriveLabel(IDENTITY))).toEqual(IDENTITY);
  });

  // The whole point: the identity cannot drift out of step with the label,
  // because it IS the label.
  it("treats an ordinary drive label as not shared", () => {
    for (const label of ["Documents", "", null, undefined, "shared", "remote://Docs"]) {
      expect(parseSharedDriveLabel(label)).toBeNull();
      expect(isSharedDriveLabel(label)).toBe(false);
    }
  });

  // Half an identity would let the backend fall back to this account's own
  // namespace — browsing the wrong drive rather than failing.
  it("refuses half an identity", () => {
    expect(parseSharedDriveLabel("shared://5Owner")).toBeNull();
    expect(parseSharedDriveLabel("shared://5Owner/")).toBeNull();
    expect(parseSharedDriveLabel("shared:///abc123")).toBeNull();
    expect(parseSharedDriveLabel("shared://")).toBeNull();
  });

  // Two owners may both call a drive "Documents", and so may you.
  it("distinguishes two owners' drives of the same name", () => {
    const a = makeSharedDriveLabel({ ownerSs58: "5A", folderHash: "hash-a" });
    const b = makeSharedDriveLabel({ ownerSs58: "5B", folderHash: "hash-a" });
    expect(a).not.toBe(b);
    expect(parseSharedDriveLabel(a)).not.toEqual(parseSharedDriveLabel(b));
  });

  // A folder hash is hex today, but the parser must not assume a shape the
  // server could widen — only that the two halves are separable.
  it("keeps a hash containing a slash intact", () => {
    const parsed = parseSharedDriveLabel("shared://5Owner/a/b");
    expect(parsed).toEqual({ ownerSs58: "5Owner", folderHash: "a/b" });
  });
});
