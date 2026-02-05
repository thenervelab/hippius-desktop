import useUserFiles, {
    GET_USER_IPFS_FILES_QUERY_KEY,
} from "@/app/lib/hooks/use-user-files";
import { useMutation } from "@tanstack/react-query";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { queryClientAtom } from "jotai-tanstack-query";
import { useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { toast } from "sonner";
import { useRef } from "react";

export type FileToDelete = FormattedUserFile;

export const useDeleteFile = ({
    files,
}: {
    files: FileToDelete[],
}) => {
    const { data: ipfsFiles } = useUserFiles();

    const { api } = usePolkadotApi();
    const { walletManager, polkadotAddress } = useWalletAuth();
    const queryClient = useAtomValue(queryClientAtom);

    // Track toast for proper cleanup
    const loadingToastRef = useRef<string | number | null>(null);

    return useMutation({
        mutationKey: ["delete-files", files.map(f => f.cid).join(',')],
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

            // Get sync path for file removal
            const syncPathResult = await invoke<{ path: string; is_public: boolean }>(
                "get_sync_path",
                { isPublic: true, accountId: polkadotAddress }
            );
            const syncPath = syncPathResult.path;

            for (const file of files) {
                const actualFileToDelete = ipfsFiles?.files.find(f => f.actualFileName === file.actualFileName) || file;

                if (!actualFileToDelete) {
                    throw new Error(`Cannot find file: ${file.name}`);
                }

                try {
                    const fileName = actualFileToDelete.actualFileName || actualFileToDelete.name;

                    // Use remove_file command (removes from sync folder, hcfs-client handles remote deletion)
                    await invoke("remove_file", {
                        syncPath,
                        name: fileName,
                    });
                    results.push({ file: actualFileToDelete, success: true });
                } catch (error) {
                    console.error(`Failed to delete ${actualFileToDelete.isFolder ? 'folder' : 'file'}:`, error);
                    results.push({
                        file: actualFileToDelete,
                        success: false,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }

            // Trigger sync to propagate deletions
            await invoke("trigger_sync_now").catch(() => {});

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

export default useDeleteFile;
