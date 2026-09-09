import { describe, it, expect } from "vitest";
import {
  resolveUploadAction,
  ADD_FILE_LABEL,
  ADD_FOLDER_LABEL,
  SYNC_FOLDER_LABEL,
  type UploadActionGates,
} from "../uploadActions";

const gates = (over: Partial<UploadActionGates> = {}): UploadActionGates => ({
  hideUploads: false,
  isRecentFiles: false,
  hasNoSyncPaths: false,
  isSyncPathEmpty: false,
  ...over,
});

describe("resolveUploadAction", () => {
  it("offers both actions on a normal drive", () => {
    expect(resolveUploadAction(gates())).toBe("enabled");
  });

  // A server-only view has no local folder to drop into, so an upload
  // would land somewhere else. Hidden beats disabled here: there is
  // nothing the user could do to make it work from this screen.
  it("hides the actions on a remote view", () => {
    expect(resolveUploadAction(gates({ hideUploads: true }))).toBe("hidden");
  });

  it("disables them on Recent Files with nothing configured yet", () => {
    expect(
      resolveUploadAction(gates({ isRecentFiles: true, hasNoSyncPaths: true })),
    ).toBe("disabled");
  });

  it("hides them when the active drive has no sync path", () => {
    expect(resolveUploadAction(gates({ isSyncPathEmpty: true }))).toBe("hidden");
  });

  // The regression this resolver exists to prevent. The file button keyed
  // off `hideUploads` first; the folder button's disabled fallback did not
  // consult it at all, so this combination rendered a dead folder button
  // next to no file button.
  it("hides BOTH actions when a remote view also has no sync paths", () => {
    const remoteRecent = gates({
      hideUploads: true,
      isRecentFiles: true,
      hasNoSyncPaths: true,
    });
    expect(resolveUploadAction(remoteRecent)).toBe("hidden");
  });

  it("treats hideUploads as the strongest gate", () => {
    // Whatever else is true, a view that cannot accept uploads offers none.
    for (const over of [
      { isRecentFiles: true },
      { isSyncPathEmpty: true },
      { hasNoSyncPaths: true },
      { isRecentFiles: true, hasNoSyncPaths: true, isSyncPathEmpty: true },
    ]) {
      expect(resolveUploadAction(gates({ ...over, hideUploads: true }))).toBe("hidden");
    }
  });
});

describe("upload action labels", () => {
  // Neither action creates anything — both add something that already
  // exists on disk. "New Folder" claimed a feature the app does not have.
  it("names both actions as adding, never creating", () => {
    expect(ADD_FILE_LABEL).toBe("Add File");
    expect(ADD_FOLDER_LABEL).toBe("Add Folder");
    expect(ADD_FOLDER_LABEL).not.toMatch(/new/i);
  });

  it("keeps sync-folder setup worded apart from the add actions", () => {
    expect(SYNC_FOLDER_LABEL).not.toContain("Add");
    expect(SYNC_FOLDER_LABEL).not.toBe(ADD_FOLDER_LABEL);
  });
});
