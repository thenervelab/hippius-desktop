/**
 * Who added a file, as the ADDED BY column says it, and which files each
 * choice in the "Added by" filter therefore has to return.
 *
 * The column and the filter used to answer this separately. The column draws
 * a file with no uploader recorded as the owner's (see `UploaderCell`), while
 * the filter sent the owner's address to the server as an exact match, which
 * by design never matches a row with nothing recorded (hcfs #456). In a drive
 * whose files all predate attribution every row read "Owner" and picking the
 * owner found nothing. Both sides now read the same rules from here, and
 * Rust asks the server with the same rule (`uploader_search_values` in
 * `sync/fileops/recent_uploads.rs`): the owner is two queries, the address
 * and the unrecorded sentinel, merged in the server's order.
 */

import { sameAccount } from "@/lib/utils/ss58";

/**
 * `uploaded_by` value selecting the files with no uploader recorded: rows
 * that predate attribution, and admin-tool writes (hcfs #456). Safe as a
 * sentinel because `_` is not in the base58 alphabet, so no account can be
 * called this.
 */
export const UPLOADED_BY_UNRECORDED = "_none";

/** How the ADDED BY column names one row. */
export type UploaderKind =
  /** A folder: nobody added it, it is where its files live. */
  | "folder"
  /** Uploaded by the person looking at the page. */
  | "you"
  /** Uploaded by the drive's owner, recorded as such. */
  | "owner"
  /** Nothing recorded, drawn as the owner's (muted). */
  | "owner-unrecorded"
  /** Nothing recorded and no owner to fall back on: a dash. */
  | "unknown"
  /** Anybody else, by name or address. */
  | "member";

export interface UploaderContext {
  /** The viewer's ss58. */
  sessionSs58?: string;
  /** The drive's owner. */
  driveOwnerSs58?: string;
}

export interface UploaderRow {
  uploadedBy?: string | null;
  isFolder?: boolean;
}

/** Same account, whatever ss58 prefix each side was written in. */
export function isSameUploader(a: string | null | undefined, b: string | null | undefined): boolean {
  return sameAccount(a, b);
}

export function uploaderKind(file: UploaderRow, { sessionSs58, driveOwnerSs58 }: UploaderContext): UploaderKind {
  if (file.isFolder) return "folder";
  if (!file.uploadedBy) return driveOwnerSs58 ? "owner-unrecorded" : "unknown";
  // Ahead of the owner check: an owner reading their own drive should still
  // read as "You".
  if (isSameUploader(file.uploadedBy, sessionSs58)) return "you";
  if (isSameUploader(file.uploadedBy, driveOwnerSs58)) return "owner";
  return "member";
}

/**
 * Whether the filter's choice `selected` (an option's value: an ss58 or
 * `UPLOADED_BY_UNRECORDED`) covers this row, judged by what the column shows.
 *
 * - The viewer ("You"): rows the column calls "You".
 * - The owner: every row the column calls "Owner", recorded or not.
 * - "Not recorded (shown as Owner)": only the unrecorded ones.
 * - Anybody else: rows recorded as theirs.
 */
export function matchesUploader(file: UploaderRow, selected: string | undefined, ctx: UploaderContext): boolean {
  if (!selected) return true;
  const kind = uploaderKind(file, ctx);
  if (kind === "folder") return false;
  if (selected === UPLOADED_BY_UNRECORDED) return !file.uploadedBy;
  if (isSameUploader(selected, ctx.sessionSs58)) return kind === "you";
  if (isSameUploader(selected, ctx.driveOwnerSs58)) return kind === "owner" || kind === "owner-unrecorded";
  return kind === "member" && isSameUploader(file.uploadedBy, selected);
}
