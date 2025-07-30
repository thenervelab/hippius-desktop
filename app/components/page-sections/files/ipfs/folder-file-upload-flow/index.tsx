import React, { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { Icons, CardButton, Input } from "@/components/ui";
import { Label } from "@/components/ui/label";
import FileDropzone from "../upload-files-flow/FileDropzone";
import { readFileAsArrayBuffer } from "@/app/lib/hooks/useFilesUpload";

interface FolderFileUploadFlowProps {
    folderCid: string;
    folderName: string;
    isPrivateFolder: boolean;
    initialFiles?: FileList | null;
    onSuccess: () => void;
    onCancel: () => void;
}

interface EncryptionKey {
    id: number;
    key: string;
}


const FolderFileUploadFlow: React.FC<FolderFileUploadFlowProps> = ({
    folderCid,
    folderName,
    isPrivateFolder,
    initialFiles,
    onSuccess,
    onCancel
}) => {
    const [files, setFiles] = useState<FileList | null>(null);
    const [revealFiles, setRevealFiles] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const { polkadotAddress, mnemonic } = useWalletAuth();
    const [encryptionKeyError, setEncryptionKeyError] = useState<string | null>(
        null
    );
    const [encryptionKey, setEncryptionKey] = useState("");

    // Handle initial files if provided
    useEffect(() => {
        if (initialFiles && initialFiles.length > 0) {
            setFiles(initialFiles);
            if (initialFiles.length > 1) setRevealFiles(true);
        }
    }, [initialFiles]);

    // Generate a unique key for each file
    const getFileKey = (file: File): string => {
        return `${file.name}-${file.size}-${file.lastModified}`;
    };

    // Append files, avoiding duplicates
    const appendFiles = useCallback((newFiles: FileList | null) => {
        if (!newFiles?.length) return;
        setFiles(prev => {
            if (!prev) return newFiles;
            const seen = new Set(Array.from(prev).map(f => getFileKey(f)));
            const unique = Array.from(newFiles).filter(f => !seen.has(getFileKey(f)));
            if (!unique.length) return prev;
            const combined = [...Array.from(prev), ...unique];
            const dt = new DataTransfer();
            combined.forEach(f => dt.items.add(f));
            if (combined.length > 1) setRevealFiles(true);
            return dt.files;
        });
    }, []);

    // Remove a file by index
    const removeFile = useCallback((idx: number) => {
        if (!files) return;
        const arr = Array.from(files).filter((_, i) => i !== idx);
        if (!arr.length) {
            setFiles(null);
            return;
        }
        const dt = new DataTransfer();
        arr.forEach(f => dt.items.add(f));
        setFiles(dt.files);
        if (arr.length === 1) setRevealFiles(false);
    }, [files]);

    const handleAddFilesToFolder = async () => {
        if (!folderCid || !files?.length) {
            toast.error("No files selected or folder information missing");
            return;
        }

        if (!polkadotAddress || !mnemonic) {
            toast.error("Wallet not connected. Please connect your wallet.");
            return;
        }


        if (encryptionKey) {
            try {
                const savedKeys: EncryptionKey[] = await invoke<EncryptionKey[]>(
                    "get_encryption_keys"
                );

                const keyExists: boolean = savedKeys.some((k) => k.key === encryptionKey);

                if (!keyExists) {
                    setEncryptionKeyError(
                        "Incorrect encryption key. Please try again with a correct one."
                    );
                    return;
                }
            } catch (error) {
                console.error("Error validating encryption key:", error);
                toast.error("Failed to validate encryption key");
                return;
            }
        }
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
                setUploadProgress(percent);

                // Update toast with progress
                const msg = files.length > 1
                    ? `Adding ${files.length} files to folder: ${percent}%`
                    : `Adding file to folder: ${percent}%`;
                toast.loading(msg, { id: toastId });

                const fileData = await readFileAsArrayBuffer(file);

                // Now add the file to the folder using the temp path
                const functionName = isPrivateFolder
                    ? "add_file_to_private_folder"
                    : "add_file_to_public_folder";



                const params = {
                    accountId: polkadotAddress,
                    folderMetadataCid: folderCid,
                    folderName,
                    fileName: file.name,
                    fileData: fileData,
                    seedPhrase: mnemonic,
                    ...(isPrivateFolder ? { encryptionKey: encryptionKey || null } : {})
                };
                console.log("params for adding file:", params);

                await invoke<string>(functionName, params);

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
            <FileDropzone setFiles={appendFiles} />

            {files?.length ? (
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
                            {Array.from(files)
                                .slice(1)
                                .map((f, i) => (
                                    <div
                                        key={`${f.name}-${f.lastModified}-${f.size}`}
                                        className="w-full flex items-center justify-between"
                                    >
                                        <div className="w-0 grow truncate">{f.name}</div>
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

            {isPrivateFolder && (
                <div className="space-y-1 mt-4">
                    <Label
                        htmlFor="encryptionKey"
                        className="text-sm font-medium text-grey-70"
                    >
                        Encryption Key (optional)
                    </Label>
                    <div className="relative flex items-start w-full">
                        <Icons.ShieldSecurity className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
                        <Input
                            id="encryptionKey"
                            placeholder="Enter encryption key"
                            value={encryptionKey}
                            onChange={(e) => {
                                setEncryptionKey(e.target.value);
                                setEncryptionKeyError(null);
                            }}
                            className={`pl-11 border-grey-80 h-14 text-grey-30 w-full
                        bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none 
                        hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus
                        ${encryptionKeyError ? "border-error-50 focus:border-error-50" : ""}`}
                        />
                    </div>
                    <p className="text-xs text-grey-70">
                        {encryptionKey.trim()
                            ? `Using custom encryption key.`
                            : "Default encryption key will be used if left empty."}
                    </p>

                    {encryptionKeyError && (
                        <div className="flex text-error-70 text-sm font-medium items-center gap-2">
                            <AlertCircle className="size-4 !relative" />
                            <span>{encryptionKeyError}</span>
                        </div>
                    )}
                </div>
            )}

            <div className="mt-3 flex flex-col gap-y-3">
                <CardButton
                    onClick={handleAddFilesToFolder}
                    disabled={!files?.length || isUploading}
                    className="w-full"
                >
                    {isUploading
                        ? `Adding to Folder...`
                        : `Add ${files && files.length > 1 ? 'Files' : 'File'} to Folder`
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
