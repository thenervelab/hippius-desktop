"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle, FolderAdd } from "@/components/ui/icons";
import { AbstractIconWrapper, RevealTextLine, Icons } from "@/app/components/ui";
import { Input } from "@/components/ui";
import { Label } from "@/components/ui/label";
import { AlertCircle, FolderIcon } from "lucide-react";
import { toast } from "sonner";
import { open as openSelection } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { getPrivateSyncPath } from "@/lib/utils/syncPathUtils";
import { SyncPausedAlert, IS_SYNC_PAUSED } from "@/components/ui/SyncPausedAlert";

type Props = {
    open: boolean;
    onClose: () => void;
    onSuccess?: (folderCid: string) => void;
    onRefresh?: () => void;
};

export default function FolderUploadDialog({
    open,
    onClose,
    onSuccess,
    onRefresh
}: Props) {
    const { polkadotAddress } = useWalletAuth();

    const [folderPath, setFolderPath] = useState<string>("");
    const [folderError, setFolderError] = useState<string | null>(null);
    // const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSelectFolder = async () => {
        try {
            const selectedFolder = await openSelection({
                directory: true,
                multiple: false,
            }) as string | null;

            if (selectedFolder && typeof selectedFolder === "string") {
                setFolderPath(selectedFolder.trim());
                setFolderError(null);
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

        // Close the dialog immediately after clicking submit
        handleClose();

        // Show toast to indicate upload has started
        const toastId = toast.loading("Uploading folder...");

        try {
            // Get sync path and copy folder into it
            const syncPath = await getPrivateSyncPath(polkadotAddress);

            const name = await invoke<string>("add_folder", {
                syncPath,
                folderPath,
            });

            // Trigger sync to push changes
            await invoke("trigger_sync_now").catch(() => {});

            toast.dismiss(toastId);
            toast.success(`Folder uploaded successfully!`);

            if (onRefresh) {
                onRefresh();
            }

            if (onSuccess) {
                onSuccess(name);
            }
        } catch (error) {
            console.error("Error uploading folder:", error);
            toast.dismiss(toastId);
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
                <Dialog.Overlay className="fixed inset-0 bg-white/60 z-50" />
                <Dialog.Content
                    className="
                        fixed left-1/2 top-1/2 z-50 
                        w-full max-w-sm sm:max-w-[488px] 
                        -translate-x-1/2 -translate-y-1/2
                        bg-white rounded-[8px]
                        shadow-[0px_12px_36px_rgba(0,0,0,0.14)]
                        p-[16px]
                    "
                >
                    <div className="absolute top-0 left-0 right-0 h-4 bg-primary-50 rounded-t-[8px] sm:hidden" />
                    <Dialog.Close asChild className="sm:hidden">
                        <button
                            aria-label="Close"
                            className="absolute top-11 right-4 text-grey-10 hover:text-grey-20"
                        >
                            <CloseCircle className="size-6" />
                        </button>
                    </Dialog.Close>

                    <div className="flex items-center sm:justify-center">
                        <div className="flex items-center sm:justify-center h-[56px] w-[56px] relative">
                            <AbstractIconWrapper className="size-10 rounded-2xl text-primary-50 ">
                                <FolderAdd className="absolute size-6 text-primary-50" />
                            </AbstractIconWrapper>
                        </div>
                    </div>

                    <Dialog.Title className="text-grey-10 text-[22px] sm:text-2xl font-medium text-center">
                        Upload Folder
                    </Dialog.Title>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="text-grey-70 text-sm text-center">
                            <RevealTextLine rotate reveal={true} className="delay-300">
                                Upload a folder to encrypted IPFS storage.
                            </RevealTextLine>
                        </div>

                        {/* Sync Paused Notice */}
                        {IS_SYNC_PAUSED && (
                            <SyncPausedAlert variant="inline" className="mt-2" />
                        )}

                        {/* Privacy Notice */}
                        {!IS_SYNC_PAUSED && (
                            <div className="p-3 bg-primary-95 border border-primary-80 rounded-lg">
                                <div className="flex items-start gap-2">
                                    <div className="flex-shrink-0 mt-0.5">
                                        <Icons.ShieldSecurity className="size-4 text-primary-50" />
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-sm font-medium text-primary-40 mb-1">
                                            Private Storage
                                        </p>
                                        <p className="text-xs text-primary-60">
                                            This folder will be added to your private sync folder and encrypted for security.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="space-y-2">
                            <Label htmlFor="folderPath" className="text-sm font-medium text-grey-70">
                                Folder Location
                            </Label>
                            <div className="relative flex items-start w-full">
                                <FolderIcon className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
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
                                    style={{ maxWidth: "80px" }}
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
                                disabled={IS_SYNC_PAUSED}
                                className={cn(
                                    "w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40 hover:bg-primary-40 transition",
                                    IS_SYNC_PAUSED && "opacity-50 cursor-not-allowed hover:bg-primary-50"
                                )}
                            >
                                <div className="py-2.5 rounded border border-primary-40 text-lg">
                                    {IS_SYNC_PAUSED ? "Sync Paused" : "Upload Folder"}
                                </div>
                            </button>
                            <button
                                type="button"
                                onClick={handleClose}
                                className="w-full py-3.5 bg-grey-100 border border-grey-80 rounded text-grey-10 hover:bg-grey-90 transition text-lg font-medium"
                            >
                                {IS_SYNC_PAUSED ? "Close" : "Cancel"}
                            </button>
                        </div>
                    </form>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
