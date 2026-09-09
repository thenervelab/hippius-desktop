import { describe, it, expect, vi } from "vitest";
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
  // rebuild silently dropped Browse Contents and Open in <file manager>.
  // Nothing failed: the items just stopped existing. Pinned so a future
  // rebuild has to notice.
  it("keeps every action the sectioned list offered", () => {
    const items = titles(localRow());
    expect(items).toContain("Browse Contents");
    expect(items).toContain("Pause Sync");
    expect(items.some((t) => t.startsWith("Open in "))).toBe(true);
    expect(items).toContain("Excluded from Sync");
    expect(items).toContain("Delete from Server");
    expect(items).toContain("Remove from Sync");
  });

  it("offers Resume on a paused drive", () => {
    expect(titles(localRow({ status: "paused" }))).toContain("Resume Sync");
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
    expect(items).toContain("Browse Contents");
    expect(items).toContain("Delete from Server");
    // Nothing on disk to pause, exclude from, or reveal.
    expect(items).not.toContain("Pause Sync");
    expect(items).not.toContain("Excluded from Sync");
    expect(items.some((t) => t.startsWith("Open in "))).toBe(false);
  });
});

describe("buildFolderActions — unwired handlers", () => {
  // A surface that wires nothing must render an empty menu rather than
  // items that do nothing when clicked.
  it("omits an action whose handler is absent", () => {
    const items = buildFolderActions(localRow(), {}).map((i) => String(i.itemTitle));
    expect(items).not.toContain("Browse Contents");
    expect(items).not.toContain("Delete from Server");
  });
});
