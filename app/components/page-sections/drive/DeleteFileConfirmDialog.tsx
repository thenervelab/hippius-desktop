"use client";

import { useCallback, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import ConfirmationDialog from "@/app/components/ConfirmationDialog";
import { useDeleteFile } from "@/app/lib/hooks/use-delete-file";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { deleteShareLinksNote } from "./deleteShareLinksNote";
import TurnOffLinksOption from "./TurnOffLinksOption";
import { useCaptureLinkTokens } from "./useCaptureInsightsItem";

/**
 * Confirm, then delete ONE file through the Drive's own `delete_files` call
 * (`useDeleteFile`: its toasts, its refresh of every file list). For surfaces
 * that have no Drive selection bar to route a delete through: the sidebar
 * search's viewer and the tray popover's row menu (`TrayFileActionHost`).
 *
 * Renders nothing while `file` is null. `onClose` runs on Cancel and once
 * the delete settles; it is ignored while the delete is running.
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

  const close = useCallback(() => {
    if (isDeleting) return;
    onClose();
  }, [isDeleting, onClose]);

  const confirm = useCallback(() => {
    const turnOffLinks = file && turnOff && links.length > 0 ? new Map([[file, links]]) : undefined;
    deleteMutation.mutate({ turnOffLinks }, { onSettled: onClose });
  }, [deleteMutation, onClose, file, turnOff, links]);

  if (!file) return null;
  return (
    <ConfirmationDialog
      open
      onClose={close}
      onBack={close}
      onConfirm={confirm}
      heading="Delete File"
      text={
        <>
          Are you sure you want to delete &quot;
          {file.actualFileName || file.name}&quot;? This action cannot be
          undone.
        </>
      }
      // The box says what happens to the links when there are any to find.
      helperText={links.length > 0 ? undefined : deleteShareLinksNote([file])}
      button={isDeleting ? "Deleting..." : "Delete File"}
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
