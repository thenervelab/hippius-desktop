"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Icons, AbstractIconWrapper } from "@/components/ui";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  X,
  FolderSearch,
  Search,
  CheckSquare,
  Square,
} from "lucide-react";
import { formatBytes } from "@/lib/utils/formatBytes";
import cn from "@/lib/utils/cn";
import type { RemoteFolder } from "@/app/lib/types/sync-folder";
import {
  RemoteFileTree,
  type RemoteFileInfo,
} from "./RemoteFileTree";

interface RemoteFolderBrowserProps {
  open: boolean;
  onClose: () => void;
  folder: RemoteFolder;
  accountId: string;
  /** Called when the user wants to sync selected files (remote folders only). Passes exclusion paths. */
  onSyncSelected: (folder: RemoteFolder, excludedPaths: string[]) => void;
  /** When true, the folder is already synced locally — apply exclusion patterns directly. */
  isLocal?: boolean;
}

export function RemoteFolderBrowser({
  open,
  onClose,
  folder,
  accountId,
  onSyncSelected,
  isLocal = false,
}: RemoteFolderBrowserProps) {
  const [files, setFiles] = useState<RemoteFileInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null);

  // Fetch remote files when dialog opens
  useEffect(() => {
    if (!open) return;
    setFiles([]);
    setSelected(new Set());
    setFilter("");
    setError(null);

    let cancelled = false;
    setIsLoading(true);

    const fetchFiles = invoke<RemoteFileInfo[]>("list_remote_folder_files", {
      accountId,
      label: folder.folderName,
    });

    // For local folders, also fetch existing exclusion patterns
    const fetchExclusions = isLocal
      ? invoke<string[]>("list_exclude_patterns", { label: folder.folderName })
      : Promise.resolve([]);

    Promise.all([fetchFiles, fetchExclusions])
      .then(([result, exclusions]) => {
        if (cancelled) return;
        setFiles(result);
        // Start with all selected, then uncheck any that are currently excluded
        const excludedSet = new Set(exclusions);
        const initialSelected = new Set(
          result
            .map((f) => f.path)
            .filter((p) => !excludedSet.has(p))
        );
        setSelected(initialSelected);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to list remote files:", err);
        setError(
          typeof err === "string" ? err : "Failed to load remote files"
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, accountId, folder.folderName, isLocal]);

  const allPaths = useMemo(
    () => new Set(files.map((f) => f.path)),
    [files]
  );

  const selectedCount = selected.size;
  const totalCount = files.length;
  const selectedSize = useMemo(
    () =>
      files
        .filter((f) => selected.has(f.path))
        .reduce((sum, f) => sum + f.size_bytes, 0),
    [files, selected]
  );

  const handleSelectAll = useCallback(() => {
    setSelected(new Set(allPaths));
  }, [allPaths]);

  const handleDeselectAll = useCallback(() => {
    setSelected(new Set());
  }, []);

  const unlistenRef = useRef<UnlistenFn | null>(null);

  const handleDownload = useCallback(
    async (file: RemoteFileInfo) => {
      try {
        const ext = file.name.includes(".")
          ? file.name.split(".").pop() || ""
          : "";
        const savePath = await save({
          defaultPath: file.name,
          filters: ext
            ? [{ name: ext.toUpperCase(), extensions: [ext] }]
            : [],
        });
        if (!savePath) return;

        setDownloadingFile(file.file_id);
        const toastId = toast.loading(`Downloading ${file.name}...`);

        // Listen for progress events
        unlistenRef.current = await listen<{
          file_id: string;
          bytes_downloaded: number;
          total_bytes: number;
        }>("oneoff_download_progress", (e) => {
          if (e.payload.file_id !== file.file_id) return;
          const { bytes_downloaded, total_bytes } = e.payload;
          if (total_bytes > 0) {
            const pct = Math.round((bytes_downloaded / total_bytes) * 100);
            toast.loading(`Downloading ${file.name}... ${pct}%`, { id: toastId });
          }
        });

        await invoke("download_remote_file", {
          accountId,
          label: folder.folderName,
          fileId: file.file_id,
          outputPath: savePath,
        });

        toast.success(`Downloaded ${file.name}`, { id: toastId });
      } catch (err) {
        console.error("Download failed:", err);
        toast.error(
          typeof err === "string" ? err : `Failed to download ${file.name}`
        );
      } finally {
        unlistenRef.current?.();
        unlistenRef.current = null;
        setDownloadingFile(null);
      }
    },
    [accountId, folder.folderName]
  );

  const [isApplying, setIsApplying] = useState(false);

  const handleSyncSelected = useCallback(async () => {
    if (isLocal) {
      // Already synced — apply exclusion patterns directly
      setIsApplying(true);
      try {
        const excludedPaths = files
          .filter((f) => !selected.has(f.path))
          .map((f) => f.path);
        const includedPaths = files
          .filter((f) => selected.has(f.path))
          .map((f) => f.path);

        // Remove patterns for files that are now selected (included)
        for (const path of includedPaths) {
          await invoke("remove_exclude_pattern", {
            label: folder.folderName,
            pattern: path,
          }).catch(() => {});
        }
        // Add patterns for files that are unchecked (excluded)
        for (const path of excludedPaths) {
          await invoke("add_exclude_pattern", {
            label: folder.folderName,
            pattern: path,
          }).catch(() => {});
        }

        // Trigger a sync cycle so newly included files get downloaded (fire-and-forget)
        invoke("trigger_sync_now").catch(() => {});

        toast.success("Sync selection updated");
        onClose();
      } catch (err) {
        console.error("Failed to apply selection:", err);
        toast.error("Failed to update sync selection");
      } finally {
        setIsApplying(false);
      }
    } else {
      // Remote folder — delegate to parent for restore flow
      const excludedPaths = files
        .filter((f) => !selected.has(f.path))
        .map((f) => f.path);
      onSyncSelected(folder, excludedPaths);
    }
  }, [files, selected, folder, onSyncSelected, isLocal, onClose]);

  const handleClose = useCallback(() => {
    if (!downloadingFile) {
      onClose();
    }
  }, [downloadingFile, onClose]);

  return (
    <Dialog.Root open={open} onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col z-50">
          {/* Header */}
          <div className="flex items-start justify-between p-6 pb-0">
            <div className="flex items-center gap-3">
              <AbstractIconWrapper className="size-10 relative">
                <FolderSearch className="absolute size-5 text-primary-50" />
              </AbstractIconWrapper>
              <div>
                <Dialog.Title className="text-lg font-semibold text-grey-10">
                  Browse: {folder.folderName}
                </Dialog.Title>
                <Dialog.Description className="text-sm text-grey-60">
                  {folder.deviceName} &middot;{" "}
                  {totalCount > 0
                    ? `${totalCount} ${totalCount === 1 ? "file" : "files"}`
                    : "Loading..."}
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                className="p-1 hover:bg-grey-95 rounded transition-colors"
                disabled={!!downloadingFile}
              >
                <X className="size-5 text-grey-50" />
              </button>
            </Dialog.Close>
          </div>

          {/* Toolbar */}
          {!isLoading && !error && files.length > 0 && (
            <div className="flex items-center gap-2 px-6 pt-4">
              <button
                type="button"
                onClick={handleSelectAll}
                className="flex items-center gap-1 text-xs font-medium text-grey-50 hover:text-primary-50 transition-colors"
              >
                <CheckSquare className="size-3.5" />
                Select All
              </button>
              <button
                type="button"
                onClick={handleDeselectAll}
                className="flex items-center gap-1 text-xs font-medium text-grey-50 hover:text-primary-50 transition-colors"
              >
                <Square className="size-3.5" />
                Deselect All
              </button>
              <div className="flex-1" />
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-grey-60" />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter files..."
                  className="text-xs pl-7 pr-2.5 py-1.5 border border-grey-80 rounded-md bg-white text-grey-20 placeholder:text-grey-60 focus:outline-none focus:ring-1 focus:ring-primary-50 focus:border-primary-50 w-48"
                />
              </div>
            </div>
          )}

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center py-12">
                <Icons.Loader className="size-6 animate-spin text-primary-50 mb-3" />
                <p className="text-sm text-grey-50">
                  Loading remote files...
                </p>
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-12">
                <p className="text-sm text-error-50 mb-2">{error}</p>
                <button
                  className="text-xs text-primary-50 hover:underline"
                  onClick={() => {
                    // Re-trigger by toggling open
                    onClose();
                  }}
                >
                  Close and try again
                </button>
              </div>
            ) : (
              <RemoteFileTree
                files={files}
                selected={selected}
                onSelectedChange={setSelected}
                onDownload={handleDownload}
                filter={filter}
              />
            )}
          </div>

          {/* Footer */}
          {!isLoading && !error && files.length > 0 && (
            <div className="border-t border-grey-90 px-6 py-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-grey-50">
                  {selectedCount} of {totalCount} files selected
                  {selectedSize > 0 && (
                    <span className="ml-1">
                      ({formatBytes(selectedSize)})
                    </span>
                  )}
                </p>
                <div className="flex gap-3">
                  <button
                    className="py-2 px-4 text-sm font-medium rounded border border-grey-80 bg-grey-90 hover:bg-grey-80 text-grey-10 transition-colors disabled:opacity-50"
                    onClick={handleClose}
                    disabled={!!downloadingFile}
                  >
                    Cancel
                  </button>
                  <button
                    className={cn(
                      "py-2 px-4 text-sm font-medium rounded border transition-colors disabled:opacity-50",
                      selectedCount > 0
                        ? "border-primary-40 bg-primary-50 hover:bg-primary-40 text-white"
                        : "border-grey-80 bg-grey-90 text-grey-50 cursor-not-allowed"
                    )}
                    onClick={handleSyncSelected}
                    disabled={selectedCount === 0 || !!downloadingFile || isApplying}
                  >
                    {isApplying ? (
                      <span className="flex items-center gap-2">
                        <Icons.Loader className="size-4 animate-spin" />
                        Applying...
                      </span>
                    ) : isLocal ? "Apply Selection" : "Sync Selected to Device"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
