import NoEntriesFound from "@/components/ui/NoEntriesFound";
import { IS_SYNC_PAUSED } from "@/components/ui";
import React, { useCallback } from "react";
import { toast } from "sonner";

// Custom events for communicating with AddButton
const HIPPIUS_DROP_EVENT = "hippius:file-drop";
const HIPPIUS_OPEN_MODAL_EVENT = "hippius:open-modal";

interface FilesNoEntriesFoundProps {
  isRecentFiles?: boolean;
  isSyncPathConfigured?: boolean;
  isCheckingSyncPath?: boolean;
  onStartSyncing?: () => void;
}

const FilesNoEntriesFound: React.FC<FilesNoEntriesFoundProps> = ({
  isRecentFiles = false,
  isSyncPathConfigured = true,
  isCheckingSyncPath = false,
  onStartSyncing,
}) => {
  const handleFiles = useCallback(
    (files: FileList) => {
      if (files.length === 0) {
        toast.error("No Files Found");
        return;
      }

      if (!isRecentFiles && !isSyncPathConfigured) {
        toast.error("Please select a sync path before uploading.");
        return;
      }

      if (typeof window !== "undefined") {
        const event = new CustomEvent(HIPPIUS_DROP_EVENT, {
          detail: { files },
        });
        window.dispatchEvent(event);
        toast.success(
          `${files.length} ${files.length === 1 ? "file" : "files"} ready to upload`,
        );
      }
    },
    [isRecentFiles, isSyncPathConfigured],
  );

  const handlePrimaryClick = useCallback(() => {
    if (IS_SYNC_PAUSED) return;

    // If sync path is not configured, route to the start-syncing flow.
    if (!isSyncPathConfigured) {
      onStartSyncing?.();
      return;
    }

    // Otherwise, ask the AddButton to open the upload modal.
    if (typeof window !== "undefined") {
      const event = new CustomEvent(HIPPIUS_OPEN_MODAL_EVENT, {
        bubbles: true,
        detail: { source: "no-entries-button" },
      });
      window.dispatchEvent(event);
    }
  }, [isSyncPathConfigured, onStartSyncing]);

  const title = isRecentFiles
    ? "No Recent files yet"
    : "No Entries in Your Storage";

  const description = !isSyncPathConfigured
    ? isRecentFiles
      ? "Please set up sync path first"
      : "You need to select a sync path for your files before uploading."
    : isRecentFiles
      ? "Start by uploading a file to see it here."
      : "You currently do not have any entries uploaded to Hippius. Drop files here or use the button.";

  const dragDescription = !isSyncPathConfigured
    ? "Please set up sync path first"
    : "Drop files here to upload";

  const buttonText = !isSyncPathConfigured ? "Start Syncing" : "Upload a File";

  return (
    <NoEntriesFound
      title={title}
      description={description}
      dragDescription={dragDescription}
      buttonText={buttonText}
      onButtonClick={handlePrimaryClick}
      onFileDrop={isRecentFiles ? undefined : handleFiles}
      isLoading={isCheckingSyncPath}
      className="p-4 sm:p-8 2xl:p-16"
    />
  );
};

export default FilesNoEntriesFound;
