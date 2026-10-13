import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { UploadFeedItem } from "@/app/lib/upload-feed/mergeUploadFeed";
import { isCloudOnlyRow } from "@/app/lib/utils/cloudOnly";
import { isPreviewableFileName } from "@/app/lib/utils/filePreviewType";
import {
  canRenameFile,
  RENAME_DISABLED_TOOLTIP,
} from "@/app/lib/utils/renameGating";
import { normalizeRelPath } from "@/app/lib/utils/relPath";
import { offersImageEditor } from "@/app/lib/capture/editor/driveEntry";

/**
 * What the tray popover offers on one upload row: the three-dots menu, the
 * right-click menu (the same list) and the hover quick actions (a subset).
 *
 * The gates are the Drive menu's own predicates (`isCloudOnlyRow`,
 * `isPreviewableFileName`, `canRenameFile`), so a file offers here what its
 * row offers in Drive, less File Details and View on Explorer: the first is a
 * Drive-page panel, and the second would need the opener permission the
 * popover is deliberately denied (`capabilities/tray-panel.json`). The popover cannot read the
 * member-drive roles (a provider-free webview), so the actions that depend on
 * them (share, rename, delete) are checked again by the main window's
 * `TrayFileActionHost`, with the Drive's role gates, before anything runs.
 */
export type TrayRowActionId =
  | "preview"
  | "edit"
  | "download"
  | "copy-link"
  | "share"
  | "show-in-drive"
  | "reveal"
  | "rename"
  | "delete";

export interface TrayRowAction {
  id: TrayRowActionId;
  label: string;
  disabled?: boolean;
  /** Why the item is disabled, shown as its tooltip. */
  tooltip?: string;
  destructive?: boolean;
}

/** Actions that need a main-window dialog, toast or route: the popover
 *  reveals the main window and asks it to run them. */
export type TrayMainWindowAction =
  | "preview"
  | "download"
  | "share"
  | "show-in-drive"
  | "rename"
  | "delete";

const MAIN_WINDOW_ACTIONS: ReadonlySet<TrayRowActionId> = new Set([
  "preview",
  "download",
  "share",
  "show-in-drive",
  "rename",
  "delete",
]);

export function runsInMainWindow(
  id: TrayRowActionId,
): id is TrayMainWindowAction {
  return MAIN_WINDOW_ACTIONS.has(id);
}

/** Backend event the popover emits for a {@link TrayMainWindowAction};
 *  `TrayFileActionHost` in the main window runs it. */
export const TRAY_FILE_ACTION_EVENT = "hippius:tray-file-action";

export interface TrayFileActionRequest {
  action: TrayMainWindowAction;
  file: FormattedUserFile;
  /**
   * For "preview": the list the viewer walks with its arrows and thumbnail
   * rail (the popover tab the file was opened from). Absent, the viewer
   * shows the file alone.
   */
  siblings?: FormattedUserFile[];
}

/** A file-shaped object from another webview: it has a name to show. */
function isFileLike(value: unknown): value is FormattedUserFile {
  if (!value || typeof value !== "object") return false;
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0;
}

/** Shape check for a request arriving from another webview: the payload is
 *  data, so anything unexpected is dropped rather than half-run. */
export function parseTrayFileActionRequest(
  payload: unknown,
): TrayFileActionRequest | null {
  if (!payload || typeof payload !== "object") return null;
  const { action, file } = payload as Record<string, unknown>;
  if (typeof action !== "string") return null;
  if (!MAIN_WINDOW_ACTIONS.has(action as TrayRowActionId)) return null;
  if (!isFileLike(file)) return null;
  const { siblings } = payload as Record<string, unknown>;
  const list = Array.isArray(siblings) ? siblings.filter(isFileLike) : [];
  return {
    action: action as TrayMainWindowAction,
    file,
    // A list that does not hold the file would show the viewer with no
    // current item, so it is dropped rather than half-used.
    ...(list.length > 0 && list.some((f) => sameTrayFile(f, file))
      ? { siblings: list }
      : {}),
  };
}

/** Same drive and same drive-relative path: one file. */
export function sameTrayFile(a: FormattedUserFile, b: FormattedUserFile): boolean {
  return (a.label ?? "") === (b.label ?? "") && trayRowRelativePath(a) === trayRowRelativePath(b);
}

/**
 * Whether pressing the row's picture or name opens the file in the app's
 * viewer (`UnifiedMediaDialog`, in the main window): the same rule as the
 * menu's "View", a finished file the viewer can show.
 */
export function trayRowOpensViewer(item: UploadFeedItem): boolean {
  return item.feedStatus === "completed" && !item.isFolder && isPreviewableFileName(item.name);
}

/** The row's drive-relative path. */
export function trayRowRelativePath(item: FormattedUserFile): string {
  return normalizeRelPath(item.actualFileName || item.name);
}

/** Whether the row can be found in a drive at all. */
function hasDrive(item: FormattedUserFile): boolean {
  return Boolean(item.label);
}

/**
 * Whether a link can be made for the row. Same gate as the Drive's "Share
 * via link": a file at rest on the server (`synced`); a cloud-only file
 * also needs its server id, which the remote share downloads it by.
 */
export function canLinkTrayRow(item: UploadFeedItem): boolean {
  if (item.feedStatus !== "completed" || item.isFolder) return false;
  if (!hasDrive(item) || item.syncStatus !== "synced") return false;
  if (isCloudOnlyRow(item)) return Boolean(item.fileId);
  return true;
}

/** The server file id to share by, only for a file with no copy here: the
 *  Share dialog's `isCloudOnlyRow && fileId` dispatch. */
export function cloudFileIdFor(item: FormattedUserFile): string | null {
  return isCloudOnlyRow(item) && item.fileId ? item.fileId : null;
}

/**
 * Where "Show in Hippius" opens the Drive: the file's drive, the folder it
 * sits in, and the file to point out there (`driveFolderRoute`'s
 * arguments). `remote` is a drive not synced on this computer: a server row
 * carries a local `source` only when its drive is synced here, and a live
 * upload row (no server id) is always from a drive synced here.
 */
export function trayDriveLocation(item: FormattedUserFile): {
  label: string;
  remote: boolean;
  subfolder?: string;
  fileName: string;
} | null {
  if (!item.label) return null;
  const rel = trayRowRelativePath(item);
  const slash = rel.lastIndexOf("/");
  const subfolder = slash > 0 ? rel.slice(0, slash) : undefined;
  const fileName = slash >= 0 ? rel.slice(slash + 1) : rel;
  return {
    label: item.label,
    remote: Boolean(item.fileId) && !item.source,
    subfolder,
    fileName,
  };
}

/**
 * Whether the row offers Edit (the screenshot editor): the Drive's own
 * "Edit image" gate, for a finished upload. The popover cannot read which
 * drives are shared with the account (a provider-free webview), so a
 * member drive's picture is offered here and refused by Rust, which checks
 * every rule again when the editor opens.
 *
 * `editorEnabled`: capture is on for this computer (the popover's
 * `useTrayCaptureView` is `ready`), the flag AND Rust's support.
 */
export function canEditTrayRow(item: UploadFeedItem, editorEnabled: boolean): boolean {
  return (
    item.feedStatus === "completed" &&
    offersImageEditor({
      name: item.actualFileName || item.name,
      isFolder: Boolean(item.isFolder),
      label: item.label,
      cloudOnly: isCloudOnlyRow(item),
      serverFileId: item.fileId,
      memberDrive: false,
    }, editorEnabled)
  );
}

/** Whether there is a file on this computer to reveal. */
export function canRevealTrayRow(item: UploadFeedItem): boolean {
  if (isCloudOnlyRow(item)) return false;
  // A live upload row has no `source` but is always a file in a drive synced
  // here, which `resolve_file_path` finds by label and name.
  return Boolean(item.source) || (item.feedStatus !== "completed" && hasDrive(item));
}

/**
 * The full menu for a row, in the Drive menu's order. In-flight and failed
 * rows offer only the two "where is it" actions: they have nothing on the
 * server to view, download, link or rename yet.
 */
export function getTrayRowActions(
  item: UploadFeedItem,
  fileManager: string,
  editorEnabled: boolean,
): TrayRowAction[] {
  const actions: TrayRowAction[] = [];
  const completed = item.feedStatus === "completed";

  if (trayRowOpensViewer(item)) {
    actions.push({ id: "preview", label: "View" });
  }
  if (canEditTrayRow(item, editorEnabled)) {
    actions.push({ id: "edit", label: "Edit image" });
  }
  if (completed && !item.isFolder && hasDrive(item)) {
    actions.push({ id: "download", label: "Download" });
  }
  if (canLinkTrayRow(item)) {
    actions.push({ id: "copy-link", label: "Copy link" });
    actions.push({ id: "share", label: "Share via link…" });
  }
  if (hasDrive(item)) {
    actions.push({ id: "show-in-drive", label: "Show in Hippius" });
  }
  if (canRevealTrayRow(item)) {
    actions.push({ id: "reveal", label: `Reveal in ${fileManager}` });
  }
  if (completed && hasDrive(item)) {
    const renameable = canRenameFile(item);
    actions.push({
      id: "rename",
      label: "Rename…",
      disabled: !renameable,
      tooltip: renameable ? undefined : RENAME_DISABLED_TOOLTIP,
    });
  }
  // The Drive hides Delete on a cloud-only row (the delete removes the local
  // copy and lets sync carry it) and disables it while a file is mid-upload.
  if (completed && hasDrive(item) && !isCloudOnlyRow(item)) {
    actions.push({
      id: "delete",
      label: "Delete…",
      destructive: true,
      disabled: !item.isAssigned,
      tooltip: item.isAssigned
        ? undefined
        : "This file is still syncing and can't be deleted yet.",
    });
  }
  return actions;
}

/**
 * The hover actions at the row's end, in display order: its link (the
 * primary one) and, for a picture, Edit. Everything else is one click away
 * in the row's menu.
 */
export function getTrayQuickActions(item: UploadFeedItem, editorEnabled: boolean): TrayRowActionId[] {
  const quick: TrayRowActionId[] = [];
  if (canLinkTrayRow(item)) quick.push("copy-link");
  if (canEditTrayRow(item, editorEnabled)) quick.push("edit");
  return quick;
}
