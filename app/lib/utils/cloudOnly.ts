import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { REMOTE_SOURCE_PREFIX } from "@/app/lib/hooks/use-nested-folder-listing";

/**
 * True when a row has NO local copy on this machine:
 *
 * - a cloud-only search/browse hit (`fileId` set, no `source`),
 * - a `pending` hit — the drive is configured here but the bytes aren't
 *   down yet; such rows carry the *would-be* local path in `source`, so
 *   `source` alone lies (mirrors `downloadFile.ts` / `planThumbnail`'s
 *   `pendingCloud` discriminant),
 * - any row inside a browsable REMOTE drive (folder rows there carry the
 *   `remote://<label>` sentinel source).
 *
 * Owns the "is there anything on disk?" question for action gating:
 * disk-backed actions (Reveal in Finder, local delete, folder zip
 * download, rename) hide behind it, and cloud-capable actions (per-file
 * download, preview, share) pick their remote path with it.
 */
export function isCloudOnlyRow(file: FormattedUserFile): boolean {
  if (file.fileId && !file.source) return true;
  if (file.fileId && file.syncStatus === "pending") return true;
  return Boolean(file.source?.startsWith(REMOTE_SOURCE_PREFIX));
}
