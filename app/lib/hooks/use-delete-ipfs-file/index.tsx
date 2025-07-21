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

import type { SubmittableResult } from "@polkadot/api";
import type { DispatchError } from "@polkadot/types/interfaces";

export const useDeleteIpfsFile = ({ cid }: { cid: string }) => {
    const { data: ipfsFiles } = useUserIpfsFiles();
    const { api } = usePolkadotApi();
    const { walletManager, polkadotAddress, mnemonic } = useWalletAuth();
    const queryClient = useAtomValue(queryClientAtom);

    return useMutation({
        mutationKey: ["delete-ipfs-file", cid],
        mutationFn: async () => {
            if (!ipfsFiles) throw new Error("No Files Found");
            if (!api) throw new Error("Polkadot API not initialised");
            if (!walletManager) throw new Error("Error getting wallet manager");

            const fileToDelete = ipfsFiles.files.find(f => f.cid === cid);
            if (!fileToDelete) throw new Error("Cannot find file");

            console.log("fileToDelete", fileToDelete);

            if (fileToDelete.source && fileToDelete.source !== "Hippius") {
                try {
                    if (!mnemonic) {
                        throw new Error("Seed phrase required to delete local files");
                    }

                    await invoke("delete_and_unpin_file_by_name", {
                        fileName: fileToDelete.name,
                        seedPhrase: mnemonic
                    });

                    await queryClient.refetchQueries({
                        queryKey: [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress],
                    });
                    console.log("Local file deleted successfully");
                    return;
                } catch (error) {
                    console.error("Failed to delete local file:", error);
                    throw new Error(`Failed to delete local file: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            console.log("Deleting file from blockchain", fileToDelete);

            // For Hippius-sourced files, use the blockchain unpinning process
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
