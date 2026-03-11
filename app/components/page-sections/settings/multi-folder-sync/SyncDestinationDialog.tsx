"use client";

import React from "react";
import { CardButton } from "@/components/ui";
import DialogContainer from "@/components/ui/DialogContainer";
import { formatBytes } from "@/lib/utils/formatBytes";
import { Folder, CloudDownload, Monitor } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { Label } from "@/components/ui/label";
import type { RemoteFolder } from "@/app/lib/types/sync-folder";
import { DialogIconHeader } from "./DialogIconHeader";

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
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !isSyncing) onClose();
      }}
    >
      <DialogContainer
        className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit"
        preventClose={isSyncing}
      >
        <Dialog.Title className="sr-only">Choose Destination</Dialog.Title>

        <div className="px-4 py-6 flex flex-col gap-5">
          {/* Centered icon header */}
          <div className="flex flex-col items-center text-center gap-3">
            <DialogIconHeader
              icon={<CloudDownload className="size-5 text-grey-100" />}
              bgColor="bg-primary-50"
            />
            <h2 className="text-xl font-semibold text-grey-10">
              Choose Destination
            </h2>
            <p className="text-sm text-grey-50 max-w-sm">
              Select where to sync &quot;{folder?.folderName}&quot;
            </p>
          </div>

          {/* Folder info */}
          <div className="p-3 bg-grey-98 border border-grey-80 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <Folder className="size-4 text-primary-50" />
              <span className="font-medium text-sm text-grey-10">
                {folder?.folderName}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs text-grey-60">
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
          <div className="space-y-2">
            <Label className="text-sm font-medium text-grey-30">
              Local Destination
            </Label>
            {syncLocalPath ? (
              <div className="p-3 border border-grey-80 rounded-lg bg-grey-98">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-grey-60 break-all font-mono bg-white px-2 py-1.5 rounded border border-grey-90">
                      {syncLocalPath}/{folder?.folderName}
                    </p>
                  </div>
                  <button
                    className="flex-shrink-0 px-3 py-1.5 text-xs font-medium text-primary-50 bg-white border border-primary-50 rounded hover:bg-primary-50 hover:text-white transition-colors"
                    onClick={onSelectDestination}
                    disabled={isSyncing}
                  >
                    Change
                  </button>
                </div>
              </div>
            ) : (
              <CardButton
                variant="secondary"
                className="w-full justify-center"
                icon={<Folder className="size-4" />}
                appendToStart
                onClick={onSelectDestination}
                disabled={isSyncing}
              >
                Choose Destination Folder
              </CardButton>
            )}
          </div>

          {/* Info box */}
          {syncLocalPath && (
            <div className="p-3 bg-primary-95 border border-primary-80 rounded-lg animate-in fade-in duration-200">
              <p className="text-xs text-primary-40">
                Files will be downloaded and kept in sync with your other
                devices. Any local changes will sync back automatically.
              </p>
            </div>
          )}

          {/* Buttons */}
          <div className="flex gap-3">
            <CardButton
              className="w-full"
              variant="secondary"
              onClick={onClose}
              disabled={isSyncing}
            >
              Cancel
            </CardButton>
            <CardButton
              className="w-full"
              variant="primary"
              onClick={onStartSync}
              disabled={!syncLocalPath || isSyncing}
              loading={isSyncing}
            >
              {isSyncing ? "Starting Sync..." : "Start Syncing"}
            </CardButton>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
}
