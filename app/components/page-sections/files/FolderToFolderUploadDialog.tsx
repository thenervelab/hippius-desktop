"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Icons } from "@/components/ui";
import PrivacyBadge from "@/components/ui/PrivacyBadge";
import { Input } from "@/components/ui";
import { Label } from "@/components/ui/label";
import { AlertCircle, FolderIcon } from "lucide-react";
import { toast } from "sonner";
import { open as openSelection } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { getPrivateSyncPath } from "@/lib/utils/syncPathUtils";
import { getFullPath } from "@/app/utils/folderPathUtils";
import { useAtomValue } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { REMOTE_STORAGE_STATS_QUERY_KEY } from "@/app/lib/hooks/api/useRemoteStorageStats";
import { syncEngineStatusAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { getLastBrowseDirectory, saveLastBrowseDirectory } from "@/lib/utils/userPreferencesDb";

type Props = {
    open: boolean;
    onClose: () => void;
    onSuccess?: (folderCid: string) => void;
    onRefresh?: () => void;
    parentFolderName: string;
    mainFolderActualName?: string;
    subFolderPath?: string;
    /** Resolved sync root path (avoids incorrect getPrivateSyncPath in multi-drive). */
    syncBasePath?: string;
};

export default function FolderToFolderUploadDialog({
    open,
    onClose,
    onSuccess,
    onRefresh,
    mainFolderActualName,
    subFolderPath,
    syncBasePath,
}: Props) {
    const { polkadotAddress } = useWalletAuth();
    const queryClient = useAtomValue(queryClientAtom);
    const syncEngineStatus = useAtomValue(syncEngineStatusAtom);

    const [folderPath, setFolderPath] = useState<string>("");
    const [folderError, setFolderError] = useState<string | null>(null);

    const handleSelectFolder = async () => {
        try {
            const defaultPath = await getLastBrowseDirectory();
            const selectedFolder = await openSelection({
                directory: true,
                multiple: false,
                defaultPath,
            }) as string | null;

            if (selectedFolder && typeof selectedFolder === "string") {
                setFolderPath(selectedFolder.trim());
                setFolderError(null);
                // Remember this directory for next time
                saveLastBrowseDirectory(selectedFolder.trim());
            }
        } catch (error) {
            console.error("Error selecting folder:", error);
            toast.error(`Failed to select folder: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!folderPath) {
            setFolderError("Please select a folder");
            return;
        }

        if (syncEngineStatus === "stopped") {
            toast.warning("Syncing is stopped. Resume syncing from Settings \u2192 Sync & Storage before uploading folders.");
            return;
        }

        // Close the dialog immediately after clicking submit
        handleClose();

        // Show success toast immediately
        toast.success("Folder added. Your sync will start soon.", { duration: 4000, closeButton: true });

        try {
            // Rust handles subfolder join and sync trigger
            const baseSyncPath = syncBasePath || ((await getPrivateSyncPath(polkadotAddress ?? undefined))?.path ?? "");
            const subfolder = getFullPath(mainFolderActualName, subFolderPath);

            const name = await invoke<string>("add_folder", {
                syncPath: baseSyncPath,
                folderPath,
                subfolder: subfolder || null,
            });

            // Refresh file list AFTER backend has added the folder so list_sync_folder sees it
            queryClient.invalidateQueries({ queryKey: [REMOTE_STORAGE_STATS_QUERY_KEY] });
            if (onRefresh) {
                onRefresh();
            }

            if (onSuccess) {
                onSuccess(name);
            }
        } catch (error) {
            console.error("Error uploading folder:", error);
            toast.error(`Failed to upload folder: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const handleClose = () => {
        setFolderPath("");
        setFolderError(null);
        onClose();
    };

    return (
        <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
            <Dialog.Portal>
                <Dialog.Overlay className="bg-white/70 fixed p-4 z-30 top-0 w-full h-full flex items-center justify-center data-[state=open]:animate-fade-in-0.3">
                    <Dialog.Content className="border shadow-dialog bg-white flex flex-col max-w-[26.75rem] max-h-[90vh] border-grey-80 bg-background-1 rounded-[0.5rem] overflow-hidden overflow-y-auto w-full relative data-[state=open]:animate-scale-in-95-0.2">
                        <Dialog.Title className="hidden">Add Folder</Dialog.Title>

                        <div className="flex p-4 items-center text-grey-10 relative gap-2">
                            <div className="lg:text-xl flex min-w-0 flex-1 items-center gap-2 2xl:text-2xl font-medium relative">
                                <span className="capitalize">Add Folder</span>
                                <PrivacyBadge variant="folder" />
                            </div>
                            <button
                                type="button"
                                className="shrink-0"
                                onClick={handleClose}
                            >
                                <Icons.CloseCircle
                                    className="size-6 relative"
                                    strokeWidth={2.5}
                                />
                            </button>
                        </div>

                        <div className="grow max-h-[calc(85vh-120px)] p-4 pt-2 overflow-y-auto">
                            <form onSubmit={handleSubmit} className="space-y-4">
                                <div className="space-y-2">
                                    <Label htmlFor="folderPath" className="text-sm font-medium text-grey-70">
                                        Folder Location
                                    </Label>
                                    <div className="relative flex items-start w-full">
                                        <FolderIcon className="size-6 absolute left-3 top-[1.75rem] transform -translate-y-1/2 text-grey-60" />
                                        <div className="flex-1 min-w-0">
                                            <Input
                                                id="folderPath"
                                                placeholder="Select folder location"
                                                value={folderPath}
                                                readOnly
                                                onClick={handleSelectFolder}
                                                className={cn(
                                                    "pl-11 pr-24 border-grey-80 h-14 text-grey-30 w-full cursor-pointer",
                                                    "bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none",
                                                    "hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus",
                                                    "overflow-x-auto whitespace-nowrap"
                                                )}
                                                style={{ textOverflow: "ellipsis" }}
                                            />
                                        </div>
                                        <button
                                            type="button"
                                            onClick={handleSelectFolder}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-primary-50 hover:text-primary-40 z-10"
                                            style={{ maxWidth: "5rem" }}
                                        >
                                            Browse
                                        </button>
                                    </div>
                                    {folderError && (
                                        <div className="flex text-error-70 text-sm font-medium items-center gap-2">
                                            <AlertCircle className="size-4 !relative" />
                                            <span>{folderError}</span>
                                        </div>
                                    )}
                                </div>

                                <div className="flex flex-col gap-2">
                                    <button
                                        type="submit"
                                        className="w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40 hover:bg-primary-40 transition"
                                    >
                                        <div className="py-2.5 rounded border border-primary-40 text-lg">
                                            Upload Folder
                                        </div>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleClose}
                                        className="w-full py-3.5 bg-grey-100 border border-grey-80 rounded text-grey-10 hover:bg-grey-90 transition text-lg font-medium"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </form>
                        </div>
                    </Dialog.Content>
                </Dialog.Overlay>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
