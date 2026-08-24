// Folder-share badge index: pure build/lookup coverage, plus the identity
// round-trip that makes the badge honest — a share minted through
// `shareTargetFor` (rel-path) + the drive-scoped client (folder hash) must
// be found by the badge under exactly the same `(folderHash, pathPrefix)`
// key it was created with.

import { describe, expect, it } from "vitest";

import type { FolderShareSummary } from "@/app/lib/tauri/shares";
import {
  buildFolderShareIndex,
  selectFolderSharesFor,
} from "@/app/lib/hooks/useFolderShares";
import {
  driveFolderHash,
  folderShareRelativePath,
} from "@/app/lib/utils/folderShareGating";

const NOW = Date.parse("2026-08-24T12:00:00Z");

const row = (over: Partial<FolderShareSummary> = {}): FolderShareSummary => ({
  tokenHash: "ab".repeat(32),
  folderHash: "37a8eec1ce19687d",
  pathPrefix: "Trips/Photos",
  displayName: "Photos",
  createdAt: "2026-08-20T10:00:00Z",
  expiresAt: null,
  revokedAt: null,
  resolvable: true,
  shareToken: "tok-1",
  shareUrl: "https://console.hippius.com/shared-folder/tok-1#k=K",
  isPrivate: false,
  ...over,
});

describe("buildFolderShareIndex / selectFolderSharesFor", () => {
  it("finds a live row under its (folderHash, pathPrefix) identity", () => {
    const index = buildFolderShareIndex([row()]);

    const found = selectFolderSharesFor(index, "37a8eec1ce19687d", "Trips/Photos", NOW);
    expect(found).toHaveLength(1);
    expect(found[0].shareToken).toBe("tok-1");
  });

  it("drops revoked rows at index build — a dead link must not badge", () => {
    const index = buildFolderShareIndex([
      row({ revokedAt: "2026-08-21T10:00:00Z" }),
    ]);

    expect(selectFolderSharesFor(index, "37a8eec1ce19687d", "Trips/Photos", NOW)).toEqual([]);
  });

  it("filters expired rows at lookup time, not build time", () => {
    // Expiry is clock-dependent and the index is cached, so the same index
    // must answer differently before and after the expiry moment.
    const index = buildFolderShareIndex([
      row({ expiresAt: "2026-08-24T11:00:00Z" }),
    ]);

    const before = Date.parse("2026-08-24T10:00:00Z");
    expect(selectFolderSharesFor(index, "37a8eec1ce19687d", "Trips/Photos", before)).toHaveLength(1);
    expect(selectFolderSharesFor(index, "37a8eec1ce19687d", "Trips/Photos", NOW)).toEqual([]);
  });

  it("a whole-drive share does not badge subfolders", () => {
    // `""` shares the whole drive; badging every folder underneath would
    // claim shares the user never minted. Exact-key match only.
    const index = buildFolderShareIndex([row({ pathPrefix: "" })]);

    expect(selectFolderSharesFor(index, "37a8eec1ce19687d", "", NOW)).toHaveLength(1);
    expect(selectFolderSharesFor(index, "37a8eec1ce19687d", "Trips/Photos", NOW)).toEqual([]);
  });

  it("returns nothing without a folder hash (hash still resolving)", () => {
    const index = buildFolderShareIndex([row()]);

    expect(selectFolderSharesFor(index, undefined, "Trips/Photos", NOW)).toEqual([]);
  });

  it("round-trips the mint's identity derivation", async () => {
    // Mint side: `shareTargetFor` resolves the rel-path a nested folder row
    // mints with, and the Rust client sends `folder_hash(label)`. Badge side:
    // the SAME `folderShareRelativePath` + `driveFolderHash` build the lookup
    // key. If either half drifts, this fails.
    const label = "Drive";
    const relativePath = folderShareRelativePath({ name: "Photos" }, "Trips");
    const folderHash = await driveFolderHash(label);

    const index = buildFolderShareIndex([
      row({ folderHash, pathPrefix: relativePath }),
    ]);

    const found = selectFolderSharesFor(
      index,
      await driveFolderHash(label),
      folderShareRelativePath({ name: "Photos" }, "Trips"),
      NOW,
    );
    expect(found).toHaveLength(1);
  });
});
