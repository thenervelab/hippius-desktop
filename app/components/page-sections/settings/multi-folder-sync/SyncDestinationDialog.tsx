"use client";

import React from "react";
import { CloudDownload, Folder, Monitor } from "lucide-react";

import { Button } from "@/components/ui";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { formatBytes } from "@/lib/utils/formatBytes";
import { cn } from "@/lib/utils";
import type { RemoteFolder } from "@/app/lib/types/sync-folder";

interface SyncDestinationDialogProps {
  open: boolean;
  folder: RemoteFolder | null;
  syncLocalPath: string;
  isSyncing: boolean;
  onClose: () => void;
  onSelectDestination: () => void;
  onStartSync: () => void;
}

export function SyncDestinationDialog({
  open,
  folder,
  syncLocalPath,
  isSyncing,
  onClose,
  onSelectDestination,
  onStartSync,
}: SyncDestinationDialogProps) {
  const handleClose = () => {
    if (isSyncing) return;
    onClose();
  };

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title="Choose Destination"
      icon={<CloudDownload className="size-5 text-white" />}
      maxWidth="max-w-[680px]"
    >
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        Select where to sync &quot;{folder?.folderName}&quot;
      </p>

      <div className="flex flex-col gap-4">
        {/* Folder info card */}
        <div className="rounded-[8px] border border-grey-80 bg-[#fafafa] p-3 dark:border-[#3a3a3a] dark:bg-[#2a2a2a]">
          <div className="mb-1 flex items-center gap-2">
            <Folder className="size-4 text-primary-50" />
            <span className="text-sm font-medium text-grey-10 dark:text-white">
              {folder?.folderName}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-grey-60 dark:text-grey-dark-600">
            {folder?.deviceName && (
              <span className="flex items-center gap-1">
                <Monitor className="size-3" />
                {folder.deviceName}
              </span>
            )}
            {(folder?.fileCount ?? 0) > 0 && (
              <span>
                {folder?.fileCount}{" "}
                {folder?.fileCount === 1 ? "file" : "files"}
              </span>
            )}
            {(folder?.totalBytes ?? 0) > 0 && (
              <span>{formatBytes(folder?.totalBytes ?? 0)}</span>
            )}
          </div>
        </div>

        {/* Destination selection */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-grey-40 dark:text-grey-dark-600">
            Local Destination
          </span>
          {syncLocalPath ? (
            <div className="rounded-[8px] border border-grey-80 bg-[#fafafa] p-3 dark:border-[#3a3a3a] dark:bg-[#2a2a2a]">
              <div className="flex items-start justify-between gap-3">
                <p className="flex-1 min-w-0 break-all rounded border border-grey-90 bg-white px-2 py-1.5 font-mono text-xs text-grey-60 dark:border-[#3a3a3a] dark:bg-[#1a1a1a] dark:text-grey-dark-600">
                  {syncLocalPath}/{folder?.folderName}
                </p>
                <Button
                  variant="primaryLight"
                  size="auto"
                  onClick={onSelectDestination}
                  disabled={isSyncing}
                  className="h-[34px] flex-shrink-0 px-4 text-xs font-medium"
                >
                  Change
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={onSelectDestination}
              disabled={isSyncing}
              className="flex h-[48px] w-full items-center justify-center gap-2 rounded-[6px] border border-grey-80 bg-white text-sm font-medium text-grey-10 transition-colors hover:bg-[#f5f5f5] disabled:opacity-50 dark:border-[#3a3a3a] dark:bg-[#2a2a2a] dark:text-white dark:hover:bg-[#323232]"
            >
              <Folder className="size-4" />
              Choose Destination Folder
            </button>
          )}
        </div>

        {/* Info box — only when a path has been chosen */}
        {syncLocalPath && (
          <div className="animate-in fade-in rounded-[8px] border border-primary-80 bg-primary-100/40 p-3 duration-200 dark:border-primary-50/40 dark:bg-primary-50/[0.12]">
            <p className="text-xs text-primary-40 dark:text-primary-brand-dark">
              Files will be downloaded and kept in sync with your other devices.
              Any local changes will sync back automatically.
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <Button
            variant="defaultStable"
            size="auto"
            onClick={onClose}
            disabled={isSyncing}
            className="h-[42px] w-full rounded-[6px] text-sm font-medium"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="auto"
            onClick={onStartSync}
            disabled={!syncLocalPath || isSyncing}
            loading={isSyncing}
            className={cn(
              "h-[42px] w-full rounded-[6px] border text-sm font-medium",
              "border-[#3167DD] bg-[#3167DD] text-white",
              "hover:bg-[#2454c4] hover:border-[#2454c4]",
              "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
            )}
          >
            {isSyncing ? "Starting Sync..." : "Start Syncing"}
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
}
