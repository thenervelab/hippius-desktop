import { useMutation } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { queryClientAtom } from "jotai-tanstack-query";
import { useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import { remoteDriveLabel } from "@/app/lib/utils/renameGating";
import { driveRelativePathFor } from "@/app/lib/utils/driveRelativePath";
import { toast } from "sonner";
import { basenameOf } from "@/app/components/page-sections/drive/renameValidation";

export interface RenameFileArgs {
    file: FormattedUserFile;
    newName: string;
}

interface RenameEntryResult {
    newRelativePath: string;
}

/**
 * Rename a file or folder inside a sync drive.
 *
 * Thin wrapper around the `rename_entry` Rust command — all resolution,
 * validation, the on-disk rename, and the sync trigger live in Rust
 * (`src-tauri/src/sync/files.rs`). The sync engine then propagates the
 * rename to the server as a true rename (no re-upload). Mirrors
 * `useDeleteFile`'s refetch set so the drive table and recent files
 * reflect the new name immediately.
 */
export const useRenameFile = () => {
    const { polkadotAddress } = useWalletAuth();
    const queryClient = useAtomValue(queryClientAtom);

    return useMutation({
        mutationFn: async ({ file, newName }: RenameFileArgs) => {
            if (!polkadotAddress) throw new Error("Wallet not connected");

            // A row in a browsed REMOTE drive has nothing on disk to move,
            // so it renames on the server instead. The same resolver the
            // menu gate uses names the drive; the row's path names the
            // folder within it.
            // A folder row shows a basename and keeps its path beside it,
            // so the path has to be rebuilt — sending the basename renamed
            // a folder of the same name at the drive root, or more often
            // nothing at all, which is the error the user saw.
            const relativePath = driveRelativePathFor(file);

            const remoteLabel = remoteDriveLabel(file);
            if (remoteLabel) {
                const relative = relativePath.replace(/\\/g, "/");
                const cut = relative.lastIndexOf("/");
                // A FOLDER is a different operation, not a variant of the
                // file one. On the server a folder is not a record — it is
                // a prefix shared by every file under it — so renaming it
                // means re-keying all of them in one batch. Sending a
                // folder through the file command moved nothing, or moved
                // an empty marker and orphaned the contents.
                const command = file.isFolder
                    ? "rename_remote_folder"
                    : "rename_remote_file";
                await invoke(command, {
                    accountId: polkadotAddress,
                    label: remoteLabel,
                    parentPath: cut > 0 ? relative.slice(0, cut) : null,
                    oldName: cut >= 0 ? relative.slice(cut + 1) : relative,
                    newName,
                });
                return { newRelativePath: relative.slice(0, cut + 1) + newName };
            }

            return await invoke<RenameEntryResult>("rename_entry", {
                accountId: polkadotAddress,
                file: {
                    name: relativePath,
                    source: file.source ?? null,
                    label: file.label ?? null,
                    newName,
                },
            });
        },
        // The dialog closes the moment this is fired, so the toast is the
        // ONLY thing reporting the rename from here on. It starts as a
        // loading toast and is replaced in place by the outcome, which is
        // the same id-reuse the delete and download flows use.
        //
        // A rename is not always instant: one inside a browsed remote
        // drive walks the folder, moves every record in it and rewrites
        // its directory rows. Without a pending toast that work would
        // happen behind a screen that shows nothing at all.
        onMutate: ({ file, newName }) => {
            const oldName = basenameOf(file.actualFileName || file.name);
            return {
                toastId: toast.loading(`Renaming "${oldName}" to "${newName}"\u2026`),
                oldName,
            };
        },
        onSuccess: async (_result, { newName }, context) => {
            toast.success(`Renamed "${context?.oldName}" to "${newName}"`, {
                id: context?.toastId,
            });

            // Wakes the TanStack lists AND the non-cached nested-folder
            // listings (DriveContainer subfolder view, ExpandedFolderRows).
            await notifyFilesMutated(queryClient, polkadotAddress);
        },
        onError: (error: Error, { file }, context) => {
            const name = basenameOf(file.actualFileName || file.name);
            // AppError serializes to { kind, message }; invoke rejections carry
            // the message through, falling back to String(error) for non-shaped
            // failures (e.g. IPC transport errors).
            const message = error?.message ?? String(error);
            // Replaces the pending toast rather than stacking beside it —
            // the dialog is already gone, so a leftover "Renaming…" would
            // sit there forever next to the failure.
            toast.error(`Failed to rename "${name}": ${message}`, {
                id: context?.toastId,
            });
        },
    });
};

export default useRenameFile;
