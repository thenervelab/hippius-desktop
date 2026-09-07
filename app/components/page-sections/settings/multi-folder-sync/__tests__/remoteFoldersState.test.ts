import { describe, it, expect } from "vitest";

import type { RemoteFolder } from "@/app/lib/types/sync-folder";
import {
  partitionRemoteFolders,
  remoteFolderSectionVisibility,
} from "../remoteFoldersState";

function folder(overrides: Partial<RemoteFolder>): RemoteFolder {
  return {
    folderName: "docs",
    deviceName: "Georges-MacBook",
    lastModified: 1,
    fileCount: 1,
    totalBytes: 10,
    ...overrides,
  };
}

describe("partitionRemoteFolders", () => {
  it("buckets a matching-device remote as locallyRemoved and a different device as otherDevice", () => {
    const removed = folder({
      folderName: "was-here",
      origin: { kind: "locallyRemoved" },
    });
    const other = folder({
      folderName: "office",
      deviceName: "Office PC",
      origin: { kind: "otherDevice" },
    });
    expect(partitionRemoteFolders([removed, other])).toEqual({
      locallyRemoved: [removed],
      otherDevice: [other],
    });
  });

  it("fails closed to otherDevice when origin is missing so a FE comparison cannot reintroduce H-077", () => {
    const untagged = folder({ folderName: "legacy", origin: undefined });
    expect(partitionRemoteFolders([untagged])).toEqual({
      locallyRemoved: [],
      otherDevice: [untagged],
    });
  });
});

describe("remoteFolderSectionVisibility", () => {
  it("shows only the other-devices skeleton while loading", () => {
    expect(remoteFolderSectionVisibility(true, 2, 1)).toEqual({
      otherDevice: true,
      locallyRemoved: false,
    });
  });

  it("hides the empty other-devices card when locally-removed rows exist", () => {
    expect(remoteFolderSectionVisibility(false, 1, 0)).toEqual({
      otherDevice: false,
      locallyRemoved: true,
    });
  });

  it("keeps the original empty other-devices card when nothing remote is listed", () => {
    expect(remoteFolderSectionVisibility(false, 0, 0)).toEqual({
      otherDevice: true,
      locallyRemoved: false,
    });
  });

  it("shows both cards when both buckets have rows", () => {
    expect(remoteFolderSectionVisibility(false, 1, 1)).toEqual({
      otherDevice: true,
      locallyRemoved: true,
    });
  });
});
