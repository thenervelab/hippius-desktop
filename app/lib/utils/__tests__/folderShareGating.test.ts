import { describe, expect, it } from "vitest";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  canShareFolder,
  folderShareRelativePath,
  shareTargetFor,
} from "@/app/lib/utils/folderShareGating";

// A folder share zips the folder off local disk, so the gate must only enable
// rows that really exist on THIS device and are at rest — a cloud-only row from
// another machine has nothing to pack. The path resolver exists because a
// nested folder row's name is only its basename: handing that to the IPC would
// silently share a root-level folder of the same name.

const folder = (over: Partial<FormattedUserFile> = {}): FormattedUserFile =>
  ({
    name: "Photos",
    isFolder: true,
    isAssigned: true,
    source: "/Users/me/Drive/Photos",
    createdAt: 0,
    arionHash: "",
    arionCid: "",
    minerIds: [],
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    ...over,
  }) as FormattedUserFile;

describe("canShareFolder", () => {
  it("allows a settled local folder", () => {
    expect(canShareFolder(folder())).toBe(true);
  });

  it("refuses a folder still being uploaded", () => {
    expect(canShareFolder(folder({ isAssigned: false }))).toBe(false);
  });

  it("refuses a cloud-only folder with nothing on disk", () => {
    // A search / other-device hit: carries a server fileId but no local path,
    // so there is nothing to zip.
    expect(canShareFolder(folder({ fileId: "abc", source: undefined }))).toBe(
      false,
    );
  });

  it("refuses a folder whose contents are still pending", () => {
    expect(canShareFolder(folder({ syncStatus: "pending" }))).toBe(false);
  });

  it("refuses a file", () => {
    expect(canShareFolder(folder({ isFolder: false }))).toBe(false);
  });
});

describe("folderShareRelativePath", () => {
  it("uses the name alone at the drive root", () => {
    expect(folderShareRelativePath(folder(), "")).toBe("Photos");
  });

  it("prefixes the containing folder for a nested row", () => {
    // The trap this function exists for: a nested folder row's name is only
    // the basename, so passing it straight to the IPC would target a
    // root-level "Photos" instead of "Trips/Photos".
    expect(
      folderShareRelativePath(folder({ parentRelativePath: "Trips" }), ""),
    ).toBe("Trips/Photos");
  });

  it("prefixes the table's subfolder path when the row carries no parent", () => {
    expect(folderShareRelativePath(folder(), "Trips/2024")).toBe(
      "Trips/2024/Photos",
    );
  });

  it("leaves an already-qualified name alone", () => {
    expect(
      folderShareRelativePath(folder({ actualFileName: "Trips/Photos" }), "Trips"),
    ).toBe("Trips/Photos");
  });

  it("strips stray leading and trailing slashes", () => {
    expect(folderShareRelativePath(folder({ name: "/Photos/" }), "/Trips/")).toBe(
      "Trips/Photos",
    );
  });

  it("does not collapse a subfolder named the same as its parent", () => {
    // `Trips/Trips` is common in practice (an archive that re-nests its own
    // directory, `src/src`, `test/test`). The `name === base` short-circuit
    // exists for an already-qualified path, but a folder row's name is a bare
    // basename — so without a qualification check this returns "Trips" and
    // shares the PARENT, a strict superset of what the user picked.
    expect(folderShareRelativePath(folder({ name: "Trips" }), "Trips")).toBe(
      "Trips/Trips",
    );
  });

  it("treats a null base as the drive root", () => {
    // `DriveContent` types its base as `currentSubfolderPath?: string | null`,
    // so the null reaches this function unconverted at the context-menu surface.
    expect(folderShareRelativePath(folder(), null)).toBe("Photos");
  });
});

describe("shareTargetFor", () => {
  it("takes a file's path verbatim from actualFileName", () => {
    // A file row already carries the full drive-relative path, so resolving it
    // against the base again would double the prefix.
    const file = folder({
      isFolder: false,
      name: "b.txt",
      actualFileName: "Trips/2024/b.txt",
    });

    expect(shareTargetFor(file, "Trips/2024").relativePath).toBe("Trips/2024/b.txt");
  });

  it("resolves a nested folder's path against the base", () => {
    expect(shareTargetFor(folder(), "Trips").relativePath).toBe("Trips/Photos");
  });

  it("carries the row through unchanged so the modal can render its name", () => {
    const row = folder();

    expect(shareTargetFor(row, "").file).toBe(row);
  });
});
