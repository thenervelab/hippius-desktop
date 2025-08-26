import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import { useUserIpfsFiles } from "@/app/lib/hooks/use-user-ipfs-files";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useSetAtom } from "jotai";
import { uploadProgressAtom } from "@/app/components/page-sections/files/ipfs/atoms/query-atoms";
import { toast } from "sonner";

export type UploadFilesHandlers = {
  onSuccess?: () => void;
  onError?: (err: Error | unknown) => void;
};

// New: upload options to accept external toast id
export type UploadOptions = {
  toastId?: string | number;
  // future-proof overrides (optional)
  messages?: {
    startSingle?: string;
    startMultiple?: (count: number) => string;
    uploadingSingle?: (percent: number) => string;
    uploadingMultiple?: (count: number, percent: number) => string;
    successSingle?: string;
    successMultiple?: (count: number) => string;
    errorSingle?: string;
    errorMultiple?: (count: number) => string;
  };
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
    filePaths: string[],
    isPrivateView: boolean,
    options?: UploadOptions
  ) {
    if (idleTimeout.current) clearTimeout(idleTimeout.current);

    const msgs = options?.messages;
    const startText =
      filePaths.length > 1
        ? msgs?.startMultiple?.(filePaths.length) ?? `Uploading ${filePaths.length} files: 0%`
        : msgs?.startSingle ?? "Uploading file: 0%";

    // If a toastId is given, update that toast; otherwise create a new one
    let localToastId = options?.toastId;
    if (localToastId !== undefined) {
      toast.loading(startText, { id: localToastId });
    } else {
      localToastId = toast.loading(startText);
    }

    setRequestState("uploading");
    setProgress(0);

    try {
      // check credits as before
      if (!credits || credits <= BigInt(0)) {
        throw new Error("Insufficient Credits. Please add credits.");
      }

      const cids: string[] = [];

      console.log("Starting upload for files:", filePaths);

      // upload each file via Tauri using file paths
      for (let i = 0; i < filePaths.length; i++) {
        const filePath = filePaths[i];

        let cid;
        console.log("Uploading file:", filePath);
        if (isPrivateView) {
          cid = await invoke<string>("encrypt_and_upload_file", {
            accountId: polkadotAddress,
            filePath: filePath,
            seedPhrase: mnemonic
          });
        } else {
          cid = await invoke<string>("upload_file_public", {
            accountId: polkadotAddress,
            filePath: filePath,
            seedPhrase: mnemonic
          });
        }
        cids.push(cid);

        // update progress
        const percent = Math.round(((i + 1) / filePaths.length) * 100);
        setProgress(percent);

        const uploadingText =
          filePaths.length > 1
            ? msgs?.uploadingMultiple?.(filePaths.length, percent) ?? `Uploading ${filePaths.length} files: ${percent}%`
            : msgs?.uploadingSingle?.(percent) ?? `Uploading file: ${percent}%`;

        // Always update the same toast id
        toast.loading(uploadingText, { id: localToastId });
      }

      // finish up
      setRequestState("idle");
      idleTimeout.current = setTimeout(() => {
        refetchUserFiles();
        onSuccess?.();

        const successText =
          filePaths.length > 1
            ? msgs?.successMultiple?.(filePaths.length) ?? `${filePaths.length} files successfully uploaded!`
            : msgs?.successSingle ?? `File successfully uploaded!`;

        // Convert loading -> success on the same toast id (auto-closes)
        toast.success(successText, { id: localToastId });
      }, 500);
    } catch (err) {
      setRequestState("idle");
      setProgress(0);
      onError?.(err);

      const errorText =
        filePaths.length > 1
          ? msgs?.errorMultiple?.(filePaths.length) ?? `${filePaths.length} files failed to upload!`
          : msgs?.errorSingle ?? `File failed to upload!`;

      // Convert loading -> error on the same toast id
      toast.error(errorText, { id: localToastId });
    }
  }

  return { upload, requestState };
}

export default useFilesUpload;
