/* eslint-disable @typescript-eslint/no-explicit-any */
import useUserIpfsFiles, {
    GET_USER_IPFS_FILES_QUERY_KEY,
} from "@/lib/hooks/use-user-ipfs-files";
import { useMutation } from "@tanstack/react-query";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { queryClientAtom } from "jotai-tanstack-query";
import { useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { getFolderPathArray } from "@/app/utils/folderPathUtils";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { toast } from "sonner";
import { useRef } from "react";

export type FileToDelete = FormattedUserIpfsFile;

export const useDeleteIpfsFile = ({
    files,
    isPrivateFolder
}: {
    files: FileToDelete[],
    isPrivateFolder?: boolean
}) => {
    const { data: ipfsFiles } = useUserIpfsFiles();
    const { getParam } = useUrlParams();
    console.log("isPrivateFolder", isPrivateFolder)

    const { api } = usePolkadotApi();
    const { walletManager, polkadotAddress } = useWalletAuth();
    const queryClient = useAtomValue(queryClientAtom);
    const mainFolderActualName = getParam("mainFolderActualName", "");
    const subFolderPath = getParam("subFolderPath");

    // Track toast for proper cleanup
    const loadingToastRef = useRef<string | number | null>(null);

    return useMutation({
        mutationKey: ["delete-ipfs-files", files.map(f => f.cid).join(',')],
        onMutate: () => {
            // Show loading toast when mutation starts
            const fileCount = files.length;
            const isMultiple = fileCount > 1;
            const firstFileName = files[0]?.actualFileName || files[0]?.name || "file";

            const loadingMessage = isMultiple
                ? `Deleting ${fileCount} files...`
                : `Deleting "${firstFileName}"...`;

            loadingToastRef.current = toast.loading(loadingMessage);
        },
        onSuccess: () => {
            // Dismiss loading toast and show success
            if (loadingToastRef.current) {
                toast.dismiss(loadingToastRef.current);
                loadingToastRef.current = null;
            }

            const fileCount = files.length;
            const isMultiple = fileCount > 1;
            const firstFileName = files[0]?.actualFileName || files[0]?.name || "file";

            const successMessage = isMultiple
                ? `Successfully deleted ${fileCount} files`
                : `Successfully deleted "${firstFileName}"`;

            toast.success(successMessage);
        },
        onError: (error: Error) => {
            // Dismiss loading toast and show error
            if (loadingToastRef.current) {
                toast.dismiss(loadingToastRef.current);
                loadingToastRef.current = null;
            }

            const fileCount = files.length;
            const isMultiple = fileCount > 1;
            const firstFileName = files[0]?.actualFileName || files[0]?.name || "file";

            const errorMessage = isMultiple
                ? `Failed to delete ${fileCount} files: ${error.message}`
                : `Failed to delete "${firstFileName}": ${error.message}`;

            toast.error(errorMessage);
        },
        onSettled: () => {
            // Cleanup: ensure loading toast is always dismissed
            if (loadingToastRef.current) {
                toast.dismiss(loadingToastRef.current);
                loadingToastRef.current = null;
            }
        },
        mutationFn: async () => {
            if (!ipfsFiles && files.length === 0) throw new Error("No Files Found");
            if (!api) throw new Error("Polkadot API not initialised");
            if (!walletManager) throw new Error("Error getting wallet manager");

            // Process each file for deletion
            const results = [];

            console.log("Deleting files:", files);
            console.log("Files to delete count:", files.length);
            console.log("Is single folder?", files.length === 1 && files[0]?.isFolder);

            for (const file of files) {
                console.log("Processing file for deletion:", {
                    name: file.name,
                    actualFileName: file.actualFileName,
                    isFolder: file.isFolder,
                    cid: file.cid
                });

                let actualFileToDelete = ipfsFiles?.files.find(f => f.actualFileName === file.actualFileName);
                console.log("Found matching file in ipfsFiles:", actualFileToDelete ? {
                    name: actualFileToDelete.name,
                    actualFileName: actualFileToDelete.actualFileName,
                    isFolder: actualFileToDelete.isFolder
                } : "NOT FOUND");

                if (!actualFileToDelete) {
                    console.log("File not found in ipfsFiles, using provided file directly");
                    actualFileToDelete = file;
                }

                if (!actualFileToDelete) {
                    console.error("No file to delete - this should not happen");
                    throw new Error(`Cannot find file: ${file.name}`);
                }

                console.log("Final file to delete:", {
                    name: actualFileToDelete.name,
                    actualFileName: actualFileToDelete.actualFileName,
                    isFolder: actualFileToDelete.isFolder,
                    cid: actualFileToDelete.cid,
                    file: actualFileToDelete
                });

                try {
                    // Handle file in folder deletion
                    if (mainFolderActualName) {
                        const folderPath = getFolderPathArray(mainFolderActualName, subFolderPath);
                        const mainFolderCid = getParam("mainFolderCid", "");

                        const isFolder = actualFileToDelete.isFolder;
                        // Determine the command based on file type and folder privacy
                        const command = actualFileToDelete.type === "private"
                            ? (isFolder ? "remove_folder_from_private_folder" : "remove_file_from_private_folder")
                            : (isFolder ? "remove_folder_from_public_folder" : "remove_file_from_public_folder");

                        // Create the common base parameters
                        const params = {
                            accountId: polkadotAddress,
                            folderMetadataCid: mainFolderCid,
                            folderName: mainFolderActualName,
                            subfolderPath: folderPath || null
                        };

                        // Add the specific parameter based on whether it's a folder or file
                        if (isFolder) {
                            (params as any).folderToRemove = actualFileToDelete.actualFileName;
                        } else {
                            (params as any).fileName = actualFileToDelete.actualFileName;
                        }

                        console.log("command", command)
                        console.log("params", params)

                        await invoke<string>(command, params);
                        results.push({ file: actualFileToDelete, success: true });
                    } else {
                        console.log("command", "delete_and_unpin_file_by_name")
                        console.log("params", {
                            fileName: actualFileToDelete.actualFileName
                        });

                        await invoke("delete_and_unpin_file_by_name", {
                            fileName: actualFileToDelete.actualFileName
                        });
                        results.push({ file: actualFileToDelete, success: true });
                    }
                } catch (error) {
                    console.error(`Failed to delete ${actualFileToDelete.isFolder ? 'folder' : 'file'}:`, error);
                    results.push({
                        file: actualFileToDelete,
                        success: false,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }

            console.log("Deletion results:", results);

            // Check if any deletions failed
            const failedDeletions = results.filter(r => !r.success);
            if (failedDeletions.length > 0) {
                const errorMessages = failedDeletions.map(f => `${f.file.name}: ${f.error}`).join('; ');
                throw new Error(`Failed to delete some files: ${errorMessages}`);
            }

            // Refetch user files after successful deletions
            await queryClient.refetchQueries({
                queryKey: [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress],
            });

            return results;
        },
    });
};

export default useDeleteIpfsFile;
