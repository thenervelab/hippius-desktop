// The toast after a Move to Trash, with Undo. Undo restores the items and
// puts the held copies back (Rust, `undo_move_to_trash`); once the toast
// closes any other way the held copies are released.

import { toast } from "sonner";
import { releaseTrashHold, undoMoveToTrash, type MoveToTrashResult } from "@/app/lib/tauri/trash";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { movedToTrashMessage, retentionDays, retentionNotice, undoneMessage } from "./copy";

/** How long Undo stays offered. */
export const UNDO_TOAST_MS = 8000;

/** The note under the toast for items that did not go to Trash. */
export function failedNote(failed: MoveToTrashResult["failed"]): string | undefined {
  if (failed.length === 0) return undefined;
  if (failed.length === 1) return failed[0].error;
  return `${failed.length.toLocaleString("en-US")} items couldn't be moved to Trash.`;
}

export function showMovedToTrashToast({
  toastId,
  names,
  result,
  accountId,
  onChanged,
}: {
  toastId?: string | number;
  names: string[];
  result: MoveToTrashResult;
  accountId: string;
  onChanged: () => Promise<unknown> | void;
}): void {
  const hold = result.hold;
  let settled = false;
  const release = () => {
    if (settled || !hold) return;
    settled = true;
    void releaseTrashHold(hold).catch(() => undefined);
  };
  const undo = async () => {
    if (settled || !hold) return;
    settled = true;
    const pending = toast.loading("Putting back…");
    try {
      const back = await undoMoveToTrash(accountId, hold);
      const message = undoneMessage(back.restored, back.leftInTrash);
      if (back.leftInTrash > 0) toast.warning(message.title, { id: pending, description: message.description });
      else toast.success(message.title, { id: pending });
    } catch (err) {
      toast.error("Couldn't undo", { id: pending, description: errorMessage(err) });
    } finally {
      await onChanged();
    }
  };
  toast.success(movedToTrashMessage(names, result.trashed), {
    id: toastId,
    duration: UNDO_TOAST_MS,
    description: [failedNote(result.failed), retentionNotice(retentionDays(result.retentionDays))].filter(Boolean).join(" "),
    action: result.undoable && hold ? { label: "Undo", onClick: () => void undo() } : undefined,
    onAutoClose: release,
    onDismiss: release,
  });
}
