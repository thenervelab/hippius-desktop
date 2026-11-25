import { describe, expect, it } from "vitest";

import {
  driveRootHref,
  driveTrail,
  initialDriveView,
  isDriveOpenInUrl,
  isInsidePinnedFolder,
  isPinnedRoot,
  pinnedFolderHref,
  trailFromPinnedFolder,
  urlAfterOpen,
} from "../driveTrail";
import { generateFolderUrl } from "@/app/utils/folderUrlUtils";
import { isNestedFolderView } from "@/app/lib/utils/filesViewMode";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { DRIVE_PAGE_ROUTE } from "../driveRoute";
import { SHARED_DRIVES_DRIVE_ROUTE } from "../../shared-drives/SharedDriveOpenView";
import { sharedDrivesDriveRoute } from "@/app/lib/routes";

const SHARED = "shared:5Owner~abc123";
const DRIVE = { label: SHARED, remote: true, name: "Design team" };

// What the page reads: a getter over a URL's query, as `useUrlParams` gives.
const paramsOf = (href: string) => {
  const params = new URL(`app://x${href}`).searchParams;
  return (key: string) => params.get(key);
};

describe("the trail inside a drive", () => {
  it("is the drive alone at its root, and the drive is where you are", () => {
    expect(
      driveTrail({ drive: DRIVE, nested: false, subFolderPath: null, mainFolderActualName: null }),
    ).toEqual([{ label: "Design team", target: null }]);
  });

  // Each crumb goes to its own level; only the last is the current one.
  it("names every level down to the folder on screen, each a way back to it", () => {
    expect(
      driveTrail({
        drive: DRIVE,
        nested: true,
        subFolderPath: "Clients/ACME/2024",
        mainFolderActualName: "Clients",
      }),
    ).toEqual([
      { label: "Design team", target: { kind: "drive", label: SHARED, remote: true } },
      { label: "Clients", target: { kind: "folder", name: "Clients", subPath: "Clients" } },
      { label: "ACME", target: { kind: "folder", name: "ACME", subPath: "Clients/ACME" } },
      { label: "2024", target: null },
    ]);
  });

  it("treats a first-level folder as the current crumb under the drive", () => {
    expect(
      driveTrail({ drive: DRIVE, nested: true, subFolderPath: "Clients", mainFolderActualName: "Clients" }),
    ).toEqual([
      { label: "Design team", target: { kind: "drive", label: SHARED, remote: true } },
      { label: "Clients", target: null },
    ]);
  });
});

describe("jumping back to a drive's root", () => {
  // On the Drive page the root is view state; the URL goes back to the bare page.
  it("goes to the bare Drive page from Drive", () => {
    expect(driveRootHref(DRIVE_PAGE_ROUTE, DRIVE)).toBe("/files");
  });

  // On Shared Drives the drive must stay in the URL, or the page shows its
  // list instead (and a reload would forget the drive).
  it("keeps the drive, and its name, in the URL on Shared Drives", () => {
    const href = driveRootHref(SHARED_DRIVES_DRIVE_ROUTE, DRIVE);
    expect(href).toBe(sharedDrivesDriveRoute(DRIVE));
    const get = paramsOf(href);
    expect(new URL(`app://x${href}`).pathname).toBe("/shared-drives");
    expect(get("openLabel")).toBe(SHARED);
    expect(get("openRemote")).toBe("1");
    expect(get("openName")).toBe("Design team");
  });

  it("opens a drive synced here by its label alone", () => {
    expect(driveRootHref(SHARED_DRIVES_DRIVE_ROUTE, { label: "team-1", remote: false })).toBe(
      "/shared-drives?openLabel=team-1",
    );
  });
});

describe("the URL once a drive has opened", () => {
  it("is cleared on the Drive page, which opens on its list after a reload", () => {
    expect(urlAfterOpen(DRIVE_PAGE_ROUTE, DRIVE)).toBe("/files");
  });

  it("is left alone on Shared Drives, so a reload reopens the same drive", () => {
    expect(urlAfterOpen(SHARED_DRIVES_DRIVE_ROUTE, DRIVE)).toBeNull();
  });

  // A subfolder to step into or a file to point out happens once; a reload
  // must not replay it.
  it("drops only the one-shot parts on Shared Drives", () => {
    expect(
      urlAfterOpen(SHARED_DRIVES_DRIVE_ROUTE, { ...DRIVE, subfolder: "Clients", file: "a.png" }),
    ).toBe(sharedDrivesDriveRoute(DRIVE));
  });
});

describe("where the drive view starts", () => {
  it("starts on the folder list on the Drive page", () => {
    expect(initialDriveView({ pinned: null, parent: undefined, open: null })).toEqual({
      syncLabel: null,
      remoteLabel: null,
      onFolderList: true,
    });
  });

  // A reload of /shared-drives?openLabel=… lands straight in the drive.
  it("starts inside the drive the URL names on Shared Drives", () => {
    expect(
      initialDriveView({
        pinned: null,
        parent: SHARED_DRIVES_DRIVE_ROUTE.parent,
        open: { label: SHARED, remote: true },
      }),
    ).toEqual({ syncLabel: null, remoteLabel: SHARED, onFolderList: false });
    expect(
      initialDriveView({
        pinned: null,
        parent: SHARED_DRIVES_DRIVE_ROUTE.parent,
        open: { label: "team-1", remote: false },
      }),
    ).toEqual({ syncLabel: "team-1", remoteLabel: null, onFolderList: false });
  });

  // A reload inside a folder: the nested params carry the drive, and there
  // is no folder list to fall back to.
  it("never starts on a folder list on Shared Drives", () => {
    expect(
      initialDriveView({ pinned: null, parent: SHARED_DRIVES_DRIVE_ROUTE.parent, open: null }).onFolderList,
    ).toBe(false);
  });

  it("starts in the pinned drive on Captures", () => {
    expect(
      initialDriveView({ pinned: { label: "caps", remote: false }, parent: undefined, open: null }),
    ).toEqual({ syncLabel: "caps", remoteLabel: null, onFolderList: false });
  });
});

describe("whether Shared Drives has a drive open", () => {
  it("does at a drive's root", () => {
    expect(isDriveOpenInUrl(paramsOf(sharedDrivesDriveRoute(DRIVE)))).toBe(true);
  });

  it("does inside a folder of it, after a reload", () => {
    const href =
      "/shared-drives?folderName=ACME&subFolderPath=Clients%2FACME&mainFolderActualName=Clients" +
      `&folderSource=remote%3A%2F%2F${encodeURIComponent(SHARED)}`;
    expect(isDriveOpenInUrl(paramsOf(href))).toBe(true);
  });

  it("does not on the list, whatever tab", () => {
    expect(isDriveOpenInUrl(paramsOf("/shared-drives"))).toBe(false);
    // Half a folder link shows the list rather than an empty folder.
    expect(isDriveOpenInUrl(paramsOf("/shared-drives?folderName=ACME"))).toBe(false);
  });
});

// Captures kept in a folder the user picked inside one of their synced
// drives (Documents > hippius-recordingss): the Captures page lists that
// folder, its captures and its subfolders, and nothing else of the drive.
describe("a Captures page rooted at a folder inside a drive", () => {
  const SYNCED = { label: "Documents", remote: false, folder: "hippius-recordingss" };
  const DOCUMENTS = "/Users/a/Documents";
  // The page's getter, as `useUrlParams` gives it (missing = the default).
  const getterOf = (href: string) => {
    const params = new URL(`app://x${href}`).searchParams;
    return (key: string, fallback = "") => params.get(key) ?? fallback;
  };
  const folderRow = (name: string, source: string): FormattedUserFile =>
    ({ name, actualFileName: name, isFolder: true, source, arionHash: "" }) as unknown as FormattedUserFile;

  it("opens the folder itself, found in the drive's folder here", () => {
    const href = pinnedFolderHref("/captures", SYNCED, DOCUMENTS)!;
    const get = paramsOf(href);
    expect(href.startsWith("/captures?")).toBe(true);
    expect(get("subFolderPath")).toBe("hippius-recordingss");
    expect(get("mainFolderActualName")).toBe("hippius-recordingss");
    expect(get("folderName")).toBe("hippius-recordingss");
    // The listing finds the drive by a path inside its folder here.
    expect(get("folderSource")).toBe("/Users/a/Documents/hippius-recordingss");
    expect(isNestedFolderView({ folderName: get("folderName"), subFolderPath: get("subFolderPath") })).toBe(true);
  });

  it("opens it on the server for a drive whose captures go there", () => {
    const get = paramsOf(pinnedFolderHref("/captures", { ...SYNCED, remote: true }, null)!);
    expect(get("folderSource")).toBe("remote://Documents");
    expect(get("subFolderPath")).toBe("hippius-recordingss");
  });

  it("names a deeper folder from the drive's root", () => {
    const get = paramsOf(pinnedFolderHref("/captures", { ...SYNCED, folder: "Shots/hippius-captures/" }, DOCUMENTS)!);
    expect(get("mainFolderActualName")).toBe("Shots");
    expect(get("subFolderPath")).toBe("Shots/hippius-captures");
    expect(get("folderName")).toBe("hippius-captures");
  });

  it("has nothing to open for a whole drive, or a synced drive not located yet", () => {
    expect(pinnedFolderHref("/captures", { label: "Hippius Captures", remote: false }, DOCUMENTS)).toBeNull();
    expect(pinnedFolderHref("/captures", SYNCED, undefined)).toBeNull();
  });

  it("stays inside the folder and its subfolders, never the drive's root or a folder beside it", () => {
    expect(isInsidePinnedFolder(SYNCED, false, null)).toBe(false);
    expect(isInsidePinnedFolder(SYNCED, true, "Projects")).toBe(false);
    expect(isInsidePinnedFolder(SYNCED, true, "hippius-recordingss-old")).toBe(false);
    expect(isInsidePinnedFolder(SYNCED, true, "hippius-recordingss")).toBe(true);
    expect(isInsidePinnedFolder(SYNCED, true, "hippius-recordingss/Week 1/Demos")).toBe(true);
    // A page pinned to a whole drive is never sent anywhere.
    expect(isInsidePinnedFolder({ label: "Hippius Captures", remote: false }, false, null)).toBe(true);
  });

  it("opens a subfolder from its row and keeps it inside the page", () => {
    const root = pinnedFolderHref("/captures", SYNCED, DOCUMENTS)!;
    const { url } = generateFolderUrl(
      folderRow("Week 1", `${DOCUMENTS}/hippius-recordingss/Week 1`),
      getterOf(root),
      undefined,
      "/captures",
    );
    const get = paramsOf(url);
    expect(url.startsWith("/captures?")).toBe(true);
    expect(get("subFolderPath")).toBe("hippius-recordingss/Week 1");
    expect(isInsidePinnedFolder(SYNCED, true, get("subFolderPath"))).toBe(true);
    expect(isPinnedRoot(SYNCED, get("subFolderPath"))).toBe(false);
  });

  it("starts the trail at the folder, each level below it a way back", () => {
    const trail = driveTrail({
      drive: { label: "Documents", remote: false, name: "Documents" },
      nested: true,
      subFolderPath: "hippius-recordingss/Week 1",
      mainFolderActualName: "hippius-recordingss",
    });
    expect(trailFromPinnedFolder(trail, SYNCED)).toEqual([
      { label: "hippius-recordingss", target: { kind: "folder", name: "hippius-recordingss", subPath: "hippius-recordingss" } },
      { label: "Week 1", target: null },
    ]);
    // At the folder itself it is the one crumb, and where you are.
    const atRoot = driveTrail({
      drive: { label: "Documents", remote: false, name: "Documents" },
      nested: true,
      subFolderPath: "hippius-recordingss",
      mainFolderActualName: "hippius-recordingss",
    });
    expect(trailFromPinnedFolder(atRoot, SYNCED)).toEqual([{ label: "hippius-recordingss", target: null }]);
    // A whole drive keeps its trail.
    expect(trailFromPinnedFolder(atRoot, { label: "Documents", remote: false })).toEqual(atRoot);
  });

  it("shows the page's own empty state at the folder, not in its subfolders", () => {
    expect(isPinnedRoot(SYNCED, "hippius-recordingss")).toBe(true);
    expect(isPinnedRoot(SYNCED, "hippius-recordingss/Week 1")).toBe(false);
    expect(isPinnedRoot(SYNCED, null)).toBe(false);
    expect(isPinnedRoot({ label: "Hippius Captures", remote: false }, null)).toBe(true);
    expect(isPinnedRoot(null, null)).toBe(false);
  });
});
