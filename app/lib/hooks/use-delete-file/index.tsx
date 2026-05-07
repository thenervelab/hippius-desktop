import {
    GET_USER_IPFS_FILES_QUERY_KEY,
} from "@/app/lib/hooks/use-user-files";
import { DRIVE_STORAGE_STATS_QUERY_KEY } from "@/app/lib/hooks/api/useDriveStorageStats";
import { useMutation } from "@tanstack/react-query";
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

            // Single Rust call handles path resolution, deletion, and sync trigger
            const result = await invoke<{ deleted: number; failed: Array<{ name: string; error: string }> }>(
                "delete_files",
                {
                    accountId: polkadotAddress,
                    files: files.map((f) => ({
                        name: f.actualFileName || f.name,
                        source: f.source ?? null,
                        label: f.label ?? null,
                        size: f.size ?? 0,
                    })),
                }
            );

            if (result.failed.length > 0) {
                const errorMessages = result.failed.map((f) => `${f.name}: ${f.error}`).join("; ");
                throw new Error(`Failed to delete some files: ${errorMessages}`);
            }

            // Notify sync progress system so the widget refreshes immediately
            window.dispatchEvent(new CustomEvent("sync_progress_update"));

            // Refetch file listing and recent files
            await Promise.all([
                queryClient.refetchQueries({
                    queryKey: [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress],
                }),
                queryClient.refetchQueries({
                    queryKey: ["recent-files"],
                }),
                queryClient.invalidateQueries({
                    queryKey: [DRIVE_STORAGE_STATS_QUERY_KEY],
                }),
            ]);
        },
    });
};

export default useDeleteFile;
