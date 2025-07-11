// src/lib/hooks/useFilesUpload.ts
import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useUserCredits } from "../use-user-credits";
import { useUserIpfsFiles } from "../use-user-ipfs-files";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useSetAtom } from "jotai";
import { uploadProgressAtom } from "@/app/components/page-sections/files/ipfs/atoms/query-atoms";

export type UploadFilesHandlers = {
    onSuccess?: () => void;
    onError?: (err: Error | unknown) => void;
};

export function useFilesUpload(
    handlers: UploadFilesHandlers
) {
    const { onSuccess, onError } = handlers;
    const setProgress = useSetAtom(uploadProgressAtom);
    const { refetch: checkCredits } = useUserCredits();
    const { refetch: refetchUserFiles } = useUserIpfsFiles();
    const { mnemonic } = useWalletAuth();

    const [requestState, setRequestState] = useState<
        "idle" | "uploading" | "submitting"
    >("idle");
    const idleTimeout = useRef<ReturnType<typeof setTimeout>>();

    useEffect(() => () => clearTimeout(idleTimeout.current), []);

    async function upload(files: FileList) {
        clearTimeout(idleTimeout.current);
        setRequestState("uploading");
        setProgress(0);

        try {
            // 1. Credits check
            const credits = (await checkCredits()).data;
            if (!credits || credits <= BigInt(0)) {
                throw new Error("Insufficient Credits. Please add credits.");
            }

            // 2. Build inputs & report 0–50%
            const arr = Array.from(files);
            for (let i = 0; i < arr.length; i++) {
                const buf = await arr[i].arrayBuffer();
                // no need to await hash: just collect
                await Promise.resolve();
                setProgress(Math.round(((i + 1) / arr.length) * 50));
            }
            const inputs = await Promise.all(
                arr.map(async file => ({
                    file_hash: Array.from(new Uint8Array(await file.arrayBuffer())),
                    file_name: Array.from(new TextEncoder().encode(file.name)),
                }))
            );

            console.log("inputs:", inputs);
            // 3. Invoke & report 75%
            setRequestState("submitting");
            setProgress(75);
            await invoke<string>("storage_request_tauri", {
                filesInput: inputs,
                minerIds: null,
                seedPhrase: mnemonic,
            });

            // 4. Finish
            setProgress(100);
            setRequestState("idle");
            onSuccess?.();
            refetchUserFiles();
        } catch (err) {
            setRequestState("idle");
            setProgress(0);
            onError?.(err);
        }
    }

    return { upload, requestState };
}

export default useFilesUpload;