/**
 * Files and folders dropped on the main window from Finder, Explorer or a
 * file manager.
 *
 * One app-level host (`OsDropHost`) hears every drop on the main window.
 * Which upload a drop starts is decided by the view on screen, which says
 * where its files would go by registering a target here
 * (`useOsDropTarget`). Before this the only listener lived inside the drive
 * table and handed the drop to whichever Upload button happened to be
 * mounted, so the drive list, Shared Drives, remote drives and a drive with
 * no button on screen dropped files without a word.
 *
 * This module holds the decisions (pure, unit-tested) and two small
 * registries: the view's target, and the dialogs that take drops themselves.
 */

/** Where a drop on the current view goes. */
export type OsDropDestination =
  /** No drive on screen (Recent Files, the drive list, Shared Drives): ask. */
  | { kind: "choose" }
  /** A drive synced on this computer, at its root or in one of its folders. */
  | {
      kind: "local";
      label: string;
      /** Set inside a folder of the drive; absent at the drive's root. */
      folder?: {
        name: string;
        /** Path relative to the drive's root, e.g. "Photos/2024". */
        subfolder?: string;
        syncBasePath?: string;
      };
    }
  /** A drive (or a folder of one) that is not synced here: straight to the server. */
  | { kind: "remote"; label: string; parentPath?: string };

/** What a view registers. */
export interface OsDropTarget {
  /** `null` when this view cannot take a drop right now; `blockedReason` says why. */
  destination: OsDropDestination | null;
  /** Shown in the drag overlay: "Drop files here to upload them to <name>". */
  name: string;
  /** Why a drop here is refused (a Viewer on a shared drive), or null. */
  writeRefusal?: string | null;
  /** Why this view cannot take a drop at all yet, or null. */
  blockedReason?: string | null;
  /** The polled check already says there is no room (opens the plan dialog). */
  storageBlocked?: boolean;
  /** A local drive's own folder-upload dialog, seeded with the dropped folder. */
  openFolder?: (folderPath: string) => void;
  /** Called after an upload this view should refresh for. */
  onUploaded?: () => void;
}

// ── The target registry ─────────────────────────────────────────────────────

type TargetGetter = () => OsDropTarget | null;

const targets: Array<{ id: number; get: TargetGetter }> = [];
const targetListeners = new Set<() => void>();
let nextId = 1;

/**
 * Register the view's target. The latest registration wins (a drive opened
 * over a list registers after it); unregistering hands back to the one
 * before. The getter is read at drag time, so a view that changes folder
 * never re-registers.
 */
export function registerOsDropTarget(get: TargetGetter): () => void {
  const id = nextId++;
  targets.push({ id, get });
  targetListeners.forEach((fn) => fn());
  return () => {
    const at = targets.findIndex((t) => t.id === id);
    if (at >= 0) targets.splice(at, 1);
  };
}

/** The target of the view on screen, or null where no view takes drops. */
export function currentOsDropTarget(): OsDropTarget | null {
  for (let i = targets.length - 1; i >= 0; i--) {
    const target = targets[i].get();
    if (target) return target;
  }
  return null;
}

/** Hear every new registration (a parked tray drop waits for one). */
export function onOsDropTargetRegistered(fn: () => void): () => void {
  targetListeners.add(fn);
  return () => {
    targetListeners.delete(fn);
  };
}

// ── Dialogs that take drops themselves ──────────────────────────────────────

let claims = 0;

/**
 * A dialog with its own drop area (the upload dialogs, Sync a Folder,
 * wallet import) claims drops while it is open, so a drop onto it is not
 * also started as an upload by the page behind it.
 */
export function claimOsDrops(): () => void {
  claims++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims--;
  };
}

export function osDropsClaimed(): boolean {
  return claims > 0;
}

// ── Decisions ───────────────────────────────────────────────────────────────

export const DROP_SYNC_FOLDER_FIRST = "Set up a sync folder for this drive before uploading.";
export const DROP_READ_ONLY = "You can only view this drive, so files can't be added to it.";
export const DROP_UNREADABLE =
  "Couldn't read what was dropped. Try again, or use the Upload button.";
export const DROP_FOLDERS_SKIPPED =
  'Folders were skipped. Use "Upload Folder" to upload a folder.';
export const DROP_FIRST_FOLDER_ONLY = "Only the first dropped folder will be used.";

/** What a drive view knows about where it is. */
export interface DriveViewForDrop {
  /** Recent Files on Overview. */
  isRecentFiles: boolean;
  /** The drive list (or its onboarding) is on screen rather than a drive. */
  showsDriveList: boolean;
  /** The open drive when it is not synced here. */
  remote: { label: string; parentPath?: string } | null;
  /** The open drive when it is synced here. */
  local: {
    label: string | null;
    /** The drive has no folder on this computer to copy into. */
    syncPathMissing: boolean;
    folder?: { name: string; subfolder?: string; syncBasePath?: string } | null;
  } | null;
}

/**
 * Where a drop on a drive view goes. Recent Files and the drive list ask
 * for a drive; inside a drive the drive (and folder) on screen is the
 * answer, so nothing is asked.
 */
export function resolveDriveDropDestination(view: DriveViewForDrop): {
  destination: OsDropDestination | null;
  blockedReason: string | null;
} {
  if (view.isRecentFiles || view.showsDriveList) {
    return { destination: { kind: "choose" }, blockedReason: null };
  }
  if (view.remote) {
    return {
      destination: {
        kind: "remote",
        label: view.remote.label,
        ...(view.remote.parentPath ? { parentPath: view.remote.parentPath } : {}),
      },
      blockedReason: null,
    };
  }
  if (view.local?.label && !view.local.syncPathMissing) {
    return {
      destination: {
        kind: "local",
        label: view.local.label,
        ...(view.local.folder ? { folder: view.local.folder } : {}),
      },
      blockedReason: null,
    };
  }
  return { destination: null, blockedReason: DROP_SYNC_FOLDER_FIRST };
}

/** What a classified drop does. */
export type DropPlan =
  | { action: "refuse"; message: string }
  | { action: "files"; files: string[]; note: string | null }
  | { action: "folder"; folder: string; note: string | null };

/**
 * Files go to the file upload; a drop of folders only goes to the folder
 * upload, one folder at a time (each folder flow takes one root). A mixed
 * drop uploads the files and says the folders were left out. Nothing
 * readable is said too, never dropped in silence.
 */
export function planClassifiedDrop(classified: { files: string[]; folders: string[] }): DropPlan {
  const { files, folders } = classified;
  if (files.length > 0) {
    return { action: "files", files, note: folders.length > 0 ? DROP_FOLDERS_SKIPPED : null };
  }
  if (folders.length > 0) {
    return {
      action: "folder",
      folder: folders[0],
      note: folders.length > 1 ? DROP_FIRST_FOLDER_ONLY : null,
    };
  }
  return { action: "refuse", message: DROP_UNREADABLE };
}

/**
 * Whether a drop is refused before anything is read: the view's own
 * reasons, in the order the drive page always gave them.
 */
export function refusalBeforeReading(target: OsDropTarget): string | null {
  if (target.writeRefusal) return target.writeRefusal;
  if (!target.destination) return target.blockedReason ?? DROP_SYNC_FOLDER_FIRST;
  return null;
}
