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

export const useDeleteIpfsFile = ({
    cid,
    fileToDelete: file,
    folderCid,
    folderName,
    isPrivateFolder
}: {
    cid: string,
    fileToDelete: FormattedUserIpfsFile | null,
    folderCid?: string,
    folderName?: string,
    isPrivateFolder?: boolean
}) => {
    const { data: ipfsFiles } = useUserIpfsFiles();
    const { getParam } = useUrlParams();

    const { api } = usePolkadotApi();
    const { walletManager, polkadotAddress, mnemonic } = useWalletAuth();
    const queryClient = useAtomValue(queryClientAtom);
    const mainFolderActualName = getParam("mainFolderActualName", "");
    const subFolderPath = getParam("subFolderPath");


    return useMutation({
        mutationKey: ["delete-ipfs-file", cid],
        mutationFn: async () => {
            if (!ipfsFiles && !file) throw new Error("No Files Found");
            if (!api) throw new Error("Polkadot API not initialised");
            if (!walletManager) throw new Error("Error getting wallet manager");

            let fileToDelete = ipfsFiles?.files.find(f => f.cid === cid);

            if (!fileToDelete) {
                fileToDelete = file ?? undefined;
            }

            if (!fileToDelete) throw new Error("Cannot find file");
            // Handle file in folder deletion
            if (folderCid && folderName) {
                if (!mnemonic) {
                    throw new Error("Seed phrase required to delete files from folder");
                }

                const folderPath = getFolderPathArray(mainFolderActualName, subFolderPath);


                try {
                    const command = isPrivateFolder ? "remove_file_from_private_folder" : "remove_file_from_public_folder";
                    const params = {
                        accountId: polkadotAddress,
                        folderMetadataCid: folderCid,
                        folderName: folderName,
                        fileName: fileToDelete.name,
                        seedPhrase: mnemonic,
                        mainFolderName: mainFolderActualName || null,
                        subfolderPath: folderPath || null
                    }
                    console.log("params", params);
                    await invoke<string>(command, params);
                    return true;
                } catch (error) {
                    console.error("Failed to delete file from folder:", error);
                    throw new Error(`Failed to delete file from folder: ${error instanceof Error ? error.message : String(error)}`);
                }
            } else {
                try {
                    if (!mnemonic) {
                        throw new Error("Seed phrase required to delete local files");
                    }

                    await invoke("delete_and_unpin_file_by_name", {
                        fileName: fileToDelete.actualFileName,
                        seedPhrase: mnemonic
                    });

                    await queryClient.refetchQueries({
                        queryKey: [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress],
                    });
                    return true;
                } catch (error) {
                    console.error("Failed to delete local file:", error);
                    throw new Error(`Failed to delete local file: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        },
    });
};

export default useDeleteIpfsFile;
