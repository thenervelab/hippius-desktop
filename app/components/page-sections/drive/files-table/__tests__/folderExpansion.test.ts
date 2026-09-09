import { describe, it, expect } from "vitest";
import { canExpandFolderRow, resolveFolderExpansion } from "../folderExpansion";
import { REMOTE_SOURCE_PREFIX } from "@/app/lib/hooks/use-nested-folder-listing";

const local = {
  accountId: "5Test",
  source: "/Users/a/chains/photos",
  label: "chains",
  syncPath: "/Users/a/chains",
  relativePath: "photos",
};

const remote = {
  accountId: "5Test",
  source: `${REMOTE_SOURCE_PREFIX}Camera Uploads`,
  label: undefined,
  syncPath: null,
  relativePath: "beach day",
};

describe("resolveFolderExpansion", () => {
  it("expands a folder in a locally synced drive", () => {
    const out = resolveFolderExpansion(local);
    expect(out).toEqual({ enabled: true, label: "chains", remote: false });
  });

  // The regression: a browsed drive has no sync path, and requiring one
  // left the chevron doing nothing — no request, no error, no empty state.
  it("expands a folder in a browsed drive that has no sync path", () => {
    const out = resolveFolderExpansion(remote);
    expect(out.enabled).toBe(true);
    expect(out.remote).toBe(true);
    expect(out.label).toBe("Camera Uploads");
  });

  // Without the flag the hook lists local disk, so an enabled listing
  // would still come back empty.
  it("lists a browsed drive from the server, not local disk", () => {
    expect(resolveFolderExpansion(remote).remote).toBe(true);
    expect(resolveFolderExpansion(local).remote).toBe(false);
  });

  it("prefers the row's own label over the one in its source", () => {
    const out = resolveFolderExpansion({ ...remote, label: "explicit" });
    expect(out.label).toBe("explicit");
    expect(out.remote).toBe(true);
  });

  it("cannot expand a local folder with no root to walk", () => {
    expect(resolveFolderExpansion({ ...local, syncPath: null }).enabled).toBe(false);
  });

  it("cannot expand without an account or a path", () => {
    expect(resolveFolderExpansion({ ...remote, accountId: null }).enabled).toBe(false);
    expect(resolveFolderExpansion({ ...remote, relativePath: "" }).enabled).toBe(false);
  });

  // An empty label after the prefix names no drive to list.
  it("cannot expand a remote row whose source names no drive", () => {
    expect(
      resolveFolderExpansion({ ...remote, source: REMOTE_SOURCE_PREFIX }).enabled,
    ).toBe(false);
  });
});

describe("canExpandFolderRow", () => {
  const localRow = {
    enableFolderExpander: true,
    isFolder: true,
    source: "/Users/a/chains/photos",
    label: "chains",
    syncPath: "/Users/a/chains",
  };
  const remoteRow = {
    enableFolderExpander: true,
    isFolder: true,
    source: `${REMOTE_SOURCE_PREFIX}Camera Uploads`,
    label: undefined,
    syncPath: undefined,
  };

  it("lets a folder in a locally synced drive expand", () => {
    expect(canExpandFolderRow(localRow)).toBe(true);
  });

  // The bug: no sync path meant the chevron rendered INERT — no toggle
  // handler at all — so clicking it did nothing rather than erroring.
  it("lets a folder in a browsed drive expand despite having no sync path", () => {
    expect(canExpandFolderRow(remoteRow)).toBe(true);
  });

  it("refuses a local folder whose drive has no known root", () => {
    expect(canExpandFolderRow({ ...localRow, syncPath: undefined })).toBe(false);
  });

  it("refuses a file", () => {
    expect(canExpandFolderRow({ ...remoteRow, isFolder: false })).toBe(false);
  });

  it("respects the table-level switch", () => {
    expect(canExpandFolderRow({ ...remoteRow, enableFolderExpander: false })).toBe(false);
  });

  // The chevron and the rows it reveals must agree; two predicates is how
  // a control renders without the thing it opens.
  it("agrees with resolveFolderExpansion about a browsed drive", () => {
    expect(canExpandFolderRow(remoteRow)).toBe(true);
    expect(
      resolveFolderExpansion({
        accountId: "5Test",
        source: remoteRow.source,
        label: remoteRow.label,
        syncPath: remoteRow.syncPath,
        relativePath: "beach day",
      }).enabled,
    ).toBe(true);
  });
});
