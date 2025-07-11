import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useUserCredits } from "../use-user-credits";
import { useUserIpfsFiles } from "../use-user-ipfs-files";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useSetAtom } from "jotai";
import { uploadProgressAtom } from "@/app/components/page-sections/files/ipfs/atoms/query-atoms";
import { toast } from "sonner";

export type UploadFilesHandlers = {
    onSuccess?: () => void;
    onError?: (err: Error | unknown) => void;
};

export function useFilesUpload(handlers: UploadFilesHandlers) {
    const { onSuccess, onError } = handlers;
    const setProgress = useSetAtom(uploadProgressAtom);
    const { refetch: checkCredits } = useUserCredits();
    const { refetch: refetchUserFiles } = useUserIpfsFiles();
    const { mnemonic } = useWalletAuth();

    const [requestState, setRequestState] = useState<
        "idle" | "uploading" | "submitting"
    >("idle");
    const idleTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const timeout = idleTimeout.current;
        return () => {
            if (timeout) clearTimeout(timeout);
        };
    }, []);

    async function upload(files: FileList) {
        if (idleTimeout.current) {
            clearTimeout(idleTimeout.current);
        }
        console.log("⚡ upload() fired")
        const msg = files.length > 1
            ? `Uploading ${files.length} files: 0%`
            : "Uploading file: 0%";
        const toastId = toast.loading(msg);
        setRequestState("uploading");
        setProgress(0);

        try {
            const credits = (await checkCredits()).data;
            if (!credits || credits <= BigInt(0)) {
                throw new Error("Insufficient Credits. Please add credits.");
            }

            const arr = Array.from(files);
            for (let i = 0; i < arr.length; i++) {
                await arr[i].arrayBuffer();
                setProgress(Math.round(((i + 1) / arr.length) * 50));
                const msg = files.length > 1
                    ? `Uploading ${files.length} files: ${Math.round(((i + 1) / arr.length) * 100)}%`
                    : `Uploading file: ${Math.round(((i + 1) / arr.length) * 100)}%`;
                toast.loading(msg, { id: toastId });
            }

            const inputs = await Promise.all(
                arr.map(async file => ({
                    file_hash: Array.from(new Uint8Array(await file.arrayBuffer())),
                    file_name: Array.from(new TextEncoder().encode(file.name)),
                }))
            );

            setRequestState("submitting");
            setProgress(75);
            toast.loading(files.length > 1
                ? `Uploading ${files.length} files: 75%`
                : `Uploading file: 75%`, { id: toastId });

            await invoke<string>("storage_request_tauri", {
                filesInput: inputs,
                minerIds: null,
                seedPhrase: mnemonic,
            });

            setProgress(100);
            toast.loading(files.length > 1
                ? `Uploading ${files.length} files: 100%`
                : `Uploading file: 100%`, { id: toastId });

            setRequestState("idle");
            setTimeout(() => {
                refetchUserFiles();
                onSuccess?.();
                toast.success(files.length > 1
                    ? `${files.length} files successfully uploaded!`
                    : `File successfully uploaded!`, { id: toastId });
            }, 2000);
        } catch (err) {
            setRequestState("idle");
            setProgress(0);
            onError?.(err);
            toast.error(files.length > 1
                ? `${files.length} files failed to upload!`
                : `File failed to upload!`, { id: toastId });
        }
    }

    return { upload, requestState };
}

export default useFilesUpload;
