// What a "Shared with me" row offers, and why each item is or is not there.
import React from "react";
import { describe, it, expect, vi } from "vitest";

import {
  buildFolderGrantActions,
  buildSharedDriveActions,
} from "../sharedDriveRowActions";
import type { DriveMembershipInfo } from "@/app/lib/tauri/sharedDrives";

const MEMBERSHIP: DriveMembershipInfo = {
  ownerSs58: "5Owner",
  folderHash: "abc123",
  displayLabel: "team-docs",
  role: "writer",
  createdAt: "",
  syncedLocally: false,
  localLabel: null,
};

const titles = (items: { itemTitle: React.ReactNode }[]) =>
  items.map((i) => String(i.itemTitle));

function build(over: Partial<Parameters<typeof buildSharedDriveActions>[0]> = {}) {
  return buildSharedDriveActions({
    membership: MEMBERSHIP,
    role: "writer",
    isSynced: false,
    busy: false,
    onOpen: vi.fn(),
    onSyncLocally: vi.fn(),
    onLeave: vi.fn(),
    ...over,
  });
}

describe("a shared-drive row's actions", () => {
  // Looking at what somebody shared is the common intent and needs no local
  // copy, so it leads.
  it("offers Open first", () => {
    expect(titles(build())[0]).toBe("Open");
  });

  it("offers syncing while there is no local copy", () => {
    expect(titles(build())).toContain("Sync to this computer");
  });

  // Syncing a drive already here would either no-op or re-install it at a new
  // path, and neither is what the word promises.
  it("drops syncing once a local copy exists", () => {
    expect(titles(build({ isSynced: true }))).not.toContain("Sync to this computer");
  });

  // Only a Manager is handed the manage handler; the item follows it, just
  // before Leave.
  it("offers Manage access only when the row may manage the drive", () => {
    const onManageAccess = vi.fn();
    const items = build({ role: "manager", onManageAccess });
    const ts = titles(items);
    expect(ts).toContain("Manage access");
    expect(ts.indexOf("Manage access")).toBe(ts.length - 2);
    items.find((i) => String(i.itemTitle) === "Manage access")?.onItemClick?.();
    expect(onManageAccess).toHaveBeenCalled();
    expect(titles(build())).not.toContain("Manage access");
  });

  it("always offers leaving, as the destructive item", () => {
    const items = build();
    const leave = items.at(-1);
    expect(String(leave?.itemTitle)).toBe("Leave drive");
    expect(leave?.variant).toBe("destructive");
  });

  // Leaving is server-side and does not need a local copy — the row that
  // lists a drive is the row that can leave it.
  it("offers leaving on a drive that was never synced here", () => {
    expect(titles(build({ isSynced: false }))).toContain("Leave drive");
  });

  // Settings has nowhere to browse to.
  it("omits Open where there is nowhere to open into", () => {
    expect(titles(build({ onOpen: undefined }))).not.toContain("Open");
  });

  it("disables syncing while another sync is in flight", () => {
    const sync = build({ busy: true }).find((i) => String(i.itemTitle).startsWith("Sync"));
    expect(sync?.disabled).toBe(true);
  });

  it("routes each item to its own handler", () => {
    const onOpen = vi.fn();
    const onSyncLocally = vi.fn();
    const onLeave = vi.fn();
    const items = build({ onOpen, onSyncLocally, onLeave });
    for (const item of items) item.onItemClick?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onSyncLocally).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

describe("a shared folder row", () => {
  it("offers Open and Leave, and never syncing to this computer", () => {
    expect(titles(buildFolderGrantActions({ onOpen: vi.fn(), onLeave: vi.fn() }))).toEqual([
      "Open",
      "Leave folder",
    ]);
    expect(titles(buildFolderGrantActions({ onLeave: vi.fn() }))).toEqual(["Leave folder"]);
  });
});
