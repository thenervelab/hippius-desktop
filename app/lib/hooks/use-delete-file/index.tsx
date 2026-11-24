import { DRIVE_STORAGE_STATS_QUERY_KEY } from "@/app/lib/hooks/api/useDriveStorageStats";
import { SHARES_QUERY_KEY } from "@/app/lib/hooks/useSharedFiles";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { queryClientAtom } from "jotai-tanstack-query";
import { useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { toast } from "sonner";
import { useRef } from "react";
import { moveToTrash, newTrashJobId, onTrashProgress, type MoveToTrashResult } from "@/app/lib/tauri/trash";
import { movingToTrashMessage } from "@/app/lib/trash/copy";
import { showMovedToTrashToast } from "@/app/lib/trash/trashToast";
import type { DeleteMode } from "@/app/lib/trash/deleteMode";

export type FileToDelete = FormattedUserFile;

/** What a delete is asked to do besides deleting. */
export interface DeleteFilesOptions {
  /**
   * "Also turn off its links": the links to turn off once each file is
   * deleted. Rust turns them off only after the delete succeeds.
   */
  turnOffLinks?: Map<FormattedUserFile, string[]>;
  /**
   * `trash`: Move to Trash, with Undo. Anything else is today's permanent
   * delete (`forever` only changes the words around it).
   */
  mode?: DeleteMode;
}

/** `delete_files`'s answer, or `move_to_trash`'s under `trash`. */
interface DeleteFilesResult {
  deleted: number;
  failed: Array<{ name: string; error: string }>;
  linksTurnedOff?: number;
  linksFailed?: number;
  trash?: MoveToTrashResult;
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

function names(files: FileToDelete[]): string[] {
    return files.map((f) => f.actualFileName?.split("/").pop() || f.name);
}

/** What every delete refreshes: listings, storage figures. */
async function refreshAfterDelete(queryClient: QueryClient, address: string) {
    await Promise.all([
        notifyFilesMutated(queryClient, address),
        queryClient.invalidateQueries({ queryKey: [DRIVE_STORAGE_STATS_QUERY_KEY] }),
    ]);
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
        onMutate: (options) => {
            if (options && options.mode === "trash") {
                loadingToastRef.current = toast.loading(movingToTrashMessage(names(files)));
                return;
            }
            const fileCount = files.length;
            const isMultiple = fileCount > 1;
            const firstFileName = files[0]?.actualFileName || files[0]?.name || "file";

            const loadingMessage = isMultiple
                ? `Deleting ${fileCount} files...`
                : `Deleting "${firstFileName}"...`;

            loadingToastRef.current = toast.loading(loadingMessage);
        },
        onSuccess: (result) => {
            if (result.trash && polkadotAddress) {
                // The loading toast becomes the result, with Undo.
                const toastId = loadingToastRef.current ?? undefined;
                loadingToastRef.current = null;
                showMovedToTrashToast({
                    toastId,
                    names: names(files),
                    result: result.trash,
                    accountId: polkadotAddress,
                    onChanged: () => refreshAfterDelete(queryClient, polkadotAddress),
                });
                return;
            }
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
        onError: (error: Error, options) => {
            if (loadingToastRef.current) {
                toast.dismiss(loadingToastRef.current);
                loadingToastRef.current = null;
            }

            const fileCount = files.length;
            const isMultiple = fileCount > 1;
            const firstFileName = files[0]?.actualFileName || files[0]?.name || "file";

            if (options && options.mode === "trash") {
                toast.error(
                    isMultiple ? "Couldn't move these items to Trash" : `Couldn't move “${names(files)[0]}” to Trash`,
                    { description: error.message },
                );
                return;
            }

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

            if (options && options.mode === "trash") {
                const jobId = newTrashJobId();
                const loadingId = loadingToastRef.current;
                const stop = await onTrashProgress(jobId, (progress) => {
                    if (loadingId !== null) toast.loading(movingToTrashMessage(names(files), progress), { id: loadingId });
                }).catch(() => null);
                let trash: MoveToTrashResult;
                try {
                    trash = await moveToTrash(polkadotAddress, jobId, files.map((f) => ({
                        name: f.actualFileName || f.name,
                        source: f.source ?? null,
                        label: f.label ?? null,
                    })));
                } finally {
                    stop?.();
                }
                if (trash.trashed === 0) {
                    const reasons = trash.failed.map((f) => f.error).join(" ");
                    throw new Error(reasons || "Nothing was moved to Trash.");
                }
                window.dispatchEvent(new CustomEvent("sync_progress_update"));
                await refreshAfterDelete(queryClient, polkadotAddress);
                return { deleted: trash.trashed, failed: [], trash };
            }

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
