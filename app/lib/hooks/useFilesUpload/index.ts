import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useUserFiles } from "@/app/lib/hooks/use-user-files";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useSetAtom, useAtomValue } from "jotai";
import { uploadProgressAtom } from "@/app/components/page-sections/drive/atoms/query-atoms";
import { queryClientAtom } from "jotai-tanstack-query";
import { DRIVE_STORAGE_STATS_QUERY_KEY } from "@/app/lib/hooks/api/useDriveStorageStats";
import { toast } from "sonner";
import { formatDisplayName } from "@/lib/utils/fileTypeUtils";
import { basename } from "@tauri-apps/api/path";
import { getPrivateSyncPath } from "@/lib/utils/syncPathUtils";
import { UPLOAD_PROCESSING_TOAST_ID } from "@/lib/hooks/useUploadProcessing";

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

    // Use the shared UPLOAD_PROCESSING_TOAST_ID so the toast persists
    // until Rust's `hcfs_upload_processing { active: false }` event
    // (handled in `useUploadProcessing`). `duration: Infinity` keeps
    // it visible across the disk-copy + encryption + sync-prep window
    // — much longer than Sonner's default ~4s. Caller-provided
    // `toastId` (rare path used to update an in-flight toast) wins.
    const localToastId = options?.toastId ?? UPLOAD_PROCESSING_TOAST_ID;
    if (options?.toastId !== undefined && options.toastId !== UPLOAD_PROCESSING_TOAST_ID) {
      // A caller passed a non-shared toastId. The
      // `useUploadProcessing` hook only dismisses
      // `UPLOAD_PROCESSING_TOAST_ID`, so a custom id will leak —
      // the toast will stay stuck after sync starts and stack
      // with subsequent uploads. Surface the misuse here.
      console.warn(
        "[useFilesUpload] caller passed a non-shared toastId; toast will not auto-dismiss when sync starts. Use UPLOAD_PROCESSING_TOAST_ID instead.",
        { toastId: options.toastId },
      );
    }
    toast.loading(startText, {
      id: localToastId,
      closeButton: true,
      duration: Infinity,
    });

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

      // Single Rust call: adds all files + triggers sync.
      // `forFolder: false` because this hook is used for loose
      // multi-file uploads (drag/drop, file picker) — never for the
      // folder-upload flow which goes through `UploadFilesFlow`. The
      // IPC enforces `FileUpload` credit eligibility accordingly.
      const result = await invoke<{ added: string[]; failed: Array<{ name: string; error: string }> }>("add_files", {
        syncPath,
        filePaths,
        forFolder: false,
      });

      if (result.failed.length > 0) {
        // Partial-failure overwrites the loading toast with a warning;
        // explicit dismiss not needed because we reuse the same id.
        const failedNames = result.failed.map((f) => f.name).join(", ");
        toast.warning(`${result.added.length} files added, ${result.failed.length} failed: ${failedNames}`, {
          id: localToastId,
          duration: 6000,
          closeButton: true,
        });
      }
      // Success path: do NOT dismiss the loading toast here. The
      // `useUploadProcessing` hook dismisses `UPLOAD_PROCESSING_TOAST_ID`
      // on the Rust `hcfs_upload_processing { active: false }` event,
      // which fires when the sync cycle actually starts.

      refetchUserFiles();
      queryClient.invalidateQueries({ queryKey: [DRIVE_STORAGE_STATS_QUERY_KEY] });

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

      // Reuse the same toast id so the error overwrites the loading
      // toast instead of stacking — matches the partial-failure path.
      toast.error(errorText, { id: localToastId, closeButton: true });
    }
  }

  return { upload, requestState };
}

export default useFilesUpload;
