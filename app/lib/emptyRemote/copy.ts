// The empty-drive prompt's words that are not Rust's: the buttons and the
// confirmation around them. The banner's title and lines come from Rust
// (`empty_remote::empty_remote_text`). Presentation only: every fact in
// them (count, label, who may confirm) comes from Rust's payload.

import type { EmptyRemoteView } from "@/app/lib/emptyRemote/drives";

/** "1 file" / "1,234 files", grouped as Rust's `group_thousands`. */
function files(count: number): string {
  return `${count.toLocaleString("en-US")} file${count === 1 ? "" : "s"}`;
}

/** The safe answer: change nothing and leave the drive on hold. */
export const KEEP_LABEL = "Keep my files";

/** The owner's first step towards removing the local copies. */
export const CONFIRM_LABEL = "The drive really is empty";

/** The second confirmation before the local copies are removed. */
export function confirmCopy(
  drive: EmptyRemoteView,
  device: string,
): { title: string; description: string; confirm: string } {
  return {
    title: `Remove ${files(drive.syncedCount)} from ${device}?`,
    description:
      `Only do this if you emptied “${drive.label}” on purpose. ` +
      `${files(drive.syncedCount)} in this drive will be deleted from ${device} to match Hippius. ` +
      "This cannot be undone from Hippius Desktop.",
    confirm: `Remove ${files(drive.syncedCount)}`,
  };
}

/** The banner's line while a confirmation is being applied. */
export function confirmingCopy(drive: EmptyRemoteView, device: string): string {
  return `Removing ${files(drive.syncedCount)} from ${device}…`;
}
