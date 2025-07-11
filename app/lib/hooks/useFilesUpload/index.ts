// src/lib/hooks/useFilesUpload.ts
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

    const [requestState, setRequestState] = useState<"idle" | "uploading" | "submitting">("idle");
    const idleTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (idleTimeout.current) clearTimeout(idleTimeout.current);
        },
        []
    );

    async function upload(files: FileList) {
        if (idleTimeout.current) clearTimeout(idleTimeout.current);

        const startMsg =
            files.length > 1
                ? `Uploading ${files.length} files: 0%`
                : "Uploading file: 0%";
        const toastId = toast.loading(startMsg, { position: "top-center" });

        setRequestState("uploading");
        setProgress(0);

        try {
            const credits = (await checkCredits()).data;
            if (!credits || credits <= BigInt(0)) {
                throw new Error("Insufficient Credits. Please add credits.");
            }

            const arr = Array.from(files);
            const cids: string[] = [];

            // 0–50%: upload to IPFS via local HTTP API
            for (let i = 0; i < arr.length; i++) {
                const file = arr[i];
                // POST to IPFS daemon
                const formData = new FormData();
                formData.append("file", file);
                const res = await fetch("http://localhost:5001/api/v0/add", {
                    method: "POST",
                    body: formData,
                });
                if (!res.ok) {
                    throw new Error(`IPFS upload failed: ${res.statusText}`);
                }
                const text = await res.text();
                const firstLine = text.split("\n")[0];
                const data = JSON.parse(firstLine);
                const cid = data.Hash as string;
                cids.push(cid);

                const percent = Math.round(((i + 1) / arr.length) * 50);
                setProgress(percent);
                const msg =
                    files.length > 1
                        ? `Uploading ${files.length} files: ${percent}%`
                        : `Uploading file: ${percent}%`;
                toast.loading(msg, { id: toastId, position: "top-center" });
            }

            // 75%: about to call Tauri
            setRequestState("submitting");
            setProgress(75);
            toast.loading(
                files.length > 1
                    ? `Uploading ${files.length} files: 75%`
                    : `Uploading file: 75%`,
                { id: toastId, position: "top-center" }
            );

            // build the FileInputWrapper list
            const inputs = cids.map((cid, idx) => ({
                file_hash: Array.from(new TextEncoder().encode(cid)),
                file_name: Array.from(new TextEncoder().encode(arr[idx].name)),
            }));

            await invoke<string>("storage_request_tauri", {
                filesInput: inputs,
                minerIds: null,
                seedPhrase: mnemonic,
            });

            // 100%
            setProgress(100);
            toast.loading(
                files.length > 1
                    ? `Uploading ${files.length} files: 100%`
                    : `Uploading file: 100%`,
                { id: toastId, position: "top-center" }
            );

            setRequestState("idle");
            idleTimeout.current = setTimeout(() => {
                refetchUserFiles();
                onSuccess?.();
                toast.success(
                    files.length > 1
                        ? `${files.length} files successfully uploaded!`
                        : `File successfully uploaded!`,
                    { id: toastId, position: "top-center" }
                );
            }, 500);
        } catch (err) {
            console.log("err", err)
            setRequestState("idle");
            setProgress(0);
            onError?.(err);
            toast.error(
                files.length > 1
                    ? `${files.length} files failed to upload!`
                    : `File failed to upload!`,
                { id: toastId, position: "top-center" }
            );
        }
    }

    return { upload, requestState };
}

export default useFilesUpload;
