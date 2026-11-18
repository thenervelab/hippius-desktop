import { afterEach, describe, expect, it } from "vitest";

import {
  claimOsDrops,
  currentOsDropTarget,
  DROP_FIRST_FOLDER_ONLY,
  DROP_FOLDERS_SKIPPED,
  DROP_SYNC_FOLDER_FIRST,
  DROP_UNREADABLE,
  onOsDropTargetRegistered,
  osDropsClaimed,
  planClassifiedDrop,
  refusalBeforeReading,
  registerOsDropTarget,
  resolveDriveDropDestination,
  type DriveViewForDrop,
} from "../osDrop";

const view = (over: Partial<DriveViewForDrop>): DriveViewForDrop => ({
  isRecentFiles: false,
  showsDriveList: false,
  remote: null,
  local: null,
  ...over,
});

describe("where a drop on a drive view goes", () => {
  it("asks which drive on Recent Files and on the drive list", () => {
    expect(resolveDriveDropDestination(view({ isRecentFiles: true })).destination).toEqual({
      kind: "choose",
    });
    // Even with a drive remembered as active: the list is what is on screen.
    expect(
      resolveDriveDropDestination(
        view({ showsDriveList: true, local: { label: "Photos", syncPathMissing: false } }),
      ),
    ).toEqual({ destination: { kind: "choose" }, blockedReason: null });
  });

  it("goes straight to a remote drive's root or folder, without asking", () => {
    expect(
      resolveDriveDropDestination(view({ remote: { label: "Work" } })).destination,
    ).toEqual({ kind: "remote", label: "Work" });
    expect(
      resolveDriveDropDestination(
        view({ remote: { label: "shared:5Abc~f00", parentPath: "Clients/ACME" } }),
      ).destination,
    ).toEqual({ kind: "remote", label: "shared:5Abc~f00", parentPath: "Clients/ACME" });
  });

  it("goes to a local drive's root, or the folder open in it", () => {
    expect(
      resolveDriveDropDestination(view({ local: { label: "Photos", syncPathMissing: false } }))
        .destination,
    ).toEqual({ kind: "local", label: "Photos" });
    expect(
      resolveDriveDropDestination(
        view({
          local: {
            label: "Photos",
            syncPathMissing: false,
            folder: { name: "2024", subfolder: "Trips/2024", syncBasePath: "/u/Photos" },
          },
        }),
      ).destination,
    ).toEqual({
      kind: "local",
      label: "Photos",
      folder: { name: "2024", subfolder: "Trips/2024", syncBasePath: "/u/Photos" },
    });
  });

  it("refuses with a reason, never silently, when a local drive has no folder here", () => {
    expect(
      resolveDriveDropDestination(view({ local: { label: "Photos", syncPathMissing: true } })),
    ).toEqual({ destination: null, blockedReason: DROP_SYNC_FOLDER_FIRST });
    expect(resolveDriveDropDestination(view({ local: { label: null, syncPathMissing: false } })))
      .toEqual({ destination: null, blockedReason: DROP_SYNC_FOLDER_FIRST });
  });
});

describe("what a classified drop does", () => {
  it("uploads files, and says when folders in the same drop were left out", () => {
    expect(planClassifiedDrop({ files: ["/a.png"], folders: [] })).toEqual({
      action: "files",
      files: ["/a.png"],
      note: null,
    });
    expect(planClassifiedDrop({ files: ["/a.png"], folders: ["/dir"] })).toEqual({
      action: "files",
      files: ["/a.png"],
      note: DROP_FOLDERS_SKIPPED,
    });
  });

  it("uploads one folder at a time", () => {
    expect(planClassifiedDrop({ files: [], folders: ["/one"] })).toEqual({
      action: "folder",
      folder: "/one",
      note: null,
    });
    expect(planClassifiedDrop({ files: [], folders: ["/one", "/two"] })).toEqual({
      action: "folder",
      folder: "/one",
      note: DROP_FIRST_FOLDER_ONLY,
    });
  });

  it("says so when nothing dropped could be read", () => {
    expect(planClassifiedDrop({ files: [], folders: [] })).toEqual({
      action: "refuse",
      message: DROP_UNREADABLE,
    });
  });

  it("refuses a read-only drive before reading anything, then a view that cannot take drops", () => {
    expect(
      refusalBeforeReading({ destination: { kind: "choose" }, name: "Drive", writeRefusal: "Viewer" }),
    ).toBe("Viewer");
    expect(
      refusalBeforeReading({ destination: null, name: "Photos", blockedReason: "No folder" }),
    ).toBe("No folder");
    expect(refusalBeforeReading({ destination: null, name: "Photos" })).toBe(
      DROP_SYNC_FOLDER_FIRST,
    );
    expect(refusalBeforeReading({ destination: { kind: "choose" }, name: "Drive" })).toBeNull();
  });
});

describe("the view's target", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    cleanups.splice(0).forEach((fn) => fn());
  });

  it("is the latest registration that answers, and falls back when it goes", () => {
    expect(currentOsDropTarget()).toBeNull();
    cleanups.push(registerOsDropTarget(() => ({ destination: { kind: "choose" }, name: "List" })));
    const drive = registerOsDropTarget(() => ({
      destination: { kind: "remote", label: "Work" },
      name: "Work",
    }));
    expect(currentOsDropTarget()?.name).toBe("Work");
    // A registration answering null (a page whose drive is open) is passed over.
    cleanups.push(registerOsDropTarget(() => null));
    expect(currentOsDropTarget()?.name).toBe("Work");
    drive();
    expect(currentOsDropTarget()?.name).toBe("List");
  });

  it("tells listeners when a view registers (a parked tray drop waits for one)", () => {
    let told = 0;
    cleanups.push(onOsDropTargetRegistered(() => told++));
    cleanups.push(registerOsDropTarget(() => null));
    expect(told).toBe(1);
  });
});

describe("dialogs that take drops themselves", () => {
  it("hold the page's handling off until the last one closes, and release once", () => {
    expect(osDropsClaimed()).toBe(false);
    const a = claimOsDrops();
    const b = claimOsDrops();
    a();
    a();
    expect(osDropsClaimed()).toBe(true);
    b();
    expect(osDropsClaimed()).toBe(false);
  });
});
