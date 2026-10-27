import { describe, expect, it } from "vitest";

import {
  driveRootHref,
  driveTrail,
  initialDriveView,
  isDriveOpenInUrl,
  urlAfterOpen,
} from "../driveTrail";
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
