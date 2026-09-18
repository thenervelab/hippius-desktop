import { describe, it, expect } from "vitest";
import {
  resolveUploadAction,
  UPLOAD_FILE_LABEL,
  UPLOAD_FOLDER_LABEL,
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
  // Neither action creates anything — both send something that already
  // exists on disk. "New Folder" claimed a feature the app does not have.
  it("names both actions as uploads", () => {
    expect(UPLOAD_FILE_LABEL).toBe("Upload File");
    expect(UPLOAD_FOLDER_LABEL).toBe("Upload Folder");
  });

  it("keeps sync-folder setup worded apart from the uploads", () => {
    expect(SYNC_FOLDER_LABEL).not.toContain("Upload");
    expect(SYNC_FOLDER_LABEL).not.toBe(UPLOAD_FOLDER_LABEL);
  });
});

// A Viewer on somebody else's drive may not add to it. Offering the button
// anyway moves the server's refusal to a sync error far from the click.
describe("a drive the viewer may only read", () => {
  it("hides the upload affordance outright", () => {
    expect(
      resolveUploadAction({
        hideUploads: false,
        isRecentFiles: false,
        hasNoSyncPaths: false,
        isSyncPathEmpty: false,
        isReadOnlyDrive: true,
      }),
    ).toBe("hidden");
  });

  // Hidden, never disabled: a disabled button says "not now", where the
  // truthful statement is that this drive is not theirs to add to.
  it("never merely disables it", () => {
    expect(
      resolveUploadAction({
        hideUploads: false,
        isRecentFiles: true,
        hasNoSyncPaths: true,
        isSyncPathEmpty: false,
        isReadOnlyDrive: true,
      }),
    ).toBe("hidden");
  });

  // Own drives are the overwhelming case and must be unaffected.
  it("leaves a writable drive alone", () => {
    expect(
      resolveUploadAction({
        hideUploads: false,
        isRecentFiles: false,
        hasNoSyncPaths: false,
        isSyncPathEmpty: false,
        isReadOnlyDrive: false,
      }),
    ).toBe("enabled");
  });
});
