import { describe, it, expect } from "vitest";
import {
  isFolderGrantLabel,
  isSharedDriveLabel,
  makeFolderGrantLabel,
  makeSharedDriveLabel,
  parseFolderGrantLabel,
  parseSharedDriveLabel,
  sharedDriveTargetArgs,
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
    expect(parseSharedDriveLabel("shared:5Owner")).toBeNull();
    expect(parseSharedDriveLabel("shared:5Owner~")).toBeNull();
    expect(parseSharedDriveLabel("shared:~abc123")).toBeNull();
    expect(parseSharedDriveLabel("shared:")).toBeNull();
  });

  // Two owners may both call a drive "Documents", and so may you.
  it("distinguishes two owners' drives of the same name", () => {
    const a = makeSharedDriveLabel({ ownerSs58: "5A", folderHash: "hash-a" });
    const b = makeSharedDriveLabel({ ownerSs58: "5B", folderHash: "hash-a" });
    expect(a).not.toBe(b);
    expect(parseSharedDriveLabel(a)).not.toEqual(parseSharedDriveLabel(b));
  });

  // The label is carried in a URL parameter and joined into folder paths by
  // machinery that splits on "/". A slash in it broke navigation into a
  // shared drive, which silently dropped uploads into the LOCAL flow.
  it("never contains a slash", () => {
    expect(makeSharedDriveLabel(IDENTITY)).not.toContain("/");
  });

  it("survives a URL round trip unchanged", () => {
    const label = makeSharedDriveLabel(IDENTITY);
    expect(decodeURIComponent(encodeURIComponent(label))).toBe(label);
    // And as a path segment, which is where the slashes did the damage.
    expect(`remote://${label}`.split("/").length).toBe(3);
  });
});

// Every drive-scoped IPC on a browsed shared drive takes its identity from
// the label. One helper, so a new call site cannot pass half an identity,
// which both sides refuse rather than falling back to this account's own
// namespace.
describe("sharedDriveTargetArgs", () => {
  it("names the owner's drive for a browse label", () => {
    expect(sharedDriveTargetArgs(makeSharedDriveLabel(IDENTITY))).toEqual({
      ownerSs58: "5Owner",
      folderHash: "abc123",
    });
  });

  // An ordinary drive resolves by label; naming an identity would address
  // somebody else's namespace.
  it.each(["Documents", "", null, undefined])("names nobody for %s", (label) => {
    expect(sharedDriveTargetArgs(label)).toEqual({
      ownerSs58: null,
      folderHash: null,
    });
  });

  // Nulls, never undefined: the backend distinguishes "absent" from "half
  // an identity", and an undefined key can drop out of an IPC payload.
  it("sends nulls rather than dropping the keys", () => {
    const args = sharedDriveTargetArgs("Documents");
    expect(Object.keys(args).sort()).toEqual(["folderHash", "ownerSs58"]);
    expect(args.ownerSs58).toBeNull();
  });
});

describe("the folder grant browse label", () => {
  const GRANT = { ...IDENTITY, pathPrefix: "Clients/ACME é" };

  it("round-trips the drive and the folder, with no slash in the label", () => {
    const label = makeFolderGrantLabel(GRANT);
    expect(label).not.toContain("/");
    expect(parseFolderGrantLabel(label)).toEqual(GRANT);
    expect(isFolderGrantLabel(label)).toBe(true);
  });

  it("matches the hex Rust decodes", () => {
    // hex("Clients/ACME") computed independently.
    expect(makeFolderGrantLabel({ ...IDENTITY, pathPrefix: "/Clients/ACME/" })).toBe(
      "grant:5Owner~abc123~436c69656e74732f41434d45",
    );
  });

  it("addresses the owner's drive for every drive-scoped call", () => {
    const label = makeFolderGrantLabel(GRANT);
    expect(parseSharedDriveLabel(label)).toEqual(IDENTITY);
    expect(isSharedDriveLabel(label)).toBe(true);
    expect(sharedDriveTargetArgs(label)).toEqual(IDENTITY);
  });

  it("never guesses at a broken label", () => {
    for (const label of [
      "grant:5Owner~abc123",
      "grant:5Owner~abc123~zz",
      "grant:5Owner~abc123~2e2e", // ".."
      "grant:~abc123~61",
      "grant:5Owner~abc123~61~62",
      makeSharedDriveLabel(IDENTITY),
    ]) {
      expect(parseFolderGrantLabel(label)).toBeNull();
    }
  });
});
