import useUserIpfsFiles, {
    GET_USER_IPFS_FILES_QUERY_KEY,
} from "@/lib/hooks/use-user-ipfs-files";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { useMutation } from "@tanstack/react-query";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { queryClientAtom } from "jotai-tanstack-query";
import { useAtomValue } from "jotai";

export const useDeleteIpfsFile = ({ cid }: { cid: string }) => {
    const { data: ipfsFiles } = useUserIpfsFiles();
    const { api } = usePolkadotApi();
    const { polkadotAddress, walletManager } = useWalletAuth();

    const queryClient = useAtomValue(queryClientAtom);

    return useMutation({
        mutationKey: ["delete-ipfs-file", cid],

        mutationFn: async () => {
            if (!ipfsFiles) throw new Error("No Files Found");
            if (!api) throw new Error("Polkadot API not initialised");
            if (!walletManager) throw new Error("Error getting wallet manager");

            const fileToDelete = ipfsFiles.files.find((f) => f.cid === cid);

            if (!fileToDelete) throw new Error("Cannot find file");

            // Create the file input object
            const deleteFileInput = [{
                cid: decodeHexCid(fileToDelete.cid),
                filename: fileToDelete.name,
            }];

            // Use the converted string in the transaction
            const tx = api.tx.marketplace.storageUnpinRequest(deleteFileInput);

            await new Promise((resolve, reject) => {
                tx.signAndSend(
                    walletManager.polkadotPair,
                    { nonce: -1 },
                    async ({ status, events, dispatchError }) => {

                        // Check for dispatch errors (errors that occur during transaction execution)
                        if (dispatchError) {
                            let errorMessage = "Transaction failed";

                            if (dispatchError.isModule) {
                                // For module errors, we can extract the error information
                                const decoded = api.registry.findMetaError(
                                    dispatchError.asModule
                                );
                                errorMessage = `${decoded.section}.${decoded.name
                                    }: ${decoded.docs.join(" ")}`;
                                console.error("Module error:", errorMessage);
                            } else if (dispatchError.isToken) {
                                errorMessage = `Token error: ${dispatchError.asToken.toString()}`;
                                console.error("Token error:", dispatchError.asToken.toString());
                            } else {
                                console.error("Dispatch error:", dispatchError.toString());
                                errorMessage = dispatchError.toString();
                            }

                            // toast({
                            //   title: "Error unpinning file",
                            //   description: errorMessage,
                            //   variant: "destructive",
                            //   className: "bg-white border border-red-200 text-red-800",
                            // });

                            return reject(new Error("Error unpinning file"));
                        }

                        if (status.isInBlock || status.isFinalized) {
                            // Get the appropriate block hash based on status type
                            // const blockHash = status.isInBlock
                            //   ? status.asInBlock.toString()
                            //   : status.isFinalized
                            //   ? status.asFinalized.toString()
                            //   : "unknown";

                            // Check for events
                            let success = false;
                            let errorOccurred = false;
                            let errorMessage = "";

                            events.forEach(({ event }: { event: any }) => {

                                if (api.events.system.ExtrinsicSuccess.is(event)) {
                                    success = true;
                                } else if (api.events.system.ExtrinsicFailed.is(event)) {
                                    console.error("Unpin transaction failed");
                                    errorOccurred = true;

                                    // Extract error information
                                    const [dispatchError] = event.data as any;
                                    if (dispatchError.isModule) {
                                        const decoded = api.registry.findMetaError(
                                            dispatchError.asModule
                                        );
                                        errorMessage = `${decoded.section}.${decoded.name
                                            }: ${decoded.docs.join(" ")}`;
                                        console.error("Module error:", errorMessage);
                                    } else {
                                        errorMessage = dispatchError.toString();
                                        console.error("Dispatch error:", dispatchError.toString());
                                    }
                                } else if (event.section === "marketplace") {
                                    // Log marketplace-specific events
                                    console.log(
                                        `Marketplace event: ${event.method}`,
                                        event.data.toString()
                                    );
                                }
                            });

                            if (success && !errorOccurred) {

                                await queryClient.refetchQueries({
                                    queryKey: [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress],
                                });

                                return resolve(undefined);
                            } else if (errorOccurred) {
                                return reject(new Error("Error unpinning file"));
                            }
                        }
                    }
                );
            });
        },
    });
};

export default useDeleteIpfsFile;
