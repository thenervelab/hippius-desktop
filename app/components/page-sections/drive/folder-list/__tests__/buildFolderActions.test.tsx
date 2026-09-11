import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
import { buildFolderActions } from "../buildFolderActions";
import type { FolderRow } from "../folderRows";
import type { SyncFolder, RemoteFolder } from "@/app/lib/types/sync-folder";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const localRow = (over: Partial<SyncFolder> = {}): FolderRow => {
  const folder: SyncFolder = {
    id: "drive-1",
    folderName: "chains",
    localPath: "/Users/a/chains",
    isLocal: true,
    status: "syncing",
    ...over,
  };
  return {
    id: folder.id,
    folderName: folder.folderName,
    presence: "on-this-device",
    status: folder.status,
    lastModified: 1,
    ownerSs58: folder.ownerSs58,
    local: folder,
  };
};

const remoteRow = (): FolderRow => {
  const folder: RemoteFolder = {
    folderName: "Camera Uploads",
    deviceName: "Pixel",
    lastModified: 1,
    fileCount: 1,
    totalBytes: 1,
    origin: { kind: "otherDevice" },
  };
  return {
    id: folder.folderName,
    folderName: folder.folderName,
    presence: "other-device",
    lastModified: 1,
    remote: folder,
  };
};

/** Every handler wired, the way both real call sites wire them. */
const allHandlers = () => ({
  onOpen: vi.fn(),
  onPause: vi.fn(),
  onResume: vi.fn(),
  onManageExclusions: vi.fn(),
  onRemove: vi.fn(),
  onDeleteFromServer: vi.fn(),
  onSyncRemote: vi.fn(),
  onBrowseRemote: vi.fn(),
  onBrowseLocal: vi.fn(),
  onShareDrive: vi.fn(),
});

const titles = (row: FolderRow): string[] =>
  buildFolderActions(row, allHandlers()).map((i) => String(i.itemTitle));

describe("buildFolderActions — local rows", () => {
  // Collapsing three sections into one list rebuilt this menu, and the
  // rebuild silently dropped items. Nothing failed: they just stopped
  // existing. Pinned so a future rebuild has to notice.
  it("keeps every action the sectioned list offered", () => {
    const items = titles(localRow());
    expect(items).toContain("Pause syncing");
    expect(items.some((t) => t.startsWith("Open in "))).toBe(true);
    expect(items).toContain("Sync exclusions…");
    expect(items).toContain("Delete from Hippius");
    expect(items).toContain("Stop syncing on this device");
  });

  /**
   * "Choose what syncs…" opens the selective-sync picker, which answers
   * "which parts of this do I want on this computer?". A drive already
   * synced here has answered it — Open shows the files, and a second
   * item that sounds like "look inside" but is really a sync setting was
   * the most confusing pair in this menu.
   *
   * It stays on REMOTE rows, where the question is still open.
   */
  it("does not offer the selective-sync picker on a drive already synced here", () => {
    expect(titles(localRow())).not.toContain("Choose what syncs…");
  });

  it("offers Resume on a paused drive", () => {
    expect(titles(localRow({ status: "paused" }))).toContain("Resume syncing");
  });
});

describe("buildFolderActions — member drives", () => {
  const MEMBER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

  // The protections in folderMenuGating exist because the backend keys a
  // delete by the wrong identity for a member row. A menu rebuilt outside
  // that resolver is exactly how they come back.
  it("never offers a member row Delete from Server", () => {
    expect(titles(localRow({ ownerSs58: MEMBER }))).not.toContain("Delete from Server");
  });

  it("never offers a member row the exclusions store", () => {
    expect(titles(localRow({ ownerSs58: MEMBER }))).not.toContain("Excluded from Sync");
  });

  it("words a member row's remove as leaving", () => {
    const items = titles(localRow({ ownerSs58: MEMBER }));
    expect(items).toContain("Leave shared drive");
    expect(items).not.toContain("Remove from Sync");
  });
});

describe("buildFolderActions — remote rows", () => {
  it("offers the remote actions and none of the local ones", () => {
    const items = titles(remoteRow());
    expect(items).toContain("Sync to this computer");
    expect(items).toContain("Choose what syncs…");
    expect(items).toContain("Delete from Hippius");
    // Nothing on disk to pause, exclude from, or reveal.
    expect(items).not.toContain("Pause syncing");
    expect(items).not.toContain("Sync exclusions…");
    expect(items.some((t) => t.startsWith("Open in "))).toBe(false);
  });
});

describe("buildFolderActions — unwired handlers", () => {
  // A surface that wires nothing must render an empty menu rather than
  // items that do nothing when clicked.
  it("omits an action whose handler is absent", () => {
    const items = buildFolderActions(localRow(), {}).map((i) => String(i.itemTitle));
    expect(items).not.toContain("Choose what syncs…");
    expect(items).not.toContain("Delete from Hippius");
  });
});

/**
 * Choosing a menu item must not also count as a click on the row.
 *
 * The menu content is portalled, but React bubbles SYNTHETIC events
 * through the React tree rather than the DOM one — so the row's `onClick`
 * saw every menu click, and on the folder list that opens the drive.
 * Every action "just opened the folder": Pause ran and the navigation
 * immediately replaced the dialog it had opened.
 *
 * A source pin because the bug lives in the event plumbing, not in any
 * value these builders return.
 */
describe("a menu click stays in the menu", () => {
  const menu = readFileSync(
    join(here, "../../../../ui/alt-table/TableActionMenu.tsx"),
    "utf8",
  );

  it("stops an enabled item's click propagating", () => {
    const onClick = menu.slice(menu.indexOf("onClick={(e) => {"));
    const enabled = onClick.slice(onClick.indexOf("return false;"));
    expect(enabled.slice(0, enabled.indexOf("item.onItemClick"))).toContain(
      "e.stopPropagation()",
    );
  });

  // The row still guards on the trigger, for the click that opens the menu.
  it("the row does not treat the trigger as an open", () => {
    const list = readFileSync(join(here, "../FolderList.tsx"), "utf8");
    expect(list).toContain("action-menu-area");
  });
});

