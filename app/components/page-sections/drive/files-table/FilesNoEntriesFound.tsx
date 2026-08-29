import NoEntriesFound from "@/components/ui/NoEntriesFound";
import React, { useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

// Custom events for communicating with AddButton
const HIPPIUS_DROP_EVENT = "hippius:file-drop";
const HIPPIUS_OPEN_MODAL_EVENT = "hippius:open-modal";

interface FilesNoEntriesFoundProps {
  isRecentFiles?: boolean;
  isSyncPathConfigured?: boolean;
  isCheckingSyncPath?: boolean;
  /** When true (and sync is already configured), shows the "Add Credits"
   *  variant instead of the upload CTA. Sync-setup CTA still wins when
   *  the sync path itself isn't configured yet. */
  hasNoCredits?: boolean;
  /** Browsing a remote (server-only) folder. Remote folders cannot be
   *  uploaded into from the desktop yet, so the empty state renders as a
   *  plain "folder is empty" notice — no upload button, no drop target. */
  isRemoteView?: boolean;
  onStartSyncing?: () => void;
}

const FilesNoEntriesFound: React.FC<FilesNoEntriesFoundProps> = ({
  isRecentFiles = false,
  isSyncPathConfigured = true,
  isCheckingSyncPath = false,
  hasNoCredits = false,
  isRemoteView = false,
  onStartSyncing,
}) => {
  const router = useRouter();
  // Show the no-credits variant whenever credits are zero, regardless of
  // sync-folder state — without credits nothing else is actionable, so
  // the "Add Credits" CTA wins over both upload and start-syncing CTAs.
  const showNoCreditsVariant = hasNoCredits;
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
    // No credits — send the user to the plans page to top up. Checked
    // FIRST so the button copy ("Add Credits") matches the click
    // destination even when sync isn't configured yet.
    if (showNoCreditsVariant) {
      router.push("/billing");
      return;
    }

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
  }, [isSyncPathConfigured, showNoCreditsVariant, router, onStartSyncing]);

  // Remote folders are read-only from the desktop for now: uploading into
  // one is not supported yet, so the empty state must not offer an upload
  // button or a drop target — a plain notice is the whole surface. Sits
  // after the hooks so the hook order never varies between renders.
  if (isRemoteView) {
    return (
      <NoEntriesFound
        title="This Folder Is Empty"
        description="Files added to this folder from your other devices will appear here."
        className="p-4 sm:p-8 2xl:p-16"
      />
    );
  }

  const title = showNoCreditsVariant
    ? "You don't have enough credit to upload a file"
    : isRecentFiles
      ? "No Recent files yet"
      : "No Entries in Your Storage";

  const description = showNoCreditsVariant
    ? "Please add credits to upload your files"
    : !isSyncPathConfigured
      ? isRecentFiles
        ? "Please set up sync path first"
        : "You need to select a sync path for your files before uploading."
      : isRecentFiles
        ? "Start by uploading a file to see it here."
        : "You currently do not have any entries uploaded to Hippius. Drop files here or use the button.";

  const dragDescription = showNoCreditsVariant
    ? "Please add credits to upload your files"
    : !isSyncPathConfigured
      ? "Please set up sync path first"
      : "Drop files here to upload";

  const buttonText = showNoCreditsVariant
    ? "+ Add Credits"
    : !isSyncPathConfigured
      ? "Start Syncing"
      : "Upload a File";

  return (
    <NoEntriesFound
      variant={showNoCreditsVariant ? "noCredits" : "default"}
      title={title}
      description={description}
      dragDescription={dragDescription}
      buttonText={buttonText}
      onButtonClick={handlePrimaryClick}
      onFileDrop={
        isRecentFiles || showNoCreditsVariant ? undefined : handleFiles
      }
      isLoading={isCheckingSyncPath}
      className="p-4 sm:p-8 2xl:p-16"
    />
  );
};

export default FilesNoEntriesFound;
