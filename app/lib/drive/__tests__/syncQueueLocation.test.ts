import { describe, expect, it } from "vitest";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { CaptureDriveStatus } from "@/app/lib/tauri/capture";
import type { DriveEntry } from "@/app/lib/global-atoms/unpinAtoms";
import { CAPTURES_ROUTE } from "@/app/lib/routes";
import { makeFolderGrantLabel, makeSharedDriveLabel } from "@/app/lib/shared-drives/sharedDriveLabel";
import {
  highlightRequestFromUrl,
  isRequestedLevel,
  nextHighlightStep,
} from "@/app/components/page-sections/drive/highlightEntry";
import {
  browsedFromServer,
  capturesDriveFromStatus,
  syncQueueFolderRoute,
  type CapturesDrive,
} from "../syncQueueLocation";

type Drives = ReadonlyMap<string, Pick<DriveEntry, "status">>;

const active = { status: { kind: "active" } } as const;
const paused = { status: { kind: "paused" } } as const;
const drives = (entries: Record<string, Pick<DriveEntry, "status">>): Drives => new Map(Object.entries(entries));

function parse(url: string | null) {
  expect(url).not.toBeNull();
  const [path, query] = (url as string).split("?");
  const params = new URLSearchParams(query);
  return {
    path,
    label: params.get("openLabel"),
    remote: params.get("openRemote") === "1",
    subfolder: params.get("openSubfolder"),
    file: params.get("openFile"),
  };
}

const ready = (over: Partial<Extract<CaptureDriveStatus, { state: "ready" }>> = {}): CaptureDriveStatus => ({
  state: "ready",
  label: "hippius-captures",
  name: "hippius-captures",
  folder: "",
  remote: false,
  ...over,
});

describe("capturesDriveFromStatus", () => {
  it("is the captures drive when it is a drive of its own", () => {
    expect(capturesDriveFromStatus(ready({ remote: true }))).toEqual({ label: "hippius-captures", remote: true, folder: "" });
    expect(capturesDriveFromStatus(ready({ folder: undefined }))).toEqual({ label: "hippius-captures", remote: false, folder: "" });
  });

  it("is the drive and its folder for captures kept in a folder of another drive", () => {
    expect(capturesDriveFromStatus(ready({ label: "Documents", folder: "/hippius-recordingss/" }))).toEqual({
      label: "Documents",
      remote: false,
      folder: "hippius-recordingss",
    });
  });

  it("is none before there is a drive, or when it could not be added", () => {
    expect(
      capturesDriveFromStatus({ state: "needsSetup", suggested: { path: "/x", place: "x" }, waiting: 0 } as CaptureDriveStatus),
    ).toBeNull();
    expect(
      capturesDriveFromStatus({ state: "pending", location: { path: "/x", place: "x" }, message: "m" } as CaptureDriveStatus),
    ).toBeNull();
    expect(capturesDriveFromStatus(null)).toBeNull();
  });
});

describe("browsedFromServer", () => {
  it("opens a drive synced here locally, and a paused or unsynced one from the server", () => {
    const here = drives({ Work: active, Paused: paused, Broken: { status: { kind: "error", message: "x" } } });
    expect(browsedFromServer("Work", here)).toBe(false);
    // A paused drive's folder here never gets a direct upload (a capture's backup).
    expect(browsedFromServer("Paused", here)).toBe(true);
    expect(browsedFromServer("Elsewhere", here)).toBe(true);
    expect(browsedFromServer("Broken", here)).toBe(false);
  });
});

describe("syncQueueFolderRoute", () => {
  const captures: CapturesDrive = { label: "hippius-recordingss", remote: true, folder: "" };

  it("opens a capture on the Captures page, not as a path in My Drive", () => {
    // The reported case: a recording backed up to the captures drive, whose
    // folder the user keeps in ~/Documents and is paused here.
    const at = parse(
      syncQueueFolderRoute(
        { label: "hippius-recordingss", path: "Recording 2026-11-27 at 16.13.34.mp4" },
        { drives: drives({ "hippius-recordingss": paused }), captures },
      ),
    );
    expect(at.path).toBe(CAPTURES_ROUTE);
    expect(at.label).toBe("hippius-recordingss");
    // Rust's answer for the captures drive, the one the Captures page is pinned to.
    expect(at.remote).toBe(true);
    expect(at.subfolder).toBeNull();
    expect(at.file).toBe("Recording 2026-11-27 at 16.13.34.mp4");
  });

  it("follows Rust's remote answer for the captures drive, not the drive map", () => {
    const at = parse(
      syncQueueFolderRoute(
        { label: "hippius-captures", path: "Shot.png" },
        { drives: drives({}), captures: { label: "hippius-captures", remote: false, folder: "" } },
      ),
    );
    expect(at.path).toBe(CAPTURES_ROUTE);
    expect(at.remote).toBe(false);
  });

  it("opens a folder the user made inside the captures drive", () => {
    const at = parse(
      syncQueueFolderRoute({ label: "hippius-recordingss", path: "Demos/2026/clip.mp4" }, { drives: drives({}), captures }),
    );
    expect(at.path).toBe(CAPTURES_ROUTE);
    expect(at.subfolder).toBe("Demos/2026");
    expect(at.file).toBe("clip.mp4");
  });

  it("decides by the drive's identity, not by a folder's name", () => {
    // The captures drive's folder sits inside the Documents drive's folder on
    // disk, and Documents has a folder of the same name: that one is Drive's.
    const here = drives({ Documents: active, "hippius-recordingss": active });
    const inDocuments = parse(
      syncQueueFolderRoute({ label: "Documents", path: "hippius-recordingss/notes.txt" }, { drives: here, captures }),
    );
    expect(inDocuments.path).toBe("/files");
    expect(inDocuments.label).toBe("Documents");
    expect(inDocuments.subfolder).toBe("hippius-recordingss");

    const capture = parse(syncQueueFolderRoute({ label: "hippius-recordingss", path: "notes.txt" }, { drives: here, captures }));
    expect(capture.path).toBe(CAPTURES_ROUTE);
  });

  it("opens captures kept in a folder of another drive on the Captures page, rooted at that folder", () => {
    // The reported case: captures in a folder inside Documents opened
    // Drive > Documents instead of the Captures page.
    const status = ready({ label: "Documents", folder: "Screens", remote: true });
    const at = parse(
      syncQueueFolderRoute(
        { label: "Documents", path: "Screens/Shot.png" },
        { drives: drives({ Documents: paused }), captures: capturesDriveFromStatus(status) },
      ),
    );
    expect(at.path).toBe(CAPTURES_ROUTE);
    expect(at.label).toBe("Documents");
    expect(at.remote).toBe(true);
    // Relative to the page's root, which is the captures folder.
    expect(at.subfolder).toBeNull();
    expect(at.file).toBe("Shot.png");

    const nested = parse(
      syncQueueFolderRoute(
        { label: "Documents", path: "Screens/Demos/clip.mp4" },
        { drives: drives({ Documents: paused }), captures: capturesDriveFromStatus(status) },
      ),
    );
    expect(nested.path).toBe(CAPTURES_ROUTE);
    expect(nested.subfolder).toBe("Demos");
  });

  it("opens the rest of that drive on Drive, a lookalike folder included", () => {
    const captures = capturesDriveFromStatus(ready({ label: "Documents", folder: "Screens" }));
    const here = drives({ Documents: active });
    for (const path of ["notes.txt", "Screens Old/a.png", "Work/Screens/a.png"]) {
      const at = parse(syncQueueFolderRoute({ label: "Documents", path }, { drives: here, captures }));
      expect(at.path).toBe("/files");
    }
  });

  it("opens Drive when there are no captures to show (the captures drive was deleted)", () => {
    const at = parse(
      syncQueueFolderRoute(
        { label: "hippius-captures", path: "Recording.mp4" },
        { drives: drives({}), captures: capturesDriveFromStatus(null) },
      ),
    );
    expect(at.path).toBe("/files");
    expect(at.file).toBe("Recording.mp4");
  });

  it("opens a file in a drive's nested folder there, locally when the drive syncs here", () => {
    const at = parse(
      syncQueueFolderRoute(
        { label: "Work", path: "Clients/Acme/2026/report.pdf" },
        { drives: drives({ Work: active }), captures: null },
      ),
    );
    expect(at).toEqual({ path: "/files", label: "Work", remote: false, subfolder: "Clients/Acme/2026", file: "report.pdf" });
  });

  it("opens a file at a drive's root with no folder to step into", () => {
    const at = parse(syncQueueFolderRoute({ label: "Work", path: "/report.pdf" }, { drives: drives({ Work: active }), captures: null }));
    expect(at.subfolder).toBeNull();
    expect(at.file).toBe("report.pdf");
  });

  it("opens a paused drive from the server, where a direct upload is", () => {
    const at = parse(syncQueueFolderRoute({ label: "Work", path: "a/b.txt" }, { drives: drives({ Work: paused }), captures: null }));
    expect(at.remote).toBe(true);
  });

  it("opens a shared drive from the server under its browse label", () => {
    const label = makeSharedDriveLabel({ ownerSs58: "5Owner", folderHash: "abc123" });
    const at = parse(syncQueueFolderRoute({ label, path: "Team/plan.md" }, { drives: drives({}), captures: null }));
    expect(at).toEqual({ path: "/files", label, remote: true, subfolder: "Team", file: "plan.md" });
  });

  it("opens a shared drive synced here locally", () => {
    const at = parse(
      syncQueueFolderRoute({ label: "Team drive", path: "Team/plan.md" }, { drives: drives({ "Team drive": active }), captures: null }),
    );
    expect(at.remote).toBe(false);
    expect(at.subfolder).toBe("Team");
  });

  it("opens a shared folder's file relative to that folder, which it is browsed rooted at", () => {
    // Rust's rows carry the server path, with the granted folder in front.
    const label = makeFolderGrantLabel({ ownerSs58: "5Owner", folderHash: "abc123", pathPrefix: "Projects/Q4" });
    const nested = parse(syncQueueFolderRoute({ label, path: "Projects/Q4/Drafts/v2.docx" }, { drives: drives({}), captures: null }));
    expect(nested.subfolder).toBe("Drafts");
    expect(nested.file).toBe("v2.docx");
    const atRoot = parse(syncQueueFolderRoute({ label, path: "Projects/Q4/v1.docx" }, { drives: drives({}), captures: null }));
    expect(atRoot.subfolder).toBeNull();
    expect(atRoot.file).toBe("v1.docx");
  });

  it("names no place for a row with no drive", () => {
    expect(syncQueueFolderRoute({ label: "", path: "x.txt" }, { drives: drives({}), captures: null })).toBeNull();
  });
});

// The route only matters if the page it opens points the row out: the
// request the page builds from the URL must be for the level it then shows.
describe("the row is pointed out where the route lands", () => {
  const file = (name: string, isFolder = false) =>
    ({ name, actualFileName: name, isFolder }) as unknown as FormattedUserFile;

  function requestFor(url: string | null, now = 1_000, root?: string) {
    const at = parse(url);
    return highlightRequestFromUrl({ label: at.label as string, subfolder: at.subfolder, file: at.file }, now, root);
  }

  const view = (ordered: FormattedUserFile[], now = 1_000) => ({
    ordered,
    serverPaged: false,
    paged: true,
    page: 1,
    pageSize: 20,
    now,
  });

  it("on the Captures page, at the drive's root (list or grid alike)", () => {
    const request = requestFor(
      syncQueueFolderRoute(
        { label: "hippius-captures", path: "Recording.mp4" },
        { drives: drives({}), captures: { label: "hippius-captures", remote: true, folder: "" } },
      ),
    );
    expect(request).not.toBeNull();
    // The Captures page's own level: its pinned drive, at its root.
    expect(isRequestedLevel(request!, { label: "hippius-captures", folder: "" })).toBe(true);
    const step = nextHighlightStep(request!, view([file("Older.mp4"), file("Recording.mp4")]));
    expect(step).toEqual({ kind: "show", file: expect.objectContaining({ name: "Recording.mp4" }) });
  });

  it("on the Captures page rooted at a folder of another drive, at that folder", () => {
    const captures = capturesDriveFromStatus(ready({ label: "Documents", folder: "Screens" }));
    const url = syncQueueFolderRoute({ label: "Documents", path: "Screens/Demos/clip.mp4" }, { drives: drives({}), captures });
    // The page names its levels from the drive's root (`PinnedDrive.folder`).
    const request = requestFor(url, 1_000, "Screens");
    expect(isRequestedLevel(request!, { label: "Documents", folder: "Screens" })).toBe(false);
    expect(isRequestedLevel(request!, { label: "Documents", folder: "Screens/Demos" })).toBe(true);
    const atRoot = requestFor(
      syncQueueFolderRoute({ label: "Documents", path: "Screens/Shot.png" }, { drives: drives({}), captures }),
      1_000,
      "Screens",
    );
    expect(isRequestedLevel(atRoot!, { label: "Documents", folder: "Screens" })).toBe(true);
  });

  it("in a nested folder, and not at the drive's root on the way there", () => {
    const request = requestFor(
      syncQueueFolderRoute({ label: "Work", path: "Clients/Acme/report.pdf" }, { drives: drives({ Work: active }), captures: null }),
    );
    expect(isRequestedLevel(request!, { label: "Work", folder: "" })).toBe(false);
    expect(isRequestedLevel(request!, { label: "Work", folder: "Clients/Acme" })).toBe(true);
  });

  it("in a shared folder, at the level its browse shows", () => {
    const label = makeFolderGrantLabel({ ownerSs58: "5Owner", folderHash: "abc123", pathPrefix: "Projects/Q4" });
    const request = requestFor(syncQueueFolderRoute({ label, path: "Projects/Q4/Drafts/v2.docx" }, { drives: drives({}), captures: null }));
    expect(isRequestedLevel(request!, { label, folder: "Drafts" })).toBe(true);
  });

  it("opens the folder and quietly points nothing out when the file was deleted or moved", () => {
    const request = requestFor(
      syncQueueFolderRoute({ label: "Work", path: "Clients/gone.pdf" }, { drives: drives({ Work: active }), captures: null }),
    );
    // A folder of the same name is never taken for the file.
    const listing = [file("other.pdf"), file("gone.pdf", true)];
    expect(nextHighlightStep(request!, view(listing))).toEqual({ kind: "wait" });
    expect(nextHighlightStep(request!, view(listing, request!.until))).toEqual({ kind: "give-up" });
  });
});
