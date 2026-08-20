import { useMutation } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { queryClientAtom } from "jotai-tanstack-query";
import { useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
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

            return await invoke<RenameEntryResult>("rename_entry", {
                accountId: polkadotAddress,
                file: {
                    name: file.actualFileName || file.name,
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
