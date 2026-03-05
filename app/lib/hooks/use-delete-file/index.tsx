import {
    GET_USER_IPFS_FILES_QUERY_KEY,
} from "@/app/lib/hooks/use-user-files";
import { useMutation } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { queryClientAtom } from "jotai-tanstack-query";
import { useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getPrivateSyncPath } from "@/lib/utils/syncPathUtils";
import { toast } from "sonner";
import { useRef } from "react";

export type FileToDelete = FormattedUserFile;

export const useDeleteFile = ({
    files,
}: {
    files: FileToDelete[],
}) => {
    const { polkadotAddress } = useWalletAuth();
    const queryClient = useAtomValue(queryClientAtom);

    // Track toast for proper cleanup
    const loadingToastRef = useRef<string | number | null>(null);

    return useMutation({
        mutationKey: ["delete-files", files.map(f => f.actualFileName || f.name).join(',')],
        onMutate: () => {
            const fileCount = files.length;
            const isMultiple = fileCount > 1;
            const firstFileName = files[0]?.actualFileName || files[0]?.name || "file";

            const loadingMessage = isMultiple
                ? `Deleting ${fileCount} files...`
                : `Deleting "${firstFileName}"...`;

            loadingToastRef.current = toast.loading(loadingMessage);
        },
        onSuccess: () => {
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
            if (loadingToastRef.current) {
                toast.dismiss(loadingToastRef.current);
                loadingToastRef.current = null;
            }
        },
        mutationFn: async () => {
            if (files.length === 0) throw new Error("No files to delete");
            if (!polkadotAddress) throw new Error("Wallet not connected");

            const syncPath = (await getPrivateSyncPath(polkadotAddress)).path;
            const results = [];

            for (const file of files) {
                const fileName = file.actualFileName || file.name;

                try {
                    await invoke("remove_file", {
                        syncPath,
                        name: fileName,
                    });
                    results.push({ file, success: true });
                } catch (error) {
                    console.error(`Failed to delete ${file.isFolder ? 'folder' : 'file'}: ${fileName}`, error);
                    results.push({
                        file,
                        success: false,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }

            const failedDeletions = results.filter(r => !r.success);
            if (failedDeletions.length > 0) {
                const errorMessages = failedDeletions.map(f => `${f.file.name}: ${f.error}`).join('; ');
                throw new Error(`Failed to delete some files: ${errorMessages}`);
            }

            // Refetch file listing
            await queryClient.refetchQueries({
                queryKey: [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress],
            });

            return results;
        },
    });
};

export default useDeleteFile;
