// The large-delete prompt's words that are not the hold's own. The banner's
// title and lines come from Rust with the hold (`hold.title`, `hold.body`,
// from `mass_delete_hold::hold_text`), the same words the persisted
// notification uses; these are the buttons, the confirmation and the
// progress lines around them. Presentation only: every fact in them (side,
// counts, member) comes from Rust's hold.

import type { MassDeleteSide } from "@/app/lib/tauri/massDelete";
import type { MassDeleteHoldView, MassDeleteRefusal } from "@/app/lib/massDelete/holds";
import { formatBytes } from "@/app/lib/utils/formatBytes";

/** What the user's machine is called, matching Rust's `THIS_DEVICE`. */
export function deviceName(isMac: boolean): string {
  return isMac ? "this Mac" : "this computer";
}

/** "1 file" / "1,234 files": grouped as Rust's `group_thousands` writes
 *  counts, whatever the system locale, so a count reads the same in the
 *  banner title and the lines around it. */
function files(count: number): string {
  return `${count.toLocaleString("en-US")} file${count === 1 ? "" : "s"}`;
}

/** Label of the destructive button. */
export function removeLabel(side: MassDeleteSide, device: string): string {
  return side === "server" ? "Remove from Hippius" : `Remove from ${device}`;
}

/** The Remove confirmation's title and description. */
export function removeConfirmCopy(
  hold: MassDeleteHoldView,
  device: string,
): { title: string; description: string; confirm: string } {
  const where = hold.side === "server" ? "Hippius" : device;
  const lines = [
    hold.side === "server"
      ? `${files(hold.count)} will be deleted from Hippius, on every device that syncs “${hold.label}”.`
      : `${files(hold.count)} will be deleted from ${device}.`,
  ];
  if (hold.side === "local" && !hold.canRestore) {
    lines.push(
      "This is a shared drive you are a member of: once removed, you cannot put these files back yourself.",
    );
  }
  lines.push("This cannot be undone from Hippius Desktop.");
  return {
    title: `Remove ${files(hold.count)} from ${where}?`,
    description: lines.join(" "),
    confirm: `Remove ${files(hold.count)}`,
  };
}

/** The banner's line while an answer or a restore is being applied. */
export function progressCopy(hold: MassDeleteHoldView): string | null {
  if (hold.state === "restoring" || hold.requested === "restore") {
    return `Restoring ${files(hold.count)}…`;
  }
  if (hold.requested === "remove") return `Removing ${files(hold.count)}…`;
  return null;
}

/**
 * Why a restore did not run, in words the user can act on. hcfs measures the
 * space on the volume that holds the drive folder, which may be an external
 * disk, so the copy names that disk rather than the device.
 */
export function refusalCopy(refusal: MassDeleteRefusal): string {
  if (refusal.reason === "insufficient_space") {
    const needed =
      refusal.neededBytes !== null ? ` (${formatBytes(refusal.neededBytes)} needed)` : "";
    return `There is not enough free space on the disk that holds your Hippius folder to restore these files${needed}. Free up space; the restore continues once they fit.`;
  }
  return "Hippius could not restore these files yet. Nothing has been deleted.";
}

/** "1 file is" / "3 files are", and the like. */
function filesVerb(count: number, singular: string, plural: string): string {
  return `${files(count)} ${count === 1 ? singular : plural}`;
}

/**
 * The toast after a cycle applied a restore. hcfs reports it whatever the
 * counts: `restored` finished this cycle, `pending` started and finish on
 * later cycles, and `skipped` no longer looked deleted and were left to
 * ordinary sync. A restore with nothing finished yet is still under way,
 * so it is never titled "Restored 0 files".
 */
export function restoredToastCopy(
  label: string,
  side: MassDeleteSide,
  counts: { restored: number; pending: number; skipped: number },
): { title: string; description: string | undefined } {
  const where = side === "server" ? "downloaded" : "uploaded";
  const stillRestoring = counts.restored === 0 && counts.pending > 0;
  const parts: string[] = [];
  if (counts.pending > 0 && !stillRestoring) {
    parts.push(`${filesVerb(counts.pending, "is", "are")} still being ${where}.`);
  }
  if (counts.skipped > 0) {
    parts.push(`${filesVerb(counts.skipped, "was", "were")} left to normal sync.`);
  }

  let title = `Restored ${files(counts.restored)} in “${label}”`;
  if (stillRestoring) title = `Restoring ${files(counts.pending)} in “${label}”…`;
  else if (counts.restored === 0) title = `Restore finished in “${label}”`;
  return { title, description: parts.length > 0 ? parts.join(" ") : undefined };
}
