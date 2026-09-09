import { describe, it, expect } from "vitest";
import { resolveFolderExpansion } from "../folderExpansion";
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
