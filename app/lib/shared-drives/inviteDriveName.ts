/**
 * Human name for the invite / share-access surfaces.
 *
 * The browse label for an unsynced shared drive is a synthetic
 * `shared:<owner>~<hash>` wire id. Putting that in a dialog title overflows
 * the framed card and reads as a bug. Prefer the display basename; never
 * surface the raw shared: label.
 */

import { isSharedDriveLabel } from "./sharedDriveLabel";

/**
 * Pick a drive name safe for dialog titles and panel subtitles.
 *
 * Prefers `folderName` when it is a real basename; falls back to `label`
 * when that is also human; otherwise `"this drive"`.
 */
export function inviteDriveDisplayName(
  folderName: string | null | undefined,
  label?: string | null,
): string {
  const name = folderName?.trim();
  if (name && !isSharedDriveLabel(name)) return name;

  const fallback = label?.trim();
  if (fallback && !isSharedDriveLabel(fallback)) return fallback;

  return "this drive";
}
