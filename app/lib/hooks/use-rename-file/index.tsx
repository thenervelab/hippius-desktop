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
        onSuccess: async (_result, { file, newName }) => {
            const oldName = file.actualFileName || file.name;
            toast.success(`Renamed "${oldName.split("/").pop()}" to "${newName}"`);

            // Wakes the TanStack lists AND the non-cached nested-folder
            // listings (DriveContainer subfolder view, ExpandedFolderRows).
            await notifyFilesMutated(queryClient, polkadotAddress);
        },
        onError: (error: Error, { file }) => {
            const name = (file.actualFileName || file.name).split("/").pop();
            // AppError serializes to { kind, message }; invoke rejections carry
            // the message through, falling back to String(error) for non-shaped
            // failures (e.g. IPC transport errors).
            const message = error?.message ?? String(error);
            toast.error(`Failed to rename "${name}": ${message}`);
        },
    });
};

export default useRenameFile;
