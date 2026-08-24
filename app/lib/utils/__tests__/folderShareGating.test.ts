import { describe, expect, it } from "vitest";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  canShareFolder,
  driveFolderHash,
  folderShareRelativePath,
  shareTargetFor,
} from "@/app/lib/utils/folderShareGating";

// A folder share is a live browsable link minted from server state, so local
// settlement no longer gates it — the only FE gate is the `folder_shares`
// server capability. The path resolver exists because a nested folder row's
// name is only its basename: handing that to the IPC would silently share a
// root-level folder of the same name.

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
  it("allows any folder once the server capability is confirmed", () => {
    expect(canShareFolder(folder(), true)).toBe(true);
  });

  it("allows an unsettled or cloud-only folder — the mint is server-side", () => {
    // The zip era gated on local settlement (nothing on disk meant nothing to
    // pack); the browsable mint is one metadata POST against the server's own
    // state, so these rows are just as mintable.
    expect(canShareFolder(folder({ isAssigned: false }), true)).toBe(true);
    expect(canShareFolder(folder({ fileId: "abc", source: undefined }), true)).toBe(true);
    expect(canShareFolder(folder({ syncStatus: "pending" }), true)).toBe(true);
  });

  it("refuses every folder while the capability is absent", () => {
    expect(canShareFolder(folder(), false)).toBe(false);
  });

  it("refuses a file", () => {
    expect(canShareFolder(folder({ isFolder: false }), true)).toBe(false);
  });
});

describe("driveFolderHash", () => {
  it("matches the Rust folder_hash derivation byte-for-byte", async () => {
    // Pinned against `hcfs_client::drive::keys::folder_hash` (the first 16
    // hex chars of SHA-256 over the label) — the value the mint's drive-scoped
    // client sends as the share's `folderHash`. If this drifts, folder badges
    // silently stop matching listing rows.
    await expect(driveFolderHash("default")).resolves.toBe("37a8eec1ce19687d");
    await expect(driveFolderHash("Drive")).resolves.toBe("6312b4b9baf12770");
  });

  it("is deterministic and label-distinct", async () => {
    await expect(driveFolderHash("photos")).resolves.toBe(
      await driveFolderHash("photos"),
    );
    expect(await driveFolderHash("photos")).not.toBe(
      await driveFolderHash("documents"),
    );
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
