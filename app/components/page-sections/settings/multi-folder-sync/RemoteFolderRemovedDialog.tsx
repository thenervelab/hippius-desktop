"use client";

import React from "react";
import { CardButton } from "@/components/ui";
import DialogContainer from "@/components/ui/DialogContainer";
import { CloudOff, Trash2, RefreshCw } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { DialogIconHeader } from "./DialogIconHeader";

export interface RemoteFolderRemovedInfo {
  label: string;
  folderName: string;
  localPath: string;
}

interface RemoteFolderRemovedDialogProps {
  open: boolean;
  folder: RemoteFolderRemovedInfo | null;
  isProcessing: boolean;
  onRemoveLocal: () => void;
  onResync: () => void;
}

/**
 * Dialog shown when a sync folder has been removed from the server by another
 * device.  Offers the user two choices:
 *   1. Remove the local folder from sync (files stay on disk).
 *   2. Re-sync the folder back to the server.
 *
 * The dialog cannot be dismissed by clicking outside or pressing Escape —
 * the user must pick one of the two options.
 */
export function RemoteFolderRemovedDialog({
  open,
  folder,
  isProcessing,
  onRemoveLocal,
  onResync,
}: RemoteFolderRemovedDialogProps) {
  return (
    <Dialog.Root open={open}>
      <DialogContainer
        className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[460px] h-fit"
        preventClose
      >
        <Dialog.Title className="sr-only">
          Sync Folder Removed Remotely
        </Dialog.Title>

        <div className="px-4 py-6 flex flex-col gap-5">
          <div className="flex flex-col items-center text-center gap-3">
            <DialogIconHeader
              icon={<CloudOff className="size-5 text-grey-100" />}
              bgColor="bg-warning-50"
            />
            <div className="flex flex-col gap-1">
              <h2 className="text-xl font-semibold text-grey-10">
                Folder Removed from Server
              </h2>
              <p className="text-sm text-grey-50 max-w-sm">
                Your local folder &quot;
                <span className="font-semibold text-grey-10">
                  {folder?.folderName}
                </span>
                &quot; has been removed from the server by another device. Would
                you like to remove it from your local machine as well, or
                re-sync it with the server?
              </p>
            </div>
          </div>

          {/* Info box with local path */}
          <div className="bg-grey-97 rounded-lg px-3 py-2.5 text-xs text-grey-40">
            <span className="font-medium text-grey-30">Local path:</span>{" "}
            {folder?.localPath}
          </div>

          <div className="flex gap-2.5">
            <CardButton
              className="w-full"
              variant="error"
              onClick={onRemoveLocal}
              disabled={isProcessing}
              loading={isProcessing}
              icon={<Trash2 className="size-4" />}
              appendToStart
            >
              Remove from Sync
            </CardButton>
            <CardButton
              className="w-full"
              variant="primary"
              onClick={onResync}
              disabled={isProcessing}
              loading={isProcessing}
              icon={<RefreshCw className="size-4" />}
              appendToStart
            >
              Re-sync with Server
            </CardButton>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
}
