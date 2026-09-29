import NoEntriesFound from "@/components/ui/NoEntriesFound";
import React, { useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BILLING_ROUTE } from "@/app/lib/routes";
import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { getUploadBlockReason } from "@/app/components/page-sections/drive/uploadRoomState";
import { NO_PLAN_RETENTION_DAYS } from "@/app/components/page-sections/drive/service-status/driveStatusBannerState";

// Custom events for communicating with AddButton
const HIPPIUS_DROP_EVENT = "hippius:file-drop";
const HIPPIUS_OPEN_MODAL_EVENT = "hippius:open-modal";

interface FilesNoEntriesFoundProps {
  isRecentFiles?: boolean;
  isSyncPathConfigured?: boolean;
  isCheckingSyncPath?: boolean;
  /** When true (and sync is already configured), shows the out-of-storage
   *  variant instead of the upload CTA. Sync-setup CTA still wins when
   *  the sync path itself isn't configured yet. */
  isStorageFull?: boolean;
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
  isStorageFull = false,
  isRemoteView = false,
  onStartSyncing,
}) => {
  const router = useRouter();
  const { data: overview } = useStorageOverview();
  const blockReason = getUploadBlockReason(overview);
  // Show the out-of-storage variant whenever the plan has no room left,
  // regardless of sync-folder state — with nowhere to put a file nothing
  // else is actionable, so this CTA wins over upload and start-syncing.
  const showStorageFullVariant = isStorageFull;
  const isNoPlan = blockReason === "no-plan" || overview?.source === "none";
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
    // Out of room, so send the user to the plans page. Checked FIRST so
    // the button copy matches the click destination even when sync isn't
    // configured yet.
    if (showStorageFullVariant) {
      router.push(BILLING_ROUTE);
      return;
    }

    if (!isSyncPathConfigured) {
      onStartSyncing?.();
      return;
    }

    if (typeof window !== "undefined") {
      const event = new CustomEvent(HIPPIUS_OPEN_MODAL_EVENT, {
        bubbles: true,
        detail: { source: "no-entries-button" },
      });
      window.dispatchEvent(event);
    }
  }, [isSyncPathConfigured, showStorageFullVariant, router, onStartSyncing]);

  if (isRemoteView) {
    return (
      <NoEntriesFound
        title="This Folder Is Empty"
        description="Files added to this folder from your other devices will appear here."
        className="p-4 sm:p-8 2xl:p-16"
      />
    );
  }

  const title = showStorageFullVariant
    ? isNoPlan
      ? "You don't have a subscription plan"
      : "You've used all the storage in your plan"
    : isRecentFiles
      ? "No Recent files yet"
      : "No Entries in Your Storage";

  // Match Overview / Drive banners: no-plan carries the 30-day deletion
  // clock; over-quota keeps files and only pauses uploads.
  const description = showStorageFullVariant
    ? isNoPlan
      ? `Your account has no storage. Files you have already uploaded are permanently deleted after ${NO_PLAN_RETENTION_DAYS} days without a plan, and nothing new can be uploaded until you subscribe.`
      : "Uploads are paused, your files stay available. Upgrade or free up space."
    : !isSyncPathConfigured
      ? isRecentFiles
        ? "Please set up sync path first"
        : "You need to select a sync path for your files before uploading."
      : isRecentFiles
        ? "Start by uploading a file to see it here."
        : "You currently do not have any entries uploaded to Hippius. Drop files here or use the button.";

  const dragDescription = showStorageFullVariant
    ? isNoPlan
      ? "Subscribe to a plan to upload files"
      : "Upgrade your plan to upload more files"
    : !isSyncPathConfigured
      ? "Please set up sync path first"
      : "Drop files here to upload";

  const buttonText = showStorageFullVariant
    ? isNoPlan
      ? "Subscribe"
      : "Upgrade"
    : !isSyncPathConfigured
      ? "Start Syncing"
      : "Upload a File";

  return (
    <NoEntriesFound
      variant={showStorageFullVariant ? "noCredits" : "default"}
      title={title}
      description={description}
      dragDescription={dragDescription}
      buttonText={buttonText}
      onButtonClick={handlePrimaryClick}
      onFileDrop={
        isRecentFiles || showStorageFullVariant ? undefined : handleFiles
      }
      isLoading={isCheckingSyncPath}
      className="p-4 sm:p-8 2xl:p-16"
    />
  );
};

export default FilesNoEntriesFound;
