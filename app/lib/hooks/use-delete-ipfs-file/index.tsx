/* eslint-disable @typescript-eslint/no-explicit-any */
import useUserIpfsFiles, {
    GET_USER_IPFS_FILES_QUERY_KEY,
} from "@/lib/hooks/use-user-ipfs-files";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { useMutation } from "@tanstack/react-query";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { queryClientAtom } from "jotai-tanstack-query";
import { useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";

import type { SubmittableResult } from "@polkadot/api";
import type { DispatchError } from "@polkadot/types/interfaces";

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
    const { api } = usePolkadotApi();
    const { walletManager, polkadotAddress, mnemonic } = useWalletAuth();
    const queryClient = useAtomValue(queryClientAtom);

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

                try {
                    const command = isPrivateFolder ? "remove_file_from_private_folder" : "remove_file_from_public_folder";
                    const params = {
                        accountId: polkadotAddress,
                        folderMetadataCid: folderCid,
                        folderName: folderName,
                        fileName: fileToDelete.name,
                        seedPhrase: mnemonic,
                        subfolderPath: null
                    }
                    console.log("params", params);
                    await invoke<string>(command, params);
                    return true;
                } catch (error) {
                    console.error("Failed to delete file from folder:", error);
                    throw new Error(`Failed to delete file from folder: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            // Handle local file deletion
            if (fileToDelete.isFolder || (fileToDelete.source && fileToDelete.source !== "Hippius")) {
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

            // Handle Hippius-sourced file deletion (blockchain unpinning)
            const deleteInput = [
                {
                    cid: decodeHexCid(fileToDelete.cid),
                    filename: fileToDelete.name,
                },
            ];

            const tx = api.tx.marketplace.storageUnpinRequest(deleteInput);

            await new Promise<void>((resolve, reject) => {
                tx.signAndSend(
                    walletManager.polkadotPair,
                    { nonce: -1 },
                    async (result: SubmittableResult) => {
                        const { status, events, dispatchError } = result;

                        if (dispatchError) {
                            let errorMessage = "Transaction failed";
                            if (dispatchError.isModule) {
                                const metaErr = api.registry.findMetaError(dispatchError.asModule);
                                errorMessage = `${metaErr.section}.${metaErr.name}: ${metaErr.docs.join(" ")}`;
                            } else if (dispatchError.isToken) {
                                errorMessage = `Token error: ${dispatchError.asToken.toString()}`;
                            }
                            return reject(new Error(errorMessage));
                        }

                        if (status.isInBlock || status.isFinalized) {
                            let success = false;
                            let errorOccurred = false;
                            let errorMessage = "";

                            events.forEach(({ event }: { event: any }) => {
                                if (api.events.system.ExtrinsicSuccess.is(event)) {
                                    success = true;
                                } else if (api.events.system.ExtrinsicFailed.is(event)) {
                                    errorOccurred = true;
                                    const [dispatchErrFromEvent] = event.data as unknown as [DispatchError];
                                    if (dispatchErrFromEvent.isModule) {
                                        const metaErr = api.registry.findMetaError(
                                            dispatchErrFromEvent.asModule
                                        );
                                        errorMessage = `${metaErr.section}.${metaErr.name}: ${metaErr.docs.join(" ")}`;
                                    } else {
                                        errorMessage = dispatchErrFromEvent.toString();
                                    }
                                }
                            });

                            if (success && !errorOccurred) {
                                await queryClient.refetchQueries({
                                    queryKey: [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress],
                                });
                                return resolve();
                            } else {
                                return reject(new Error(errorMessage || "Error unpinning file"));
                            }
                        }
                    }
                );
            });
        },
    });
};

export default useDeleteIpfsFile;
