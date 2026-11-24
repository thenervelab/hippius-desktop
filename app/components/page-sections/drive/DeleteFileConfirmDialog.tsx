"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import ConfirmationDialog from "@/app/components/ConfirmationDialog";
import { useDeleteFile } from "@/app/lib/hooks/use-delete-file";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { deleteShareLinksNote } from "./deleteShareLinksNote";
import TurnOffLinksOption from "./TurnOffLinksOption";
import { useCaptureLinkTokens } from "./useCaptureInsightsItem";
import { useDeleteMode, useSkipTrash } from "@/app/lib/trash/deleteMode";
import { DELETE_FOREVER_BUTTON, DELETE_FOREVER_TITLE, deleteForeverText } from "@/app/lib/trash/copy";

/**
 * Confirm, then delete ONE file through the Drive's own `delete_files` call
 * (`useDeleteFile`: its toasts, its refresh of every file list). For surfaces
 * that have no Drive selection bar to route a delete through: the sidebar
 * search's viewer and the tray popover's row menu (`TrayFileActionHost`).
 *
 * Renders nothing while `file` is null. `onClose` runs on Cancel and once
 * the delete settles; it is ignored while the delete is running.
 *
 * With Trash on, the file moves to Trash at once with no dialog (Undo is in
 * the toast), unless Option is held or Trash is skipped in Settings: then
 * this asks "Delete forever?". With Trash off, today's dialog, unchanged.
 */
export default function DeleteFileConfirmDialog({
  file,
  onClose,
}: {
  file: FormattedUserFile | null;
  onClose: () => void;
}) {
  const deleteMutation = useDeleteFile({ files: file ? [file] : [] });
  const isDeleting = deleteMutation.isPending;
  // A capture's links, found the way its Insights find them, and "Also
  // turn off its links", ticked by default (a new file is a new dialog).
  const linkTokens = useCaptureLinkTokens();
  const links = useMemo(() => (file ? linkTokens(file) : []), [file, linkTokens]);
  const [turnOff, setTurnOff] = useState(true);
  const mode = useDeleteMode();
  const { loaded: skipKnown } = useSkipTrash();
  // The mode the file arrived under: Option let go later changes nothing.
  const [arrivedMode, setArrivedMode] = useState<typeof mode | null>(null);
  const trashed = useRef<FormattedUserFile | null>(null);
  useEffect(() => {
    if (!file) {
      setArrivedMode(null);
      trashed.current = null;
      return;
    }
    if (arrivedMode === null && (mode === "legacy" || skipKnown)) setArrivedMode(mode);
  }, [file, mode, skipKnown, arrivedMode]);
  useEffect(() => {
    if (!file || arrivedMode !== "trash" || trashed.current === file) return;
    trashed.current = file;
    deleteMutation.mutate({ mode: "trash" }, { onSettled: onClose });
  }, [file, arrivedMode, deleteMutation, onClose]);

  const close = useCallback(() => {
    if (isDeleting) return;
    onClose();
  }, [isDeleting, onClose]);

  const confirm = useCallback(() => {
    const turnOffLinks = file && turnOff && links.length > 0 ? new Map([[file, links]]) : undefined;
    deleteMutation.mutate({ turnOffLinks, mode: arrivedMode ?? undefined }, { onSettled: onClose });
  }, [deleteMutation, onClose, file, turnOff, links, arrivedMode]);

  if (!file || arrivedMode === null || arrivedMode === "trash") return null;
  const forever = arrivedMode === "forever";
  const name = (file.actualFileName || file.name).split("/").pop() || file.name;
  return (
    <ConfirmationDialog
      open
      onClose={close}
      onBack={close}
      onConfirm={confirm}
      heading={forever ? DELETE_FOREVER_TITLE : "Delete File"}
      text={
        forever ? (
          deleteForeverText([name])
        ) : (
          <>
            Are you sure you want to delete &quot;
            {file.actualFileName || file.name}&quot;? This action cannot be
            undone.
          </>
        )
      }
      // The box says what happens to the links when there are any to find.
      helperText={links.length > 0 ? undefined : deleteShareLinksNote([file])}
      button={isDeleting ? "Deleting..." : forever ? DELETE_FOREVER_BUTTON : "Delete File"}
      icon={<Trash2 className="size-[18px] text-white" strokeWidth={2.5} />}
      iconBgColor="bg-[#fc7d73]"
      confirmVariant="destructive"
      disableButton={isDeleting}
      disableBackButton={isDeleting}
    >
      <TurnOffLinksOption
        checked={turnOff}
        onChange={setTurnOff}
        linkCount={links.length}
        multiple={false}
        disabled={isDeleting}
      />
    </ConfirmationDialog>
  );
}
