import { describe, expect, it } from "vitest";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { isCloudOnlyRow } from "../cloudOnly";
import {
  REMOTE_SOURCE_PREFIX,
  remoteLabelFromSource,
} from "@/app/lib/hooks/use-nested-folder-listing";

const base: FormattedUserFile = {
  name: "a.jpg",
  actualFileName: "a.jpg",
  size: 1,
  createdAt: 0,
  arionHash: "",
  arionCid: "",
  minerIds: [],
  isAssigned: true,
  lastChargedAt: 0,
  type: "private",
  isErasureCoded: false,
  mainReqHash: "",
};

describe("isCloudOnlyRow", () => {
  it("plain local rows (source, no fileId) are NOT cloud-only", () => {
    expect(isCloudOnlyRow({ ...base, source: "/Users/me/Drive/a.jpg" })).toBe(false);
  });

  it("cloud search/browse hits (fileId, no source) are cloud-only", () => {
    expect(isCloudOnlyRow({ ...base, fileId: "abc" })).toBe(true);
  });

  it("pending downloads are cloud-only even though they carry a would-be source path", () => {
    // The search mapper gives `pending` hits the local path the file WILL
    // have — the bytes aren't down yet, so disk-backed actions must hide
    // and share/download must take the remote pipeline.
    expect(
      isCloudOnlyRow({
        ...base,
        fileId: "abc",
        source: "/Users/me/Drive/a.jpg",
        syncStatus: "pending",
      }),
    ).toBe(true);
  });

  it("remote-drive FOLDER rows (remote:// sentinel source, no fileId) are cloud-only", () => {
    expect(
      isCloudOnlyRow({
        ...base,
        isFolder: true,
        source: `${REMOTE_SOURCE_PREFIX}Camera Uploads`,
      }),
    ).toBe(true);
  });

  it("a synced row with both fileId and a real source is NOT cloud-only", () => {
    expect(
      isCloudOnlyRow({
        ...base,
        fileId: "abc",
        source: "/Users/me/Drive/a.jpg",
        syncStatus: "synced",
      }),
    ).toBe(false);
  });
});

describe("remoteLabelFromSource", () => {
  it("extracts the label from the sentinel and rejects everything else", () => {
    expect(remoteLabelFromSource(`${REMOTE_SOURCE_PREFIX}Camera Uploads`)).toBe("Camera Uploads");
    expect(remoteLabelFromSource(REMOTE_SOURCE_PREFIX)).toBeNull(); // empty label
    expect(remoteLabelFromSource("/Users/me/Drive")).toBeNull();
    expect(remoteLabelFromSource(undefined)).toBeNull();
    expect(remoteLabelFromSource(null)).toBeNull();
  });
});
