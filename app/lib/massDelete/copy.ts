// The large-delete prompt's words, by side. Presentation only: every fact in
// them (side, counts, empty root, member) comes from Rust's hold. The
// persisted notification's text is Rust's own (`held_notification_text`);
// these lines say the same things in the banner's shorter form.

import type { MassDeleteSide } from "@/app/lib/tauri/massDelete";
import type { MassDeleteHoldView, MassDeleteRefusal } from "@/app/lib/massDelete/holds";
import { formatBytes } from "@/app/lib/utils/formatBytes";

/** What the user's machine is called, matching Rust's `THIS_DEVICE`. */
export function deviceName(isMac: boolean): string {
  return isMac ? "this Mac" : "this computer";
}

function files(count: number): string {
  return `${count.toLocaleString()} file${count === 1 ? "" : "s"}`;
}

export interface HoldCopy {
  title: string;
  body: string[];
  /** Label of the destructive button. */
  removeLabel: string;
}

/** The banner's title, body lines and Remove label for a hold. */
export function holdCopy(hold: MassDeleteHoldView, device: string): HoldCopy {
  if (hold.side === "server") {
    const body = ["Nothing has been deleted from Hippius yet."];
    if (hold.emptyRoot) {
      body.push("If an external disk or cloud folder is disconnected, reconnect it.");
    }
    return {
      title: `${hold.count.toLocaleString()} of ${files(hold.syncedCount)} in “${hold.label}” are missing from ${device}`,
      body,
      removeLabel: "Remove from Hippius",
    };
  }

  const body = [`Nothing has been deleted from ${device} yet.`];
  if (hold.canRestore) {
    // A folder renamed or moved on another device reads here as its files
    // missing from Hippius; restoring cannot tell, and uploads the old copies.
    body.push(
      "If you renamed or moved the folder on another device, restoring uploads the old copies again.",
    );
  } else {
    body.push("Only the owner of this shared drive can put them back on Hippius.");
  }
  return {
    title: `${files(hold.count)} in “${hold.label}” are missing from Hippius`,
    body,
    removeLabel: `Remove from ${device}`,
  };
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

/** Why a restore did not run, in words the user can act on. */
export function refusalCopy(refusal: MassDeleteRefusal, device: string): string {
  if (refusal.reason === "insufficient_space") {
    const needed =
      refusal.neededBytes !== null ? ` (${formatBytes(refusal.neededBytes)} needed)` : "";
    return `There is not enough free space on ${device} to restore these files${needed}. Free up space; the restore continues once they fit.`;
  }
  return "Hippius could not restore these files yet. Nothing has been deleted.";
}

/** The success toast after a restore cycle. */
export function restoredToastCopy(
  label: string,
  side: MassDeleteSide,
  counts: { restored: number; pending: number; skipped: number },
): { title: string; description: string | undefined } {
  const where = side === "server" ? "downloaded" : "uploaded";
  const parts: string[] = [];
  if (counts.pending > 0) parts.push(`${files(counts.pending)} still being ${where}.`);
  if (counts.skipped > 0) parts.push(`${files(counts.skipped)} were already back.`);
  return {
    title: `Restored ${files(counts.restored)} in “${label}”`,
    description: parts.length > 0 ? parts.join(" ") : undefined,
  };
}
