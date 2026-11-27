import { capturesRoute, driveFolderRoute } from "@/app/lib/routes";
import { parseFolderGrantLabel } from "@/app/lib/shared-drives/sharedDriveLabel";
import type { CaptureDriveStatus } from "@/app/lib/tauri/capture";
import type { DriveEntry } from "@/app/lib/global-atoms/unpinAtoms";
import { baseNameOf, parentOf } from "@/app/components/page-sections/drive/uploadingHere";

/**
 * Where captures go, which the Captures page shows: a drive of their own,
 * or a folder inside another drive (the page is rooted at that folder).
 * Found by its label (Rust's `capture_drive_status`), never by its folder's
 * name: the user can call that folder anything and put it anywhere, even
 * inside another drive's folder on disk.
 */
export interface CapturesDrive {
  label: string;
  /** Rust's answer: browsed from the server (not synced here, or paused). */
  remote: boolean;
  /** The captures folder from the drive's root; "" for a drive of their own. */
  folder: string;
}

/**
 * The captures location a row can open on the Captures page, from Rust's
 * status. None while captures have nowhere to go (not set up, or the drive
 * could not be added): a row then opens on the Drive page.
 */
export function capturesDriveFromStatus(status: CaptureDriveStatus | null | undefined): CapturesDrive | null {
  if (!status || status.state !== "ready" || !status.label) return null;
  return { label: status.label, remote: status.remote, folder: trimSlashes(status.folder ?? "") };
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/**
 * The Captures page with a file pointed out, when the file is where
 * captures go: in that drive, inside its captures folder (anything, for a
 * drive of their own). `path` is drive-relative; the page's subfolder is
 * relative to the captures folder. Null for any other file.
 */
export function capturesPageRoute(file: { label: string; path: string }, captures: CapturesDrive | null): string | null {
  if (!captures || captures.label !== file.label) return null;
  const path = trimSlashes(file.path);
  const root = trimSlashes(captures.folder);
  if (root && !path.startsWith(`${root}/`)) return null;
  const inside = root ? path.slice(root.length + 1) : path;
  const name = baseNameOf(inside) || undefined;
  const folder = parentOf(inside) || undefined;
  return capturesRoute(captures.label, captures.remote, name, folder);
}

/**
 * Whether the Drive page browses `label` from the server. A drive whose sync
 * runs here opens its folder on this computer; any other one (not synced
 * here, a shared drive's browse label, or a PAUSED drive) opens the server's
 * listing. A paused drive's folder here never gets what was uploaded to it
 * directly (a capture's backup, say), so its local listing would not have
 * the file. The same rule Rust's `destination::is_local` keeps for captures.
 */
export function browsedFromServer(label: string, drives: ReadonlyMap<string, Pick<DriveEntry, "status">>): boolean {
  const entry = drives.get(label);
  return !entry || entry.status.kind === "paused";
}

/**
 * The page and folder a sync queue row's "Show in folder" opens, with the
 * file's own name so the row is pointed out once the folder is listed.
 * Null when the row names no drive.
 *
 * - A file where captures go opens the Captures page (where the sidebar's
 *   Captures goes), in its subfolder when it is in one, including captures
 *   kept in a folder inside another drive (`capturesPageRoute`).
 * - Any other file opens the Drive page in its folder.
 * - A folder grant's rows carry the server path, which starts with the
 *   granted folder; the grant is browsed rooted there, so that part goes.
 */
export function syncQueueFolderRoute(
  file: { label: string; path: string },
  context: {
    drives: ReadonlyMap<string, Pick<DriveEntry, "status">>;
    captures: CapturesDrive | null;
  },
): string | null {
  if (!file.label) return null;
  const path = withinBrowseRoot(file.label, file.path);
  const folder = parentOf(path) || undefined;
  const name = baseNameOf(path) || undefined;
  const onCapturesPage = capturesPageRoute({ label: file.label, path }, context.captures);
  if (onCapturesPage) return onCapturesPage;
  return driveFolderRoute(file.label, browsedFromServer(file.label, context.drives), folder, name);
}

/** `path` relative to what the label is browsed at: a folder grant's folder, else the drive's root. */
function withinBrowseRoot(label: string, path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const grant = parseFolderGrantLabel(label);
  if (!grant) return trimmed;
  const root = grant.pathPrefix.replace(/^\/+|\/+$/g, "");
  if (!root) return trimmed;
  // Rust joins the grant's own path in front (`identity::rooted_path`), so
  // the two are byte for byte the same here.
  return trimmed.startsWith(`${root}/`) ? trimmed.slice(root.length + 1) : trimmed;
}
