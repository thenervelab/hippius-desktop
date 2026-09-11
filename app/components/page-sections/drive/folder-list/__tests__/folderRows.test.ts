import { describe, it, expect } from "vitest";
import {
  isCloudOnly,
  presenceLabel,
  toFolderRows,
  type FolderPresence,
} from "../folderRows";
import type { RemoteFolder, SyncFolder } from "@/app/lib/types/sync-folder";

const local = (over: Partial<SyncFolder> = {}): SyncFolder => ({
  id: "local-1",
  folderName: "Documents",
  localPath: "/Users/a/Documents",
  isLocal: true,
  status: "syncing",
  lastModified: 100,
  ...over,
});

const remote = (over: Partial<RemoteFolder> = {}): RemoteFolder => ({
  folderName: "Camera Uploads",
  deviceName: "Pixel",
  lastModified: 50,
  fileCount: 7,
  totalBytes: 1024,
  origin: { kind: "otherDevice" },
  ...over,
});

describe("toFolderRows", () => {
  it("returns one list, not three", () => {
    const rows = toFolderRows(
      [local()],
      [remote(), remote({ folderName: "Archive", origin: { kind: "locallyRemoved" } })],
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.folderName).sort()).toEqual([
      "Archive",
      "Camera Uploads",
      "Documents",
    ]);
  });

  // The three headings are gone, so the distinction has to survive on the
  // row or a laptop user cannot tell what is using local disk.
  it("keeps each folder's presence on the row", () => {
    const rows = toFolderRows(
      [local()],
      [
        remote({ folderName: "FromPhone", origin: { kind: "otherDevice" } }),
        remote({ folderName: "Old", origin: { kind: "locallyRemoved" } }),
      ],
    );
    const byName = Object.fromEntries(rows.map((r) => [r.folderName, r.presence]));
    expect(byName).toEqual({
      Documents: "on-this-device",
      FromPhone: "other-device",
      Old: "not-synced-here",
    });
  });

  // The remote list is the server's view of this device and can lag a
  // just-added folder. Two rows for one folder in a flat list is worse
  // than in two sections, where the reader could see why.
  it("shows a folder once when both sources report it, keeping the local row", () => {
    const rows = toFolderRows([local({ folderName: "Shared" })], [remote({ folderName: "Shared" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].presence).toBe("on-this-device");
    // The local row is the capable one — pause, exclusions, offline open.
    expect(rows[0].local).toBeDefined();
  });

  it("sorts most-recently-changed first", () => {
    const rows = toFolderRows(
      [local({ folderName: "Old", lastModified: 1 })],
      [remote({ folderName: "New", lastModified: 900 })],
    );
    expect(rows.map((r) => r.folderName)).toEqual(["New", "Old"]);
  });

  // Equal timestamps must not reshuffle between renders.
  it("breaks ties by name so the order is stable", () => {
    const rows = toFolderRows(
      [],
      [remote({ folderName: "Zebra", lastModified: 5 }), remote({ folderName: "Alpha", lastModified: 5 })],
    );
    expect(rows.map((r) => r.folderName)).toEqual(["Alpha", "Zebra"]);
  });

  it("falls back to lastSynced when a local row has no lastModified", () => {
    const rows = toFolderRows([local({ lastModified: undefined, lastSynced: 42 })], []);
    expect(rows[0].lastModified).toBe(42);
  });

  it("handles both sources being empty", () => {
    expect(toFolderRows([], [])).toEqual([]);
  });
});

describe("presence presentation", () => {
  // The cloud mark is the whole point of merging the sections: it is what
  // tells a folder that lives elsewhere from one taking local disk.
  it("marks everything not on this computer as cloud-only", () => {
    expect(isCloudOnly("on-this-device")).toBe(false);
    expect(isCloudOnly("other-device")).toBe(true);
    expect(isCloudOnly("not-synced-here")).toBe(true);
  });

  it("names the device that has the folder when it knows it", () => {
    expect(presenceLabel({ presence: "other-device", deviceName: "Pixel" })).toBe("On Pixel");
    expect(presenceLabel({ presence: "other-device" })).toBe("On another device");
  });

  it("labels every presence from the user's point of view", () => {
    const cases: FolderPresence[] = ["on-this-device", "other-device", "not-synced-here"];
    for (const presence of cases) {
      const label = presenceLabel({ presence, deviceName: "Mac" });
      expect(label).not.toBe("");
      // No system vocabulary — these replace headings a user read.
      expect(label.toLowerCase()).not.toContain("sync_path");
      expect(label.toLowerCase()).not.toContain("origin");
    }
  });
});
