import React, { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { Icons, CardButton } from "@/components/ui";
import FileDropzone from "@/components/page-sections/files/ipfs/upload-files-flow/FileDropzone";
import { getFolderPathArray } from "@/app/utils/folderPathUtils";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { basename } from '@tauri-apps/api/path';

interface FolderFileUploadFlowProps {
    folderName: string;
    isPrivateFolder: boolean;
    initialFiles?: FileList | null;
    onSuccess: () => void;
    onCancel: () => void;
}

interface FilePathInfo {
    path: string;
    name: string;
    file?: File;
}

const FolderFileUploadFlow: React.FC<FolderFileUploadFlowProps> = ({
    folderName,
    isPrivateFolder,
    initialFiles,
    onSuccess,
    onCancel
}) => {
    const { getParam } = useUrlParams();

    const [files, setFiles] = useState<FilePathInfo[]>([]);
    const [revealFiles, setRevealFiles] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const { polkadotAddress, mnemonic } = useWalletAuth();
    const mainFolderActualName = getParam("mainFolderActualName", "");
    const subFolderPath = getParam("subFolderPath");

    // Handle initial files - just store references without writing to disk yet
    useEffect(() => {
        if (initialFiles && initialFiles.length > 0) {
            const fileInfos = Array.from(initialFiles).map(file => ({
                path: '', // Path will be set during upload
                name: file.name,
                file: file // Store the File object
            }));

            setFiles(fileInfos);
            if (fileInfos.length > 1) setRevealFiles(true);
        }
    }, [initialFiles]);

    // Handle files from both file dialog and drag-and-drop
    const handleFiles = useCallback(async (paths: string[], browserFiles?: File[]) => {
        try {
            let newPathInfos: FilePathInfo[] = [];

            // Handle file paths from file dialog
            if (paths.length > 0) {
                newPathInfos = await Promise.all(
                    paths.map(async (path) => ({
                        path,
                        name: await basename(path)
                    }))
                );
            }

            // Handle browser File objects from drag and drop
            if (browserFiles && browserFiles.length > 0) {
                const browserFileInfos = browserFiles.map(file => ({
                    path: '',
                    name: file.name,
                    file: file
                }));
                newPathInfos = [...newPathInfos, ...browserFileInfos];
            }

            if (newPathInfos.length === 0) return;

            setFiles((prev) => {
                if (!prev.length) return newPathInfos;

                // Create a Set of existing paths/names to avoid duplicates
                const seen = new Set(prev.map(f => f.path || f.name));
                const unique = newPathInfos.filter(f => !seen.has(f.path || f.name));

                if (unique.length === 0) return prev;

                const combined = [...prev, ...unique];
                if (combined.length > 1) setRevealFiles(true);
                return combined;
            });
        } catch (error) {
            console.error("Error processing files:", error);
            toast.error("Failed to process selected files");
        }
    }, []);

    // Remove a file by index
    const removeFile = useCallback((idx: number) => {
        const newFiles = files.filter((_, i) => i !== idx);
        setFiles(newFiles);
        if (newFiles.length === 1) setRevealFiles(false);
    }, [files]);

    const handleAddFilesToFolder = async () => {
        if (!files.length) {
            toast.error("No files selected or folder information missing");
            return;
        }

        if (!polkadotAddress || !mnemonic) {
            toast.error("Wallet not connected. Please connect your wallet.");
            return;
        }

        onCancel(); // Close dialog
        setIsUploading(true);
        setUploadProgress(0);

        // Start toast for better UX
        const toastId = toast.loading(
            files.length > 1
                ? `Adding ${files.length} files to folder: 0%`
                : "Adding file to folder: 0%"
        );

        try {
            // Process each file in the selection
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const percent = Math.round(((i + 1) / files.length) * 100);

                let filePath = file.path;

                // If this is a browser File, write it to disk first
                if (file.file) {
                    try {
                        const arrayBuffer = await file.file.arrayBuffer();
                        const tempPath = `/tmp/${file.name}`;

                        // Write file to disk using Tauri command
                        await invoke("write_file", {
                            path: tempPath,
                            data: Array.from(new Uint8Array(arrayBuffer)),
                        });

                        filePath = tempPath;
                    } catch (error) {
                        console.error(`Error processing file ${file.name}:`, error);
                        toast.error(`Failed to process file: ${file.name}`);
                        continue;
                    }
                }

                // Now add the file to the folder using the file path
                const functionName = isPrivateFolder
                    ? "add_file_to_private_folder"
                    : "add_file_to_public_folder";

                const folderPath = getFolderPathArray(mainFolderActualName, subFolderPath);
                const mainFolderCid = getParam("mainFolderCid", "");

                const params = {
                    accountId: polkadotAddress,
                    folderMetadataCid: mainFolderCid,
                    folderName: mainFolderActualName,
                    filePath: filePath,
                    seedPhrase: mnemonic,
                    subfolderPath: folderPath || null
                };

                await invoke<string>(functionName, params);

                // Update progress
                setUploadProgress(percent);
                const msg = files.length > 1
                    ? `Adding ${files.length} files to folder: ${percent}%`
                    : `Adding file to folder: ${percent}%`;
                toast.loading(msg, { id: toastId });

                // Small delay to make progress visible when adding multiple small files
                if (files.length > 1) await new Promise(r => setTimeout(r, 300));
            }

            toast.success(
                files.length > 1
                    ? `${files.length} files successfully added to folder!`
                    : `File successfully added to folder!`,
                { id: toastId }
            );

            onSuccess();
        } catch (error) {
            console.error("Failed to add files to folder:", error, "  ", folderName);
            toast.error(
                `Failed to add files: ${error instanceof Error ? error.message : String(error)}`,
                { id: toastId }
            );
        } finally {
            setIsUploading(false);
            setUploadProgress(0);
        }
    };

    return (
        <div className="w-full">
            <FileDropzone setFiles={handleFiles} />

            {files.length > 0 ? (
                <div className="bg-grey-90 max-h-[200px] overflow-y-auto custom-scrollbar-thin pr-2 rounded-[8px] mt-4">
                    <div className="flex items-center font-medium px-2 gap-x-3 pr-1.5 py-1.5">
                        <div className="text-grey-10 flex items-center justify-start w-0 grow">
                            <div className="w-fit truncate">{files[0].name}</div>
                            {files.length > 1 && !revealFiles && (
                                <div className="text-grey-60 ml-1 mr-auto min-w-fit p-0.5 px-[3px] border rounded-[2px] border-grey-80 text-[10px]">
                                    + {files.length - 1} More File{files.length > 2 ? "s" : ""}
                                </div>
                            )}
                        </div>
                        <div className="flex items-center gap-x-2">
                            {files.length > 1 && (
                                <button
                                    onClick={() => setRevealFiles(v => !v)}
                                    className="flex items-center gap-x-2 text-sm text-grey-10"
                                    disabled={isUploading}
                                >
                                    {revealFiles ? "Hide" : "View"} <Icons.ArrowRight className="size-4" />
                                </button>
                            )}
                            <button
                                onClick={() => removeFile(0)}
                                className="text-grey-60 hover:text-error-50"
                                title="Remove file"
                                disabled={isUploading}
                            >
                                <Trash2 className="size-4" />
                            </button>
                        </div>
                    </div>

                    {revealFiles && (
                        <div className="px-2 flex flex-col w-full gap-y-1 pb-1 font-medium text-grey-10">
                            {files.slice(1).map((file, i) => (
                                <div
                                    key={file.path || file.name}
                                    className="w-full flex items-center justify-between"
                                >
                                    <div className="w-0 grow truncate">{file.name}</div>
                                    <button
                                        onClick={() => removeFile(i + 1)}
                                        className="ml-2 text-grey-60 hover:text-error-50 flex-shrink-0"
                                        title="Remove file"
                                        disabled={isUploading}
                                    >
                                        <Trash2 className="size-4" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            ) : null}

            {isUploading && (
                <div className="mt-3">
                    <div className="w-full h-2 bg-grey-80 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-primary-50 transition-all duration-300"
                            style={{ width: `${uploadProgress}%` }}
                        />
                    </div>
                    <div className="mt-1 text-center text-sm text-grey-40">
                        {uploadProgress}% complete
                    </div>
                </div>
            )}

            <div className="mt-3 flex flex-col gap-y-3">
                <CardButton
                    onClick={handleAddFilesToFolder}
                    disabled={!files.length || isUploading}
                    className="w-full"
                >
                    {isUploading
                        ? `Adding to Folder...`
                        : `Add ${files.length > 1 ? 'Files' : 'File'} to Folder`
                    }
                </CardButton>
                <CardButton
                    onClick={onCancel}
                    className="w-full"
                    variant="secondary"
                    disabled={isUploading}
                >
                    Cancel
                </CardButton>
            </div>
        </div>
    );
};

export default FolderFileUploadFlow;
