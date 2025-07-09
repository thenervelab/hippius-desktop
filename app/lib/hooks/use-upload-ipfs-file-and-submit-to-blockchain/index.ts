import { useEffect, useRef } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
    uploadFilesToIpfsAtom,
    submitFilesToBlockchainAtom,
    uploadToIpfsAndSubmitToBlockcahinRequestStateAtom,
    UploadFilesToIpfsAtomHandlers,
    uploadProgressAtom,
} from "@/components/page-sections/files/ipfs/atoms/query-atoms";
import { useUserCredits } from "../use-user-credits";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import useUserIpfsFiles from "../use-user-ipfs-files";

export const useUploadIpfsFileAndSubmitToBlockchain = (
    props: UploadFilesToIpfsAtomHandlers & {
        onSuccess?: () => void;
        onError?: (err: Error | unknown) => void;
    }
) => {
    const { mutateAsync: uploadFilesToIpfs } = useAtomValue(
        uploadFilesToIpfsAtom
    );
    const { mutateAsync: submitFiles } = useAtomValue(
        submitFilesToBlockchainAtom
    );
    const idleSetterTimeout = useRef<ReturnType<typeof setTimeout>>();

    const { refetch: refetchUserFiles } = useUserIpfsFiles();

    const [requestState, setRquestState] = useAtom(
        uploadToIpfsAndSubmitToBlockcahinRequestStateAtom
    );
    const { refetch: getUserCredits } = useUserCredits();
    const setUploadProgress = useSetAtom(uploadProgressAtom);

    const { polkadotAddress, walletManager } = useWalletAuth();

    const { api, isConnected } = usePolkadotApi();

    if (!api || !isConnected || !polkadotAddress) {
        throw new Error("Blockchain connection not available");
    }

    if (!walletManager || !walletManager.polkadotPair) {
        throw new Error("Wallet keypair not available");
    }

    const upload = (files: Parameters<typeof uploadFilesToIpfs>[0]["files"]) => {
        clearTimeout(idleSetterTimeout.current);
        setRquestState("uploading");
        setUploadProgress(0);

        uploadFilesToIpfs({
            files,
            creditsChecker: getUserCredits,
            onUploadProgress: (value) => {
                setUploadProgress(value);
            },
        })
            .then(({ infoFile }) => {
                setRquestState("submitting");

                return submitFiles({
                    infoFile,
                    polkadotPair: walletManager.polkadotPair,
                    api,
                });
            })
            .then(() => {
                setRquestState("idle");
                if (props.onSuccess) {
                    props.onSuccess();
                }
                refetchUserFiles();
            })
            .catch((error) => {
                setRquestState("idle");
                if (props.onError) {
                    props.onError(error);
                }
            });
    };

    useEffect(() => {
        const currentTimeout = idleSetterTimeout.current;

        return () => {
            clearTimeout(currentTimeout);
        };
    }, [props]);

    return {
        upload,
        requestState,
    };
};

export default useUploadIpfsFileAndSubmitToBlockchain;
