import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useUserFiles } from "@/app/lib/hooks/use-user-files";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useSetAtom, useAtomValue } from "jotai";
import { uploadProgressAtom } from "@/app/components/page-sections/files/atoms/query-atoms";
import { queryClientAtom } from "jotai-tanstack-query";
import { REMOTE_STORAGE_STATS_QUERY_KEY } from "@/app/lib/hooks/api/useRemoteStorageStats";
import { toast } from "sonner";
import { formatDisplayName } from "@/lib/utils/fileTypeUtils";
import { basename } from "@tauri-apps/api/path";
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
  const { refetch: refetchUserFiles } = useUserFiles();
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useAtomValue(queryClientAtom);

  const [requestState, setRequestState] = useState<
    "idle" | "uploading" | "submitting"
  >("idle");

  async function upload(
    filePaths: string[],
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
      toast.loading(startText, { id: localToastId, closeButton: true });
    } else {
      localToastId = toast.loading(startText, { closeButton: true });
    }

    setRequestState("uploading");
    setProgress(0);

    try {
      // NOTE: there used to be TS-side credit checks here that read from a
      // `staleTime: Infinity` `useUserCredits` cache and threw on
      // `credits <= 0n`. Both are gone — `useCreditCheck` (live Rust call)
      // now gates at the click handler, AND the Rust `add_files` IPC
      // enforces eligibility internally via `require_eligible(...)?` so
      // any bypass surfaces a structured `NotReady(InsufficientCredits)`
      // error in the catch block below.

      const syncPath = syncPathOverride ?? (await getPrivateSyncPath(polkadotAddress))?.path ?? "";
      if (!syncPath) {
        throw new Error("Sync path not configured. Please set a sync folder first.");
      }

      // Single Rust call: adds all files + triggers sync
      const result = await invoke<{ added: string[]; failed: Array<{ name: string; error: string }> }>("add_files", { syncPath, filePaths });

      // Show result AFTER the work completes
      toast.dismiss(localToastId);
      if (result.failed.length > 0) {
        const failedNames = result.failed.map((f) => f.name).join(", ");
        toast.warning(`${result.added.length} files added, ${result.failed.length} failed: ${failedNames}`, { duration: 6000, closeButton: true });
      } else {
        const addedText =
          filePaths.length === 1
            ? `${firstFileName} added. Your sync will start soon.`
            : `${filePaths.length} files added. Your sync will start soon.`;
        toast.success(addedText, { duration: 4000, closeButton: true });
      }

      refetchUserFiles();
      queryClient.invalidateQueries({ queryKey: [REMOTE_STORAGE_STATS_QUERY_KEY] });

      // finish up
      setRequestState("idle");
      setProgress(0);
      onSuccess?.();
    } catch (err) {
      setRequestState("idle");
      setProgress(0);
      onError?.(err);

      const errorText =
        filePaths.length === 1
          ? msgs?.errorSingle ?? `Failed to add ${firstFileName}`
          : msgs?.errorMultiple?.(filePaths.length) ??
          `Failed to add ${filePaths.length} files`;

      toast.dismiss(localToastId);
      toast.error(errorText);
    }
  }

  return { upload, requestState };
}

export default useFilesUpload;
