import { DRIVE_STORAGE_STATS_QUERY_KEY } from "@/app/lib/hooks/api/useDriveStorageStats";
import { SHARES_QUERY_KEY } from "@/app/lib/hooks/useSharedFiles";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import { useMutation } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { queryClientAtom } from "jotai-tanstack-query";
import { useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { toast } from "sonner";
import { useRef } from "react";

export type FileToDelete = FormattedUserFile;

/** What a delete is asked to do besides deleting. */
export interface DeleteFilesOptions {
  /**
   * "Also turn off its links": the links to turn off once each file is
   * deleted. Rust turns them off only after the delete succeeds.
   */
  turnOffLinks?: Map<FormattedUserFile, string[]>;
}

/** `delete_files`'s answer. */
interface DeleteFilesResult {
  deleted: number;
  failed: Array<{ name: string; error: string }>;
  linksTurnedOff?: number;
  linksFailed?: number;
}

/**
 * What the toast adds about the links: how many were turned off, or, when
 * some could not be, where to turn them off by hand.
 */
export function linksOutcomeNote(turnedOff: number, failed: number): string | null {
  if (failed > 0) {
    return failed === 1
      ? "1 link couldn't be turned off: open Shared Links to turn it off."
      : `${failed} links couldn't be turned off: open Shared Links to turn them off.`;
  }
  if (turnedOff > 0) return turnedOff === 1 ? "Its link is turned off." : `${turnedOff} links are turned off.`;
  return null;
}

export const useDeleteFile = ({
    files,
}: {
    files: FileToDelete[],
}) => {
    const { polkadotAddress } = useWalletAuth();
    const queryClient = useAtomValue(queryClientAtom);

    // Track toast for proper cleanup
    const loadingToastRef = useRef<string | number | null>(null);

    return useMutation<DeleteFilesResult, Error, DeleteFilesOptions | void>({
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
        onSuccess: (result) => {
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

            const linksFailed = result?.linksFailed ?? 0;
            const links = linksOutcomeNote(result?.linksTurnedOff ?? 0, linksFailed);
            if (linksFailed > 0) {
                // The files are gone; only some links are still on.
                toast.warning(`Deleted. ${links}`);
            } else {
                toast.success(links ? `${successMessage}. ${links}` : successMessage);
            }
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
        mutationFn: async (options) => {
            if (files.length === 0) throw new Error("No files to delete");
            if (!polkadotAddress) throw new Error("Wallet not connected");

            // Single Rust call handles path resolution, deletion, and sync trigger
            const turnOffLinks = options ? options.turnOffLinks : undefined;
            const result = await invoke<DeleteFilesResult>(
                "delete_files",
                {
                    accountId: polkadotAddress,
                    files: files.map((f) => ({
                        name: f.actualFileName || f.name,
                        source: f.source ?? null,
                        label: f.label ?? null,
                        size: f.size ?? 0,
                        turnOffLinks: turnOffLinks?.get(f) ?? [],
                    })),
                }
            );

            if (result.failed.length > 0) {
                const errorMessages = result.failed.map((f) => `${f.name}: ${f.error}`).join("; ");
                throw new Error(`Failed to delete some files: ${errorMessages}`);
            }

            // Notify sync progress system so the widget refreshes immediately
            window.dispatchEvent(new CustomEvent("sync_progress_update"));

            // Refresh every file audience: the TanStack-cached lists AND the
            // non-cached nested folder listings. The latter is what makes a
            // delete inside a subfolder visible without navigating away —
            // see `notifyFilesMutated`.
            await Promise.all([
                notifyFilesMutated(queryClient, polkadotAddress),
                queryClient.invalidateQueries({
                    queryKey: [DRIVE_STORAGE_STATS_QUERY_KEY],
                }),
                // Links turned off leave Shared Links and every Insights button.
                (result.linksTurnedOff ?? 0) > 0
                    ? queryClient.invalidateQueries({ queryKey: [SHARES_QUERY_KEY] })
                    : Promise.resolve(),
            ]);
            return result;
        },
    });
};

export default useDeleteFile;
