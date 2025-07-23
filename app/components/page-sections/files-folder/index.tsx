"use client";

import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import FilesTable from "@/components/page-sections/files/ipfs/files-table";
import CardView from "@/components/page-sections/files/ipfs/card-view";
import { toast } from "sonner";
import Link from "next/link";

interface FileEntry {
    file_name: string;
    file_size: number;
    cid: string;
}

export default function FolderView({ folderCid }: { folderCid: string }) {
    const { polkadotAddress } = useWalletAuth();
    const folderName = "Folder";
    const [files, setFiles] = useState<FormattedUserIpfsFile[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [viewMode, setViewMode] = useState<"list" | "card">("list");
    const [isDownloading, setIsDownloading] = useState(false);

    console.log("folderCid", folderCid)

    useEffect(() => {
        if (!folderCid) return;

        const loadFolderContents = async () => {
            try {
                setIsLoading(true);

                // Get folder metadata to extract folder name
                // const metadata = await invoke("get_folder_metadata", {
                //     folderMetadataCid: folderCid
                // });

                // if (metadata && typeof metadata === "object" && "folder_name" in metadata) {
                //     setFolderName(metadata.folder_name as string);
                // }

                // console.log("Loaded folder metadata:", metadata);

                // Get folder contents
                const fileEntries = await invoke<FileEntry[]>("list_folder_contents", {
                    folderMetadataCid: folderCid
                });

                console.log("Loaded folder contents:", fileEntries);

                // Convert FileEntry to FormattedUserIpfsFile format
                const formattedFiles = fileEntries.map((entry): FormattedUserIpfsFile => ({
                    cid: entry.cid,
                    name: entry.file_name,
                    size: entry.file_size,
                    type: entry.file_name.split('.').pop() || "unknown",
                    isAssigned: true,
                    source: folderName,
                    createdAt: Date.now(),
                    minerIds: [],
                    lastChargedAt: Date.now(),
                }));

                setFiles(formattedFiles);
            } catch (error) {
                console.error("Error loading folder contents:", error);
                toast.error(`Failed to load folder contents: ${error instanceof Error ? error.message : String(error)}`);
            } finally {
                setIsLoading(false);
            }
        };

        loadFolderContents();
    }, [folderCid]);

    const handleDownloadFolder = async () => {
        if (!folderCid) return;

        try {
            setIsDownloading(true);

            // Ask user to select download location
            const outputDir = await open({
                directory: true,
                multiple: false,
            }) as string | null;

            if (!outputDir) {
                setIsDownloading(false);
                return;
            }

            toast.info("Downloading folder...");

            // Use the encrypted download method
            await invoke("download_and_decrypt_folder", {
                accountId: polkadotAddress,
                folderMetadataCid: folderCid,
                folderName: folderName,
                outputDir: outputDir,
                encryptionKey: null,
            });

            toast.success("Folder downloaded successfully!");
        } catch (error) {
            console.error("Error downloading folder:", error);
            toast.error(`Failed to download folder: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setIsDownloading(false);
        }
    };

    return (
        <div className="container mx-auto py-8 px-4">
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                    <Link
                        href="/files"
                        className="flex items-center text-grey-50 hover:text-grey-30"
                    >
                        <Icons.ArrowLeft className="size-4 mr-1" />
                        Back
                    </Link>
                </div>

                <div className="flex items-center gap-4">
                    <div className="flex gap-2 border border-grey-80 p-1 rounded">
                        <button
                            className={cn(
                                "p-1 rounded",
                                viewMode === "list"
                                    ? "bg-primary-100 border border-primary-80 text-primary-40 rounded"
                                    : "bg-grey-100 text-grey-70"
                            )}
                            onClick={() => setViewMode("list")}
                            aria-label="List View"
                        >
                            <Icons.Grid className="size-5" />
                        </button>
                        <button
                            className={cn(
                                "p-1 rounded",
                                viewMode === "card"
                                    ? "bg-primary-100 border border-primary-80 text-primary-40 rounded"
                                    : "bg-grey-100 text-grey-70"
                            )}
                            onClick={() => setViewMode("card")}
                            aria-label="Card View"
                        >
                            <Icons.Category className="size-5" />
                        </button>
                    </div>

                    <button
                        onClick={handleDownloadFolder}
                        disabled={isDownloading}
                        className={cn(
                            "flex items-center justify-center gap-1 h-9 px-4 py-2 rounded bg-primary-50 text-white hover:bg-primary-40 transition-colors",
                            isDownloading && "opacity-70 cursor-not-allowed"
                        )}
                    >
                        {isDownloading ? (
                            <Icons.Loader className="size-4 animate-spin" />
                        ) : (
                            <Icons.DocumentDownload className="size-4" />
                        )}
                        Download Folder
                    </button>
                </div>
            </div>

            {isLoading ? (
                <div className="flex flex-col items-center justify-center py-16">
                    <Icons.Loader className="size-10 text-primary-50 animate-spin mb-4" />
                    <p className="text-grey-40">Loading folder contents...</p>
                </div>
            ) : (
                <>
                    {files.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 bg-grey-95 rounded-lg">
                            <Icons.Folder className="size-12 text-grey-60 mb-4" />
                            <h3 className="text-lg font-medium text-grey-30 mb-1">Empty Folder</h3>
                            <p className="text-grey-50 text-sm">This folder does not contain any files.</p>
                        </div>
                    ) : (
                        <div>
                            {viewMode === "list" ? (
                                <FilesTable
                                    files={files}
                                    isRecentFiles={false}
                                />
                            ) : (
                                <CardView
                                    files={files}
                                    isRecentFiles={false}
                                />
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
