// src/lib/hooks/useFilesUpload.ts
import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
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
  const { data: credits } = useUserCredits();
  const { refetch: refetchUserFiles } = useUserIpfsFiles();
  const { mnemonic, polkadotAddress } = useWalletAuth();

  const [requestState, setRequestState] = useState<
    "idle" | "uploading" | "submitting"
  >("idle");
  const idleTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (idleTimeout.current) clearTimeout(idleTimeout.current);
    },
    []
  );

  async function upload(
    files: FileList,
    isPrivateView: boolean,
    useErasureCoding: boolean = false
  ) {
    if (idleTimeout.current) clearTimeout(idleTimeout.current);

    // start toast and progress
    const toastId = toast.loading(
      files.length > 1
        ? `Uploading ${files.length} files: 0%`
        : "Uploading file: 0%"
    );
    setRequestState("uploading");
    setProgress(0);

    try {
      // check credits as before
      if (!credits || credits <= BigInt(0)) {
        throw new Error("Insufficient Credits. Please add credits.");
      }

      const arr = Array.from(files);
      const cids: string[] = [];

      // encrypt & upload each file via Tauri
      for (let i = 0; i < arr.length; i++) {
        const file = arr[i];
        const arrayBuffer = await file.arrayBuffer();
        const tempPath = `/tmp/${file.name}`;

        // write to disk
        await invoke("write_file", {
          path: tempPath,
          data: Array.from(new Uint8Array(arrayBuffer))
        });
        let cid;
        // encrypt & upload
        if (isPrivateView) {
          cid = await invoke<string>("encrypt_and_upload_file", {
            accountId: polkadotAddress,
            filePath: tempPath,
            seedPhrase: mnemonic,
            encryptionKey: null
          });
        } else if (!isPrivateView && useErasureCoding) {
          cid = await invoke<string>("public_upload_with_erasure", {
            accountId: polkadotAddress,
            filePath: tempPath,
            seedPhrase: mnemonic
          });
        } else {
          cid = await invoke<string>("upload_file_public", {
            accountId: polkadotAddress,
            filePath: tempPath,
            seedPhrase: mnemonic
          });
        }
        cids.push(cid);

        // update progress
        const percent = Math.round(((i + 1) / arr.length) * 100);
        setProgress(percent);
        const msg =
          files.length > 1
            ? `Uploading ${files.length} files: ${percent}%`
            : `Uploading file: ${percent}%`;
        toast.loading(msg, { id: toastId });
      }

      // finish up
      setRequestState("idle");
      idleTimeout.current = setTimeout(() => {
        refetchUserFiles();
        onSuccess?.();
        toast.success(
          files.length > 1
            ? `${files.length} files successfully uploaded!`
            : `File successfully uploaded!`,
          { id: toastId }
        );
      }, 500);
    } catch (err) {
      setRequestState("idle");
      setProgress(0);
      onError?.(err);
      console.log("error", err);
      toast.error(
        files.length > 1
          ? `${files.length} files failed to upload!`
          : `File failed to upload!`,
        { id: toastId }
      );
    }
  }

  return { upload, requestState };
}

export default useFilesUpload;
