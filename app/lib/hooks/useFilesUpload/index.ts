import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import { useUserFiles } from "@/app/lib/hooks/use-user-files";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useSetAtom } from "jotai";
import { uploadProgressAtom } from "@/app/components/page-sections/files/atoms/query-atoms";
import { toast } from "sonner";
import { formatDisplayName } from "@/lib/utils/fileTypeUtils";
import { basename } from "@tauri-apps/api/path";
import { triggerUnpinnedFilesRefetchAtom } from "../../global-atoms/unpinAtoms";
import { getPrivateSyncPath } from "@/lib/utils/syncPathUtils";

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
  const { refetch: refetchUserFiles } = useUserFiles();
  const setTriggerUnpinnedFilesRefetch = useSetAtom(
    triggerUnpinnedFilesRefetchAtom
  );
  const { polkadotAddress } = useWalletAuth();

  const [requestState, setRequestState] = useState<
    "idle" | "uploading" | "submitting"
  >("idle");

  async function upload(
    filePaths: string[],
    isPrivateView: boolean,
    options?: UploadOptions,
    syncPathOverride?: string,
  ) {
    if (!polkadotAddress) {
      throw new Error("Wallet not connected. Please log in first.");
    }

    const fileNames = await Promise.all(
      filePaths.map(async (path) => {
        const name = await basename(path);
        return name;
      })
    );

    const firstFileName = fileNames[0]
      ? formatDisplayName(fileNames[0])
      : "file";

    const msgs = options?.messages;
    const startText =
      filePaths.length > 1
        ? msgs?.startMultiple?.(filePaths.length) ??
        `Adding ${filePaths.length} files to sync folder…`
        : msgs?.startSingle ?? `Adding ${firstFileName} to sync folder…`;

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
      // Credits may still be loading on first app render; surface a clearer message.
      if (credits === undefined) {
        throw new Error("Credits are still loading. Please try again in a moment.");
      }
      if (credits <= BigInt(0)) {
        throw new Error("Insufficient Credits. Please add credits.");
      }

      const cids: string[] = [];

      const syncPath = syncPathOverride ?? (await getPrivateSyncPath(polkadotAddress))?.path ?? "";
      if (!syncPath) {
        throw new Error("Sync path not configured. Please set a sync folder first.");
      }

      // Add each file to sync folder (hcfs-client will handle upload/encryption)
      for (let i = 0; i < filePaths.length; i++) {
        const filePath = filePaths[i];
        const fileName = fileNames[i]
          ? formatDisplayName(fileNames[i])
          : `file ${i + 1}`;

        const name = await invoke<string>("add_file", {
          syncPath,
          filePath,
        });
        cids.push(name);

        // update progress
        const percent = Math.round(((i + 1) / filePaths.length) * 100);
        setProgress(percent);

        const uploadingText =
          filePaths.length > 1
            ? msgs?.uploadingMultiple?.(filePaths.length, percent) ??
            `Adding ${filePaths.length} files: ${percent}%`
            : msgs?.uploadingSingle?.(percent) ??
            `Adding ${fileName}: ${percent}%`;

        // Always update the same toast id
        toast.loading(uploadingText, { id: localToastId });
      }

      // Show "added" confirmation
      const addedText =
        filePaths.length > 1
          ? `${filePaths.length} files added. Syncing will start shortly`
          : `${firstFileName} added. Syncing will start shortly`;
      toast.success(addedText, { id: localToastId, duration: 2000, closeButton: true });

      // finish up
      setRequestState("idle");

      // Fire-and-forget: trigger sync without awaiting (it may block if a
      // sync cycle is already running). The file watcher will also pick up
      // the new files on its own heartbeat cycle.
      invoke("trigger_sync_now").catch((err) => {
        console.error("[Upload] trigger_sync_now failed:", err);
      });

      // Refetch immediately so the file list shows the new files
      refetchUserFiles();
      setTriggerUnpinnedFilesRefetch((prev) => prev + 1);
      onSuccess?.();
    } catch (err) {
      setRequestState("idle");
      setProgress(0);
      onError?.(err);

      const errorText =
        filePaths.length > 1
          ? msgs?.errorMultiple?.(filePaths.length) ??
          `Failed to add ${filePaths.length} files`
          : msgs?.errorSingle ?? `Failed to add ${firstFileName}`;

      // Convert loading -> error on the same toast id
      toast.error(errorText, { id: localToastId });
    }
  }

  return { upload, requestState };
}

export default useFilesUpload;
