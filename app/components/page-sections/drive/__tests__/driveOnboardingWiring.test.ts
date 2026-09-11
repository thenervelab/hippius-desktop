import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(join(here, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const container = read("../DriveContainer.tsx");
const onboarding = read("../DriveOnboarding.tsx");

/**
 * The folder list renders from three branches of `DriveContainer`, and two
 * of them passed `onOpenRemoteFolder` but not `onSelectFolder`. A LOCAL row
 * — which is what a shared (member) drive is — then called `undefined?.()`
 * on click: no navigation, no error, nothing in the console.
 *
 * It was invisible because remote rows in the same list still worked, so
 * the page looked alive while half its rows were dead.
 */
describe("every folder-list branch can open every row", () => {
  const sites = container.match(/<DriveOnboarding[\s\S]*?\/>/g) ?? [];

  it("renders the list from more than one branch", () => {
    expect(sites.length).toBeGreaterThan(1);
  });

  it.each(sites.map((site, i) => [i, site] as const))(
    "branch %i opens a local row",
    (_i, site) => {
      expect(site).toContain("onSelectFolder=");
    },
  );

  it.each(sites.map((site, i) => [i, site] as const))(
    "branch %i opens a remote row",
    (_i, site) => {
      expect(site).toContain("onOpenRemoteFolder=");
    },
  );
});

/**
 * `isSyncPathConfigured` only tracks whether a PRIVATE sync path is
 * selected, so an account whose drives are all shared or browsed sits on
 * the onboarding branch permanently. Opening a drive there re-rendered the
 * same branch — the second half of the dead click, and the reason passing
 * the handler alone would not have been enough.
 */
describe("an opened drive wins over the onboarding screens", () => {
  it("has a local counterpart to the remote-root guard", () => {
    expect(container).toContain("isLocalDriveOpen");
    // Both guards must be on the no-sync-path branch, or one kind of drive
    // is still stranded behind the cards.
    const branch = container.slice(
      container.indexOf("isSyncPathConfigured === false"),
      container.indexOf("<DriveOnboarding"),
    );
    expect(branch).toContain("!isRemoteRoot");
    expect(branch).toContain("!isLocalDriveOpen");
  });

  // The Start Syncing selector is answered by picking a drive, so it must
  // stand down rather than re-render over the drive that was just opened.
  it("closes the start-syncing selector when a drive is opened", () => {
    const handler = container.slice(
      container.indexOf("const handleSelectFolderFromCards"),
      container.indexOf("const handleSelectRemoteFolderFromCards"),
    );
    expect(handler).toContain("setShowPrivateStartSyncingSelector(false)");
  });
});

/**
 * A row is either local or remote; the opener must handle both or one kind
 * silently does nothing.
 */
describe("the row opener covers both row shapes", () => {
  const opener = onboarding.slice(
    onboarding.indexOf("const handleOpenRow"),
    onboarding.indexOf("const buildRowActions"),
  );

  it("opens a local row", () => {
    expect(opener).toContain("row.local");
    expect(opener).toContain("onSelectFolder");
  });

  it("opens a remote row", () => {
    expect(opener).toContain("row.remote");
    expect(opener).toContain("onOpenRemoteFolder");
  });
});

/**
 * A browsed drive has no local sync root, so the local upload handlers are
 * withheld from that view — which left its right-click menu with nothing
 * but New Folder. Its uploads go straight to the server instead, through
 * the same actions the remote toolbar buttons run.
 */
describe("a browsed drive can upload from the menu", () => {
  const content = read("../DriveContent.tsx");

  it("registers the remote upload actions", () => {
    expect(content).toContain("useRemoteFileUpload");
    expect(content).toContain("useRemoteFolderUpload");
  });

  it("uses them in place of the local handlers when the drive is remote", () => {
    expect(content).toMatch(/onUploadFile:\s*remoteTarget\s*\?/);
    expect(content).toMatch(/onUploadFolder:\s*remoteTarget\s*\?/);
  });

  // One implementation, so the menu and the toolbar button cannot diverge
  // on the plan gate or the progress reporting.
  it.each([
    ["../RemoteUploadButton.tsx", "useRemoteFileUpload"],
    ["../RemoteFolderUploadButton.tsx", "useRemoteFolderUpload"],
  ])("%s runs the same action as the menu", (path, hook) => {
    const button = read(path);
    expect(button).toContain(hook);
    // The pick/upload sequence moved to the hook; a copy here is the drift.
    expect(button).not.toContain("openSelection");
  });
});

/**
 * "Sync a Folder" registers a NEW drive. Offered inside one, it answers a
 * question the user is no longer asking and reads as doing something to
 * the folder they are looking at.
 */
describe("Sync a Folder is offered only where drives are chosen", () => {
  it("is withheld inside a drive", () => {
    expect(read("../DriveContent.tsx")).toMatch(
      /onSyncFolder:\s*isRecentFiles\s*\?\s*onAddSyncFolder\s*:\s*undefined/,
    );
  });

  // The drive list is where a drive is added, so it keeps the item.
  it("is kept on the drive list", () => {
    expect(read("../DriveOnboarding.tsx")).toContain("onSyncFolder:");
  });
});

/**
 * "Sync a Folder" opens a folder picker. Sending the user to Settings
 * answered the request by handing them a different screen and losing the
 * one they were on — and the Drive page had always opened the dialog in
 * place, so the same item behaved two ways.
 */
describe("Sync a Folder opens the picker, not Settings", () => {
  const container = read("../DriveContainer.tsx");

  it("opens the dialog from the menu handler", () => {
    const handler = container.slice(
      container.indexOf("const handleContextAddSyncFolder"),
      container.indexOf("const handleContextAddSyncFolder") + 260,
    );
    expect(handler).toContain("setShowSyncFolderDialog(true)");
    expect(handler).not.toContain("router.push");
  });

  it("mounts the same picker the Drive page uses", () => {
    expect(container).toContain("AddLocalFolderDialog");
    expect(read("../DriveOnboarding.tsx")).toContain("AddLocalFolderDialog");
  });
});

