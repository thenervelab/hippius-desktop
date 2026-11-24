import { describe, expect, it, vi } from "vitest";

import type { ActionItem } from "@/components/ui/alt-table/TableActionMenu";
import { buildFolderActions } from "@/components/page-sections/drive/folder-list/buildFolderActions";
import type { FolderRow } from "@/components/page-sections/drive/folder-list/folderRows";
import {
  buildFolderGrantActions,
  buildSharedDriveActions,
} from "@/components/page-sections/settings/multi-folder-sync/sharedDriveRowActions";
import type { DriveMembershipInfo } from "@/app/lib/tauri/sharedDrives";
import { starMenuItem, starMenuLabel, withStarItem } from "../starMenu";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const item = (title: string): ActionItem => ({ icon: null, itemTitle: title });
const titles = (items: ActionItem[]) => items.map((i) => String(i.itemTitle));

describe("withStarItem", () => {
  it("goes right after Download", () => {
    const out = withStarItem([item("Open"), item("Download"), item("View")], starMenuItem(false, () => {}));
    expect(titles(out)).toEqual(["Open", "Download", "Star", "View"]);
  });

  it("goes right after Open when there is no Download", () => {
    const out = withStarItem([item("Expand Folder"), item("Open"), item("Details")], starMenuItem(true, () => {}));
    expect(titles(out)).toEqual(["Expand Folder", "Open", "Unstar", "Details"]);
  });

  it("leads a menu with neither, and leaves a menu alone with no star", () => {
    expect(titles(withStarItem([item("Details")], starMenuItem(false, () => {})))).toEqual(["Star", "Details"]);
    expect(titles(withStarItem([item("Download")], null))).toEqual(["Download"]);
  });

  it("reads Star for an item that is not starred and Unstar for one that is", () => {
    expect(starMenuLabel(false)).toBe("Star");
    expect(starMenuLabel(true)).toBe("Unstar");
    const onToggle = vi.fn();
    starMenuItem(true, onToggle).onItemClick?.();
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe("drive menus", () => {
  const remoteRow: FolderRow = {
    id: "Photos",
    folderName: "Photos",
    presence: "not-synced-here",
    lastModified: 0,
    remote: { folderName: "Photos" } as FolderRow["remote"],
  };

  it("offers Star on a drive right after Open, and toggles that drive", () => {
    const onToggle = vi.fn();
    const items = buildFolderActions(remoteRow, {
      onOpen: () => {},
      onSyncRemote: () => {},
      star: { isStarred: () => false, onToggle },
    });
    expect(titles(items).slice(0, 3)).toEqual(["Open", "Star", "Sync to this computer"]);
    items[1].onItemClick?.();
    expect(onToggle).toHaveBeenCalledWith(remoteRow);
  });

  it("says Unstar on a starred drive, and nothing without the handler", () => {
    const starred = buildFolderActions(remoteRow, { onOpen: () => {}, star: { isStarred: () => true, onToggle: () => {} } });
    expect(titles(starred)).toContain("Unstar");
    expect(titles(buildFolderActions(remoteRow, { onOpen: () => {} }))).not.toContain("Star");
  });

  it("puts Star after Open on a drive and a folder shared with this account", () => {
    const membership = { ownerSs58: "5O", folderHash: "0123456789abcdef", displayLabel: "Team", role: "reader" } as DriveMembershipInfo;
    const drive = buildSharedDriveActions({
      membership,
      role: "reader",
      isSynced: false,
      busy: false,
      onOpen: () => {},
      onSyncLocally: () => {},
      onLeave: () => {},
      star: { starred: false, onToggle: () => {} },
    });
    expect(titles(drive).slice(0, 2)).toEqual(["Open", "Star"]);
    const folder = buildFolderGrantActions({ onOpen: () => {}, onLeave: () => {}, star: { starred: true, onToggle: () => {} } });
    expect(titles(folder)).toEqual(["Open", "Unstar", "Leave folder"]);
  });
});
