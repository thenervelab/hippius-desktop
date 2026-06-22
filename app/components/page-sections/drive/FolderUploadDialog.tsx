"use client";

import React, { useEffect, useState } from "react";
import { errorMessage } from "@/lib/utils/errorUtils";
import { AlertCircle, Folder, X } from "lucide-react";
import { toast } from "sonner";
import { open as openSelection } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue, useSetAtom } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { isNotReady } from "@/lib/utils/dispatchTauriError";
import { insufficientCreditsDialogOpenAtom } from "@/app/components/page-sections/drive/atoms/query-atoms";

import { Button, Icons } from "@/components/ui";
import { FramedDialog } from "@/components/ui/FramedDialog";
import GraphSheetContainer from "@/components/ui/graphsheet";
import PrivacyBadge from "@/components/ui/PrivacyBadge";
import { cn } from "@/lib/utils";

import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { getPrivateSyncPath } from "@/lib/utils/syncPathUtils";
import { DRIVE_STORAGE_STATS_QUERY_KEY } from "@/app/lib/hooks/api/useDriveStorageStats";
import { GET_USER_IPFS_FILES_QUERY_KEY } from "@/app/lib/hooks/use-user-files";
import {
  SyncPausedAlert,
  IS_SYNC_PAUSED,
} from "@/components/ui/SyncPausedAlert";
import SyncFolderSelect from "@/components/ui/SyncFolderSelect";
import { hasConfiguredDrivesAtom } from "@/app/lib/global-atoms/unpinAtoms";
import {
  getLastBrowseDirectory,
  saveLastBrowseDirectory,
} from "@/lib/utils/userPreferencesDb";
import { useCreditCheck } from "@/lib/hooks/useCreditCheck";

type Props = {
  open: boolean;
  onClose: () => void;
  onSuccess?: (folderCid: string) => void;
  onRefresh?: () => void;
  defaultFolderLabel?: string | null;
  /** Path to seed when the dialog opens (e.g. from a drag-drop onto
   *  the files table). Re-applied each time `open` flips to true. */
  initialFolderPath?: string;
};

export default function FolderUploadDialog({
  open,
  onClose,
  onSuccess,
  onRefresh,
  defaultFolderLabel,
  initialFolderPath,
}: Props) {
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useAtomValue(queryClientAtom);
  const setInsufficient = useSetAtom(insufficientCreditsDialogOpenAtom);
  const hasConfiguredDrives = useAtomValue(hasConfiguredDrivesAtom);
  const { checkEligibility } = useCreditCheck();

  const [folderPath, setFolderPath] = useState<string>(initialFolderPath ?? "");
  const [folderError, setFolderError] = useState<string | null>(null);

  // When the dialog is opened (or reopened) with a different
  // `initialFolderPath`, replace whatever path was left from a previous
  // session. Closing alone doesn't trigger this — that's `handleClose`'s job.
  useEffect(() => {
    if (open && initialFolderPath) {
      setFolderPath(initialFolderPath);
      setFolderError(null);
    }
  }, [open, initialFolderPath]);
  const [selectedFolderLabel, setSelectedFolderLabel] = useState<string | null>(
    defaultFolderLabel ?? null,
  );
  const [selectedSyncPath, setSelectedSyncPath] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSelectFolder = async () => {
    try {
      const defaultPath = await getLastBrowseDirectory();
      const selectedFolder = (await openSelection({
        directory: true,
        multiple: false,
        defaultPath,
      })) as string | null;

      if (selectedFolder && typeof selectedFolder === "string") {
        setFolderPath(selectedFolder.trim());
        setFolderError(null);
        saveLastBrowseDirectory(selectedFolder.trim());
      }
    } catch (error) {
      console.error("Error selecting folder:", error);
      toast.error(
        `Failed to select folder: ${errorMessage(error)}`,
      );
    }
  };

  const handleClearSelection = () => {
    setFolderPath("");
    setFolderError(null);
  };

  // Tauri native drag-drop: accept exactly one dropped directory.
  // Listeners are only registered while the dialog is open so we don't
  // hijack drops in other surfaces.
  //
  // `cancelled` closes the async-await + cleanup race: if `open` flips
  // back to false while an `await listen(...)` is in flight, the
  // synchronous cleanup runs against an empty `unlisteners` array and
  // the awaited listener leaks. The flag turns the late resolution into
  // an immediate unregister.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const safePush = (un: () => void) => {
      if (cancelled) {
        un();
        return;
      }
      unlisteners.push(un);
    };

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        const { stat } = await import("@tauri-apps/plugin-fs");
        if (cancelled) return;

        const unDragEnter = await listen("tauri://drag-enter", () => {
          setIsDragging(true);
        });
        safePush(unDragEnter);
        if (cancelled) return;

        const unDragLeave = await listen("tauri://drag-leave", () => {
          setIsDragging(false);
        });
        safePush(unDragLeave);
        if (cancelled) return;

        const unDragDrop = await listen<{ paths: string[] }>(
          "tauri://drag-drop",
          async (event) => {
            setIsDragging(false);
            const paths = event.payload.paths;
            if (!paths || paths.length === 0) return;

            const first = paths[0];
            try {
              const info = await stat(first);
              if (!info.isDirectory) {
                toast.error(
                  "Only folders can be added here. Drop a folder, not a file.",
                );
                return;
              }
            } catch (err) {
              console.error("[FolderUploadDialog] stat failed:", err);
              toast.error("Could not read the dropped item. Try again.");
              return;
            }

            if (paths.length > 1) {
              toast.info("Only the first dropped folder will be used.");
            }

            setFolderPath(first);
            setFolderError(null);
            saveLastBrowseDirectory(first);
          },
        );
        safePush(unDragDrop);
      } catch (err) {
        console.error(
          "[FolderUploadDialog] Failed to register drag listeners:",
          err,
        );
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!folderPath) {
      setFolderError("Please select a folder");
      return;
    }

    if (!(await checkEligibility("folder-upload"))) {
      handleClose();
      return;
    }

    if (!hasConfiguredDrives) {
      toast.warning(
        "Set up a sync folder in Settings → Sync & Storage before uploading.",
      );
      return;
    }

    setIsSubmitting(true);
    handleClose();

    try {
      const syncPath =
        selectedSyncPath ??
        (await getPrivateSyncPath(polkadotAddress || ""))?.path ??
        "";

      const name = await invoke<string>("add_folder", {
        syncPath,
        folderPath,
        subfolder: null,
      });

      // Success toast AFTER add_folder resolves — add_folder runs the
      // require_eligible gate first and can reject (audit M-15), so firing
      // "Folder added" before the await produced success-then-error.
      toast.success("Folder added. Your sync will start soon.", {
        duration: 4000,
        closeButton: true,
      });

      queryClient.invalidateQueries({
        queryKey: [DRIVE_STORAGE_STATS_QUERY_KEY],
      });
      queryClient.invalidateQueries({
        queryKey: [GET_USER_IPFS_FILES_QUERY_KEY],
      });
      if (onRefresh) {
        onRefresh();
      }

      if (onSuccess) {
        onSuccess(name);
      }
    } catch (error) {
      console.error("Error uploading folder:", error);
      // A credit shortfall from add_folder's require_eligible gate (TOCTOU vs
      // the proactive check) opens the shared dialog, not a raw error (M-15).
      if (isNotReady(error, "INSUFFICIENT_CREDITS")) {
        setInsufficient("folder-upload");
      } else {
        toast.error(`Failed to upload folder: ${errorMessage(error)}`);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setFolderPath("");
    setFolderError(null);
    setIsDragging(false);
    setSelectedFolderLabel(defaultFolderLabel ?? null);
    setSelectedSyncPath(null);
    onClose();
  };

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title="Upload Folder"
      icon={<Icons.FolderPlus className="size-5 text-white" />}
      maxWidth="max-w-[653px]"
    >
      {/* Section label row — mirrors the AddFile dialog's "Upload File" + Private layout. */}
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="font-geist text-sm font-medium text-grey-60 dark:text-grey-dark-700 tracking-[-0.28px]">
          Folder Location
        </span>
        {!IS_SYNC_PAUSED && <PrivacyBadge variant="folder" />}
      </div>

      {IS_SYNC_PAUSED && (
        <div className="mb-3">
          <SyncPausedAlert variant="inline" />
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {/* Folder dropzone — same styling as AddLocalFolderDialog */}
        <div className="flex flex-col gap-2">
          <div
            className={cn(
              "rounded-[8px] border bg-white p-2 transition-[border-color,box-shadow] duration-200",
              "border-grey-80 shadow-[0px_0px_0px_4px_rgba(10,10,10,0.05)]",
              "dark:border-[#333] dark:bg-[#171717] dark:shadow-[0px_0px_0px_4px_rgba(255,255,255,0.03)]",
              isDragging &&
                "border-primary-50 shadow-[0px_0px_0px_4px_rgba(49,103,221,0.12)] dark:border-primary-65 dark:shadow-[0px_0px_0px_4px_rgba(97,140,232,0.15)]",
            )}
          >
            <div
              className={cn(
                "rounded-[8px] border-[1.5px] border-dashed bg-white transition-colors",
                "border-grey-70 dark:border-[#444] dark:bg-[#1e1e1e]",
                isDragging &&
                  "border-primary-50 bg-primary-50/5 dark:border-primary-50 dark:bg-primary-50/10",
                isSubmitting && "opacity-60",
              )}
            >
              {folderPath ? (
                <div className="flex w-full items-center gap-2 px-3 py-3">
                  <button
                    type="button"
                    onClick={handleSelectFolder}
                    disabled={isSubmitting}
                    title="Click to change folder"
                    className="flex flex-1 min-w-0 items-center gap-3 rounded-md px-2 py-1.5 -mx-2 -my-1.5 text-left transition-colors hover:bg-grey-light-400 dark:hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Folder className="size-5 text-primary-50 flex-shrink-0" />
                    <p className="font-mono text-xs text-grey-40 dark:text-grey-dark-300 break-all">
                      {folderPath}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={handleClearSelection}
                    disabled={isSubmitting}
                    aria-label="Clear selected folder"
                    title="Clear selection"
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-grey-60 hover:text-grey-30 hover:bg-grey-90 dark:text-grey-dark-600 dark:hover:text-white dark:hover:bg-white/10 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleSelectFolder}
                  disabled={isSubmitting}
                  className={cn(
                    "flex w-full flex-col items-center justify-center gap-4 rounded-[8px] px-4 py-[22px] transition-colors",
                    "hover:bg-[#fafafa] dark:hover:bg-[#252525]",
                    isSubmitting && "cursor-not-allowed",
                  )}
                >
                  {/* Decorative grid + blue badge — mirrors the FramedDialog icon at 40px */}
                  <div className="relative flex size-10 items-center justify-center overflow-hidden rounded-[4px] dark:rounded-full">
                    <GraphSheetContainer
                      majorCell={{
                        lineColor: [31, 80, 189, 1.0],
                        lineWidth: 2,
                        cellDim: 200,
                      }}
                      minorCell={{
                        lineColor: [49, 103, 211, 1.0],
                        lineWidth: 1,
                        cellDim: 20,
                      }}
                      className="absolute inset-0 size-full opacity-30 dark:hidden"
                    />
                    <div
                      className="absolute inset-0 size-full hidden dark:block"
                      style={{
                        backgroundImage:
                          "linear-gradient(to right, rgba(31,80,189,0.85) 1px, transparent 1px), linear-gradient(to bottom, rgba(31,80,189,0.85) 1px, transparent 1px)",
                        backgroundSize: "17px 17px",
                        maskImage:
                          "radial-gradient(55% 70% at 50% 50%, black 0%, transparent 100%)",
                        WebkitMaskImage:
                          "radial-gradient(55% 70% at 50% 50%, black 0%, transparent 100%)",
                      }}
                    />
                    <div className="bg-gradient-to-b from-white/80 via-white/40 to-transparent absolute inset-0 dark:hidden" />
                    <div className="relative flex size-[22.857px] items-center justify-center rounded-[5.714px] bg-[#3167dd]">
                      <Icons.FolderPlus className="size-3 text-white" />
                    </div>
                  </div>

                  <div className="flex flex-col items-center gap-0.5">
                    <p className="font-geist text-[16px] font-medium leading-[22px] tracking-[-0.32px] text-grey-10 dark:text-white">
                      Select Folder
                    </p>
                    <p className="font-geist w-[262px] max-w-full text-[14px] font-medium leading-5 tracking-[-0.28px] text-[#7D7D7D] dark:text-grey-dark-600 text-center">
                      Drag and drop or click to add folder here to upload
                    </p>
                  </div>
                </button>
              )}
            </div>
          </div>

          {folderError && (
            <div className="flex items-center gap-2 text-sm font-medium text-error-70">
              <AlertCircle className="size-4 !relative" />
              <span>{folderError}</span>
            </div>
          )}
        </div>

        <SyncFolderSelect
          value={selectedFolderLabel}
          defaultLabel={defaultFolderLabel}
          onChange={(label, path) => {
            setSelectedFolderLabel(label);
            setSelectedSyncPath(path);
          }}
        />

        <div className="mt-2 flex flex-col gap-3">
          <Button
            type="submit"
            variant="primary"
            size="auto"
            disabled={IS_SYNC_PAUSED || isSubmitting}
            loading={isSubmitting}
            className={cn(
              "h-[52px] w-full rounded-[6px] border text-base font-normal tracking-[-0.36px]",
              "border-[#3167DD] bg-[#3167DD] text-white",
              "hover:bg-[#2454c4] hover:border-[#2454c4]",
              "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]",
            )}
          >
            {IS_SYNC_PAUSED ? "Sync Paused" : "Upload Folder"}
          </Button>
          <Button
            type="button"
            variant="defaultStable"
            size="auto"
            onClick={handleClose}
            disabled={isSubmitting}
            className="h-[52px] w-full rounded-[6px] text-base font-normal tracking-[-0.36px]"
          >
            {IS_SYNC_PAUSED ? "Close" : "Cancel"}
          </Button>
        </div>
      </form>
    </FramedDialog>
  );
}
