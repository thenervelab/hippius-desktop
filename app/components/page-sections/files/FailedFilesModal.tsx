"use client";

import { useCallback } from "react";
import { useAtom } from "jotai";
import * as Dialog from "@radix-ui/react-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import DialogContainer from "@/components/ui/DialogContainer";
import { failedFilesAtom, type FailedFileInfo } from "@/lib/store/syncAtoms";
import { getFileIcon } from "@/lib/utils/fileTypeUtils";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { getFilePartsFromFileName } from "@/lib/utils";
import MiddleTruncatedName from "@/components/ui/MiddleTruncatedName";

function FileRow({
  file,
  onAction,
}: {
  file: FailedFileInfo;
  onAction: (file: FailedFileInfo, action: "retry" | "skip" | "exclude") => void;
}) {
  const { fileFormat } = getFilePartsFromFileName(file.fileName);
  const fileType = getFileTypeFromExtension(fileFormat || null) ?? undefined;
  const { icon: Icon, color } = getFileIcon(fileType, false);

  return (
    <div className="flex items-center gap-3 py-3 px-4 border-b border-grey-80 last:border-b-0">
      <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center">
        <Icon className={`w-6 h-6 ${color}`} />
      </div>

      <div className="flex-1 min-w-0">
        <MiddleTruncatedName
          name={file.fileName}
          className="text-sm font-medium text-grey-10"
        />
        {file.error && (
          <p className="text-xs text-grey-50 truncate mt-0.5">{file.error}</p>
        )}
        <p className="text-xs text-grey-60 mt-0.5">{file.label}</p>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          type="button"
          onClick={() => onAction(file, "retry")}
          className="px-3 py-1 text-xs font-medium rounded border border-grey-70 text-grey-20 hover:bg-grey-90 transition-colors"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={() => onAction(file, "skip")}
          className="px-3 py-1 text-xs font-medium rounded border border-grey-70 text-grey-20 hover:bg-grey-90 transition-colors"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={() => onAction(file, "exclude")}
          className="px-3 py-1 text-xs font-medium rounded border border-error-80 text-error-50 hover:bg-error-100/20 transition-colors"
          title="Permanently exclude this file from sync"
        >
          Exclude
        </button>
      </div>
    </div>
  );
}

export default function FailedFilesModal() {
  const [failedFiles, setFailedFiles] = useAtom(failedFilesAtom);
  const open = failedFiles !== null && failedFiles.length > 0;

  const handleAction = useCallback(
    async (file: FailedFileInfo, action: "retry" | "skip" | "exclude") => {
      try {
        if (action === "retry") {
          await invoke("sp_retry_file", { label: file.label, path: file.path });
          toast.success("File will retry on next sync cycle", { duration: 4000 });
        } else if (action === "skip") {
          await invoke("sp_skip_file", { label: file.label, path: file.path });
          toast.success("File skipped for this session", { duration: 4000 });
        } else if (action === "exclude") {
          await invoke("sp_exclude_file", { label: file.label, path: file.path });
          toast.success("File permanently excluded from sync", { duration: 4000 });
        }
      } catch (err) {
        toast.error(`Failed to ${action} file: ${err}`);
        return;
      }

      // Remove the file from the list
      setFailedFiles((prev) => {
        if (!prev) return null;
        const updated = prev.filter(
          (f) => !(f.label === file.label && f.path === file.path)
        );
        return updated.length > 0 ? updated : null;
      });
    },
    [setFailedFiles]
  );

  const handleDismiss = useCallback(() => {
    setFailedFiles(null);
  }, [setFailedFiles]);

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && handleDismiss()}>
      <DialogContainer className="sm:max-w-[30rem] sm:mx-auto">
        <div className="p-6">
          {/* Header */}
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-grey-10">Sync Issues</h2>
            <p className="text-sm text-grey-50 mt-1">
              These files have failed to sync after multiple attempts.
            </p>
          </div>

          {/* File list */}
          <div className="max-h-[24rem] overflow-y-auto border border-grey-80 rounded">
            {failedFiles?.map((file) => (
              <FileRow
                key={`${file.label}/${file.path}`}
                file={file}
                onAction={handleAction}
              />
            ))}
          </div>

          {/* Footer */}
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={handleDismiss}
              className="px-4 py-2 text-sm font-medium rounded border border-grey-70 text-grey-20 hover:bg-grey-90 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
}
