// Typed calls to Rust's Drive Trash commands (`src-tauri/src/sync/fileops/trash`).
// Rust owns every rule and every sentence; these only carry the arguments.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** A row to move to Trash, named as `delete_files` names it. */
export interface TrashFileRequest {
  name: string;
  source: string | null;
  label: string | null;
}

export interface MoveToTrashResult {
  trashed: number;
  failed: Array<{ name: string; error: string }>;
  /** Pass to `undoMoveToTrash` or `releaseTrashHold`. */
  hold: string | null;
  /** Every trashed item can be brought back by Undo. */
  undoable: boolean;
  /** Days until the server deletes the items forever. */
  retentionDays?: number;
}

export interface TrashRow {
  label: string;
  driveName: string;
  shared: boolean;
  synced: boolean;
  canDeleteForever: boolean;
  itemId: string;
  isFolder: boolean;
  name: string;
  parentPath: string;
  path: string;
  /** The path as the server stores it; a keep-both restore is signed over it. */
  storedPath: string | null;
  fileCount: number;
  totalBytes: number;
  /** Unix seconds. */
  trashedAt: number;
  /** Unix seconds: when the server deletes it forever. */
  purgeAt: number;
  trashedBy: string | null;
  nameTaken: boolean;
  /** `trashing`: a folder still being moved in; `restoring`: a restore under way. */
  state: "trashing" | "ready" | "restoring";
  /** While `restoring`, how it started; it finishes the same way. */
  restoreMode: "inPlace" | "rename" | null;
  /** While `restoring` as a copy, where it is going. */
  restoreNewPath: string | null;
}

export interface TrashDrive {
  label: string;
  name: string;
  shared: boolean;
  canDeleteForever: boolean;
}

export interface TrashListing {
  items: TrashRow[];
  drives: TrashDrive[];
  incomplete: boolean;
  /** Days an item stays in Trash before the server deletes it forever. */
  retentionDays: number;
}

export type RestoreChoice = "ask" | "keepBoth" | "skip";

export interface RestoreItemResult {
  label: string;
  itemId: string;
  status: "restored" | "clash" | "skipped" | "notFound" | "failed";
  error: string | null;
  path: string;
}

export interface TrashDeleteResult {
  deleted: number;
  failed: string[];
}

export interface TrashProgress {
  jobId: string;
  action: "trash" | "restore" | "delete" | "empty";
  done: number;
  total: number;
}

export const TRASH_PROGRESS_EVENT = "trash_progress";

export function newTrashJobId(): string {
  return `trash-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function moveToTrash(accountId: string, jobId: string, files: TrashFileRequest[]): Promise<MoveToTrashResult> {
  return invoke<MoveToTrashResult>("move_to_trash", { accountId, jobId, files });
}

export function undoMoveToTrash(accountId: string, hold: string): Promise<{ restored: number; leftInTrash: number }> {
  return invoke("undo_move_to_trash", { accountId, hold });
}

export function releaseTrashHold(hold: string): Promise<void> {
  return invoke("release_trash_hold", { hold });
}

export function listTrash(accountId: string): Promise<TrashListing> {
  return invoke<TrashListing>("list_trash", { accountId });
}

export function restoreTrashItems(
  accountId: string,
  jobId: string,
  items: Array<{
    label: string;
    itemId: string;
    path: string;
    storedPath: string | null;
    isFolder: boolean;
    fileCount: number;
    onClash: RestoreChoice;
    restoreMode: TrashRow["restoreMode"];
    restoreNewPath: string | null;
  }>,
): Promise<RestoreItemResult[]> {
  return invoke<RestoreItemResult[]>("restore_trash_items", { accountId, jobId, items });
}

export function deleteTrashItemsForever(
  accountId: string,
  jobId: string,
  items: Array<{ label: string; itemId: string }>,
): Promise<TrashDeleteResult> {
  return invoke<TrashDeleteResult>("delete_trash_items_forever", { accountId, jobId, items });
}

export function emptyTrash(accountId: string, jobId: string, labels?: string[]): Promise<TrashDeleteResult> {
  return invoke<TrashDeleteResult>("empty_trash", { accountId, jobId, labels: labels ?? null });
}

/** A row to delete forever, as `delete_files` names it. */
export interface DeleteForeverRequest {
  name: string;
  source: string | null;
  label: string | null;
  size: number;
  turnOffLinks: string[];
}

/** `delete_files`' answer, from Delete forever while the server has Trash. */
export interface DeleteForeverResult {
  deleted: number;
  failed: Array<{ name: string; error: string }>;
  linksTurnedOff: number;
  linksFailed: number;
}

/**
 * Delete synced items forever while the server has Trash. Never
 * `delete_files` then: the sync engine would send that delete to Trash.
 */
export function deleteFilesForever(accountId: string, jobId: string, files: DeleteForeverRequest[]): Promise<DeleteForeverResult> {
  return invoke<DeleteForeverResult>("delete_files_forever", { accountId, jobId, files });
}

/** One synced drive's delete rules (Rust `DriveDeleteRule`). */
export interface DriveDeleteRule {
  label: string;
  /** The account owns or manages the drive. */
  canDeleteForever: boolean;
  /** Delete removes for good here ("Skip Trash", own drive). */
  skipsTrash: boolean;
}

export interface TrashDeleteRules {
  skipTrash: boolean;
  drives: DriveDeleteRule[];
}

export function getTrashDeleteRules(accountId: string): Promise<TrashDeleteRules> {
  return invoke<TrashDeleteRules>("get_trash_delete_rules", { accountId });
}

/** Save "Skip Trash when deleting"; Rust applies it to every drive's sync too. */
export function setSkipTrash(accountId: string, skip: boolean): Promise<void> {
  return invoke("set_skip_trash", { accountId, skip });
}

/** Hear one job's progress until the returned function is called. */
export function onTrashProgress(jobId: string, handler: (progress: TrashProgress) => void): Promise<UnlistenFn> {
  return listen<TrashProgress>(TRASH_PROGRESS_EVENT, (event) => {
    if (event.payload.jobId === jobId) handler(event.payload);
  });
}
