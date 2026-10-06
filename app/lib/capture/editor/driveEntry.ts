import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";

/**
 * Whether a Drive row offers "Edit image". Only a picture the editor can
 * save back in its own format (Rust's `EditableFormat`: PNG and JPEG), in an
 * own drive synced on this computer: the editor writes over the local file
 * and the sync engine uploads it. Rust checks all of this again when the
 * editor opens; this only keeps an item off the menu that would be refused.
 */
const EDITABLE = /\.(png|jpe?g)$/i;

export function isEditableImageName(name: string): boolean {
  return EDITABLE.test(name);
}

export interface EditorRow {
  name: string;
  isFolder: boolean;
  label?: string | null;
  /** The row has no copy on this computer. */
  cloudOnly: boolean;
  /** The row is in a drive shared with this account. */
  memberDrive: boolean;
}

export function offersImageEditor(row: EditorRow, enabled: boolean = SCREEN_CAPTURE_ENABLED): boolean {
  return enabled && !row.isFolder && Boolean(row.label) && !row.cloudOnly && !row.memberDrive && isEditableImageName(row.name);
}
