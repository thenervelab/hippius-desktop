"use client";

import React, { useState } from "react";
import { AlertCircle, FolderIcon, FolderPlus } from "lucide-react";
import { toast } from "sonner";
import { open as openSelection } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";

import { Button, Input } from "@/components/ui";
import { FramedDialog } from "@/components/ui/FramedDialog";
import PrivacyBadge from "@/components/ui/PrivacyBadge";
import { cn } from "@/lib/utils";

import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { getPrivateSyncPath } from "@/lib/utils/syncPathUtils";
import { DRIVE_STORAGE_STATS_QUERY_KEY } from "@/app/lib/hooks/api/useDriveStorageStats";
import { GET_USER_IPFS_FILES_QUERY_KEY } from "@/app/lib/hooks/use-user-files";
import {
  SyncPausedAlert,
  IS_SYNC_PAUSED,
} from "@/components/ui/SyncPausedAlert";
import SyncFolderSelect from "@/components/ui/SyncFolderSelect";
import { hasConfiguredDrivesAtom } from "@/app/lib/global-atoms/unpinAtoms";
import {
  getLastBrowseDirectory,
  saveLastBrowseDirectory,
} from "@/lib/utils/userPreferencesDb";
import { useCreditCheck } from "@/lib/hooks/useCreditCheck";

type Props = {
  open: boolean;
  onClose: () => void;
  onSuccess?: (folderCid: string) => void;
  onRefresh?: () => void;
  defaultFolderLabel?: string | null;
};

export default function FolderUploadDialog({
  open,
  onClose,
  onSuccess,
  onRefresh,
  defaultFolderLabel,
}: Props) {
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useAtomValue(queryClientAtom);
  const hasConfiguredDrives = useAtomValue(hasConfiguredDrivesAtom);
  const { checkEligibility } = useCreditCheck();

  const [folderPath, setFolderPath] = useState<string>("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [selectedFolderLabel, setSelectedFolderLabel] = useState<string | null>(
    defaultFolderLabel ?? null,
  );
  const [selectedSyncPath, setSelectedSyncPath] = useState<string | null>(null);

  const handleSelectFolder = async () => {
    try {
      const defaultPath = await getLastBrowseDirectory();
      const selectedFolder = (await openSelection({
        directory: true,
        multiple: false,
        defaultPath,
      })) as string | null;

      if (selectedFolder && typeof selectedFolder === "string") {
        setFolderPath(selectedFolder.trim());
        setFolderError(null);
        saveLastBrowseDirectory(selectedFolder.trim());
      }
    } catch (error) {
      console.error("Error selecting folder:", error);
      toast.error(
        `Failed to select folder: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!folderPath) {
      setFolderError("Please select a folder");
      return;
    }

    if (!(await checkEligibility("folder-upload"))) {
      handleClose();
      return;
    }

    if (!hasConfiguredDrives) {
      toast.warning(
        "Set up a sync folder in Settings → Sync & Storage before uploading.",
      );
      return;
    }

    handleClose();

    toast.success("Folder added. Your sync will start soon.", {
      duration: 4000,
      closeButton: true,
    });

    try {
      const syncPath =
        selectedSyncPath ??
        (await getPrivateSyncPath(polkadotAddress || ""))?.path ??
        "";

      const name = await invoke<string>("add_folder", {
        syncPath,
        folderPath,
        subfolder: null,
      });

      queryClient.invalidateQueries({
        queryKey: [DRIVE_STORAGE_STATS_QUERY_KEY],
      });
      queryClient.invalidateQueries({
        queryKey: [GET_USER_IPFS_FILES_QUERY_KEY],
      });
      if (onRefresh) {
        onRefresh();
      }

      if (onSuccess) {
        onSuccess(name);
      }
    } catch (error) {
      console.error("Error uploading folder:", error);
      toast.error(
        `Failed to upload folder: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const handleClose = () => {
    setFolderPath("");
    setFolderError(null);
    setSelectedFolderLabel(defaultFolderLabel ?? null);
    setSelectedSyncPath(null);
    onClose();
  };

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title="Upload Folder"
      icon={<FolderPlus className="size-4 text-white" />}
      maxWidth="max-w-[653px]"
    >
      {/* Section label row — matches New File dialog layout */}
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="font-geist text-sm font-medium text-grey-60 dark:text-grey-dark-600 tracking-[-0.28px]">
          Folder Location
        </span>
        {!IS_SYNC_PAUSED && <PrivacyBadge variant="folder" />}
      </div>

      {IS_SYNC_PAUSED && (
        <div className="mb-3">
          <SyncPausedAlert variant="inline" />
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <SyncFolderSelect
          value={selectedFolderLabel}
          defaultLabel={defaultFolderLabel}
          onChange={(label, path) => {
            setSelectedFolderLabel(label);
            setSelectedSyncPath(path);
          }}
        />

        <div className="flex flex-col gap-2">
          <Input
            id="folderPath"
            placeholder="Select folder location"
            value={folderPath}
            readOnly
            onClick={handleSelectFolder}
            startAdornment={<FolderIcon className="size-5" />}
            endAdornment={
              <button
                type="button"
                onClick={handleSelectFolder}
                className="text-sm font-medium text-primary-50 hover:text-primary-40"
              >
                Browse
              </button>
            }
            wrapperClassName="cursor-pointer"
            className="cursor-pointer truncate"
          />
          {folderError && (
            <div className="flex items-center gap-2 text-sm font-medium text-error-70">
              <AlertCircle className="size-4 !relative" />
              <span>{folderError}</span>
            </div>
          )}
        </div>

        <div className="mt-2 flex flex-col gap-3">
          <Button
            type="submit"
            variant="primary"
            size="auto"
            disabled={IS_SYNC_PAUSED}
            className={cn(
              "h-[52px] w-full rounded-[6px] border text-base font-normal tracking-[-0.36px]",
              "border-[#3167DD] bg-[#3167DD] text-white",
              "hover:bg-[#2454c4] hover:border-[#2454c4]",
              "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]",
            )}
          >
            {IS_SYNC_PAUSED ? "Sync Paused" : "Upload Folder"}
          </Button>
          <Button
            type="button"
            variant="defaultStable"
            size="auto"
            onClick={handleClose}
            className="h-[52px] w-full rounded-[6px] text-base font-normal tracking-[-0.36px]"
          >
            {IS_SYNC_PAUSED ? "Close" : "Cancel"}
          </Button>
        </div>
      </form>
    </FramedDialog>
  );
}
