import { describe, it, expect } from "vitest";
import type { UploadFeedItem } from "@/app/lib/upload-feed/mergeUploadFeed";
import {
  canLinkTrayRow,
  cloudFileIdFor,
  getTrayQuickActions,
  getTrayRowActions,
  parseTrayFileActionRequest,
  runsInMainWindow,
  trayDriveLocation,
} from "../trayRowActions";
import { RENAME_DISABLED_TOOLTIP } from "@/app/lib/utils/renameGating";

/** A completed server row of a drive synced on this computer, on disk. */
function row(overrides: Partial<UploadFeedItem> = {}): UploadFeedItem {
  return {
    name: "report.pdf",
    actualFileName: "Work/report.pdf",
    size: 1024,
    createdAt: 1,
    arionHash: "path-id",
    arionCid: "content-hash",
    fileId: "ab".repeat(32),
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    source: "/Users/me/Docs/Work/report.pdf",
    syncStatus: "synced",
    label: "Docs",
    feedStatus: "completed",
    ...overrides,
  };
}

const ids = (item: UploadFeedItem) =>
  getTrayRowActions(item, "Finder").map((a) => a.id);

describe("tray row menu, per file state", () => {
  it("offers a local, synced file everything the Drive menu offers", () => {
    expect(ids(row())).toEqual([
      "preview",
      "download",
      "copy-link",
      "share",
      "show-in-drive",
      "reveal",
      "rename",
      "delete",
    ]);
    const labels = getTrayRowActions(row(), "Finder").map((a) => a.label);
    expect(labels).toContain("Reveal in Finder");
    expect(labels).toContain("Show in Hippius");
  });

  it("keeps a cloud-only file's link and download but nothing that needs a local copy", () => {
    // A drive not synced here: the server row carries no local source.
    const cloud = row({ source: "", label: "Photos" });
    const got = ids(cloud);
    expect(got).toEqual(
      expect.arrayContaining(["preview", "download", "copy-link", "share", "show-in-drive"]),
    );
    expect(got).not.toContain("reveal");
    expect(got).not.toContain("delete");
    // Rename is shown but disabled, with the Drive's own reason.
    const rename = getTrayRowActions(cloud, "Finder").find((a) => a.id === "rename");
    expect(rename).toMatchObject({ disabled: true, tooltip: RENAME_DISABLED_TOOLTIP });
    expect(cloudFileIdFor(cloud)).toBe(cloud.fileId);
  });

  it("does not offer a link for a file still waiting to download here", () => {
    // Same gate as the Drive's "Share via link": the row must be synced.
    const pending = row({ syncStatus: "pending" });
    expect(canLinkTrayRow(pending)).toBe(false);
    expect(ids(pending)).not.toContain("copy-link");
    expect(ids(pending)).not.toContain("reveal");
  });

  it("shares a file on disk from disk, not by its server id", () => {
    expect(cloudFileIdFor(row())).toBeNull();
  });

  it("offers an uploading or failed row only where the file is", () => {
    const live = row({
      feedStatus: "uploading",
      syncStatus: "uploading",
      source: "",
      fileId: undefined,
      arionCid: "",
      isAssigned: false,
    });
    expect(ids(live)).toEqual(["show-in-drive", "reveal"]);
    expect(ids({ ...live, feedStatus: "failed", syncStatus: "failed" })).toEqual([
      "show-in-drive",
      "reveal",
    ]);
  });

  it("does not offer View for a file the viewer cannot open", () => {
    const zip = row({ name: "backup.zip", actualFileName: "backup.zip" });
    expect(ids(zip)).not.toContain("preview");
    expect(getTrayQuickActions(zip)).toEqual(["show-in-drive", "copy-link"]);
  });

  it("disables Delete while the file is still being assigned", () => {
    const syncing = row({ isAssigned: false });
    expect(getTrayRowActions(syncing, "Finder").find((a) => a.id === "delete")).toMatchObject({
      disabled: true,
      destructive: true,
    });
  });

  it("offers nothing that needs a drive when the row has none", () => {
    expect(ids(row({ label: undefined, source: "", fileId: undefined }))).toEqual([
      "preview",
    ]);
  });
});

describe("tray row quick actions", () => {
  it("are folder, link and view for a previewable completed file", () => {
    expect(getTrayQuickActions(row())).toEqual(["show-in-drive", "copy-link", "preview"]);
  });

  it("are only the folder while a file uploads", () => {
    expect(getTrayQuickActions(row({ feedStatus: "uploading", syncStatus: "uploading" }))).toEqual([
      "show-in-drive",
    ]);
  });
});

describe("Show in Hippius location", () => {
  it("opens the folder the file is in and points at the file", () => {
    expect(trayDriveLocation(row())).toEqual({
      label: "Docs",
      remote: false,
      subfolder: "Work",
      fileName: "report.pdf",
    });
  });

  it("opens a drive not synced here as a remote drive", () => {
    expect(trayDriveLocation(row({ source: "", actualFileName: "/a.png", name: "a.png" }))).toEqual({
      label: "Docs",
      remote: true,
      subfolder: undefined,
      fileName: "a.png",
    });
  });

  it("treats a live upload as a drive synced here", () => {
    expect(trayDriveLocation(row({ source: "", fileId: undefined }))?.remote).toBe(false);
  });
});

describe("cross-window request", () => {
  it("routes dialogs and routes to the main window, and runs reveal and link here", () => {
    expect(runsInMainWindow("share")).toBe(true);
    expect(runsInMainWindow("delete")).toBe(true);
    expect(runsInMainWindow("copy-link")).toBe(false);
    expect(runsInMainWindow("reveal")).toBe(false);
  });

  it("accepts a well-formed request and drops anything else", () => {
    const file = row();
    expect(parseTrayFileActionRequest({ action: "rename", file })).toEqual({ action: "rename", file });
    expect(parseTrayFileActionRequest({ action: "reveal", file })).toBeNull();
    expect(parseTrayFileActionRequest({ action: "rename", file: { name: "" } })).toBeNull();
    expect(parseTrayFileActionRequest({ action: "rename" })).toBeNull();
    expect(parseTrayFileActionRequest(null)).toBeNull();
    expect(parseTrayFileActionRequest("rename")).toBeNull();
  });
});
