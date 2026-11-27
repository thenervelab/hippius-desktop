import { capturesRoute, driveFolderRoute } from "@/app/lib/routes";
import { parseFolderGrantLabel } from "@/app/lib/shared-drives/sharedDriveLabel";
import type { CaptureDriveStatus } from "@/app/lib/tauri/capture";
import type { DriveEntry } from "@/app/lib/global-atoms/unpinAtoms";
import { baseNameOf, parentOf } from "@/app/components/page-sections/drive/uploadingHere";

/**
 * The captures drive the Captures page shows, when it is a drive of its own.
 * Found by its label (Rust's `capture_drive_status`), never by its folder's
 * name: the user can call that folder anything and put it anywhere, even
 * inside another drive's folder on disk.
 */
export interface CapturesDrive {
  label: string;
  /** Rust's answer: browsed from the server (not synced here, or paused). */
  remote: boolean;
}

/**
 * The captures drive a sync queue row can open on the Captures page, from
 * Rust's status. Only a captures drive of its own (no `folder`): captures
 * kept in a folder of another drive open on the Drive page, in that folder,
 * the way the capture card's own "Show in folder" opens them.
 */
export function capturesDriveFromStatus(status: CaptureDriveStatus | null | undefined): CapturesDrive | null {
  if (!status || status.state !== "ready" || !status.label) return null;
  if ((status.folder ?? "").replace(/^\/+|\/+$/g, "") !== "") return null;
  return { label: status.label, remote: status.remote };
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
 * - A file in the captures drive opens the Captures page (where the sidebar's
 *   Captures goes), in its subfolder when it is in one.
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
  const { captures } = context;
  if (captures && captures.label === file.label) {
    return capturesRoute(captures.label, captures.remote, name, folder);
  }
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
