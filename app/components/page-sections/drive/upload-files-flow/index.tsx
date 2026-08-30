// Unified file upload flow component — handles both root-level uploads and folder-targeted uploads.
import { FC, useState, useEffect, useCallback } from "react";
import { errorMessage } from "@/lib/utils/errorUtils";
import useFilesUpload from "@/lib/hooks/useFilesUpload";
import { Icons, Button } from "@/components/ui";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import FileDropzone from "./FileDropzone";
import { useSetAtom, useAtomValue } from "jotai";
import { insufficientCreditsDialogOpenAtom } from "@/app/components/page-sections/drive/atoms/query-atoms";
import { queryClientAtom } from "jotai-tanstack-query";
import { DRIVE_STORAGE_STATS_QUERY_KEY } from "@/app/lib/hooks/api/useDriveStorageStats";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { basename } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatDisplayName } from "@/lib/utils/fileTypeUtils";
import SyncFolderSelect from "@/components/ui/SyncFolderSelect";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { getPrivateSyncPath } from "@/lib/utils/syncPathUtils";
import { useCreditCheck } from "@/lib/hooks/useCreditCheck";
import { isNotReady } from "@/lib/utils/dispatchTauriError";
import { UPLOAD_PROCESSING_TOAST_ID } from "@/lib/hooks/useUploadProcessing";

// ── Shared types ───────────────────────────────────────────────────────────────

interface FilePathInfo {
  path: string;
  name: string;
  file?: File;
}

// ── Discriminated-union props ──────────────────────────────────────────────────

interface BaseProps {
  initialFiles?: FileList | null;
  initialPaths?: string[] | null;
}

interface RootUploadProps extends BaseProps {
  /** Root-level upload mode — files go through `useFilesUpload` with a SyncFolderSelect. */
  mode?: "root";
  reset: () => void;
  defaultFolderLabel?: string | null;
}

interface FolderUploadProps extends BaseProps {
  /** Folder-targeted upload mode — files are added directly into a specific subfolder. */
  mode: "folder";
  folderName: string;
  /** Relative path from sync root to the current folder (e.g. "ProjectA/sub"). */
  subfolder?: string;
  /** Resolved sync root path (avoids incorrect getPrivateSyncPath in multi-drive). */
  syncBasePath?: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export type UploadFilesFlowProps = RootUploadProps | FolderUploadProps;

// ── Component ──────────────────────────────────────────────────────────────────

const UploadFilesFlow: FC<UploadFilesFlowProps> = (props) => {
  const { initialFiles, initialPaths } = props;
  const isFolder = props.mode === "folder";

  const [revealFiles, setRevealFiles] = useState(false);
  const [files, setFiles] = useState<FilePathInfo[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  // Root-mode state
  const [selectedFolderLabel, setSelectedFolderLabel] = useState<string | null>(
    !isFolder ? (props.defaultFolderLabel ?? null) : null
  );
  const [selectedSyncPath, setSelectedSyncPath] = useState<string | null>(null);

  // Root-mode hooks
  const queryClient = useAtomValue(queryClientAtom);
  const setInsufficient = useSetAtom(insufficientCreditsDialogOpenAtom);
  const resetFn = !isFolder ? props.reset : undefined;
  const { upload } = useFilesUpload({
    onError(err) {
      // The Rust `require_eligible(...)?` gate inside `add_files` raises
      // `NotReady(InsufficientCredits)` when the user can't afford the
      // upload. `invoke()` failures arrive here as plain objects, not
      // `Error` instances, so match on the structured `subkind` discriminant
      // via `isNotReady` instead of brittle substring checks.
      if (isNotReady(err, "INSUFFICIENT_CREDITS")) {
        setInsufficient(isFolder ? "folder-upload" : "file-upload");
        resetFn?.();
      }
      setIsUploading(false);
    },
    onSuccess() {
      resetFn?.();
      setIsUploading(false);
    },
  });

  // Folder-mode hooks
  const { polkadotAddress } = useWalletAuth();
  const syncBasePath = isFolder ? props.syncBasePath : undefined;
  const { checkEligibility } = useCreditCheck();

  // ── Shared: populate file list from initial values ─────────────────────────

  useEffect(() => {
    if (initialFiles && initialFiles.length > 0) {
      const fileInfos = Array.from(initialFiles).map((file) => ({
        path: "",
        name: file.name,
        file: file,
      }));
      setFiles(fileInfos);
      if (fileInfos.length > 1) setRevealFiles(true);
    }
  }, [initialFiles]);

  useEffect(() => {
    if (initialPaths && initialPaths.length > 0) {
      (async () => {
        try {
          const pathInfos = await Promise.all(
            initialPaths.map(async (p) => ({
              path: p,
              name: await basename(p),
            }))
          );
          setFiles(pathInfos);
          if (pathInfos.length > 1) setRevealFiles(true);
        } catch (error) {
          console.error("Error processing dropped paths:", error);
          toast.error("Failed to process dropped files");
        }
      })();
    }
  }, [initialPaths]);

  // ── Shared: add files from dropzone / dialog ──────────────────────────────

  const handleFiles = useCallback(
    async (paths: string[], browserFiles?: File[]) => {
      try {
        let newPathInfos: FilePathInfo[] = [];

        if (paths.length > 0) {
          newPathInfos = await Promise.all(
            paths.map(async (path) => ({
              path,
              name: await basename(path),
            }))
          );
        }

        if (browserFiles && browserFiles.length > 0) {
          const browserFileInfos = browserFiles.map((file) => ({
            path: "",
            name: file.name,
            file: file,
          }));
          newPathInfos = [...newPathInfos, ...browserFileInfos];
        }

        if (newPathInfos.length === 0) return;

        setFiles((prev) => {
          if (!prev.length) return newPathInfos;

          const seen = new Set(prev.map((f) => f.path || f.name));
          const unique = newPathInfos.filter(
            (f) => !seen.has(f.path || f.name)
          );
          if (unique.length === 0) return prev;

          const combined = [...prev, ...unique];
          if (combined.length > 1) setRevealFiles(true);
          return combined;
        });
      } catch (error) {
        console.error("Error processing files:", error);
        toast.error("Failed to process selected files");
      }
    },
    []
  );

  const removeFile = useCallback(
    (idx: number) => {
      const newFiles = files.filter((_, i) => i !== idx);
      setFiles(newFiles);
      if (newFiles.length === 1) setRevealFiles(false);
    },
    [files]
  );

  // ── Shared: write browser File objects to temp disk ────────────────────────

  const writeBrowserFilesToDisk = async (
    fileList: FilePathInfo[]
  ): Promise<string[]> => {
    const processedPaths: string[] = [];

    const { tempDir } = await import("@tauri-apps/api/path");
    const baseTmpDir = await tempDir();
    const tmpDir = `${baseTmpDir}hippius_upload_${Date.now()}/`;

    for (const fileInfo of fileList) {
      if (fileInfo.file) {
        try {
          const arrayBuffer = await fileInfo.file.arrayBuffer();
          const tempPath = `${tmpDir}${fileInfo.name}`;
          const { writeFile: tauriWriteFile } = await import(
            "@tauri-apps/plugin-fs"
          );
          await tauriWriteFile(tempPath, new Uint8Array(arrayBuffer));
          processedPaths.push(tempPath);
        } catch (error) {
          console.error(`Error processing file ${fileInfo.name}:`, error);
          toast.error(
            `Failed to process file: ${formatDisplayName(fileInfo.name)}`
          );
        }
      } else if (fileInfo.path) {
        processedPaths.push(fileInfo.path);
      }
    }

    return processedPaths;
  };

  // ── Root-mode upload ───────────────────────────────────────────────────────

  const uploadFilesRoot = async () => {
    if (isFolder || files.length === 0) return;

    setIsUploading(true);

    const firstFileName =
      files.length === 1
        ? formatDisplayName(files[0].name)
        : `${files.length} files`;

    // Use the shared UPLOAD_PROCESSING_TOAST_ID so the toast survives
    // across the prepare → add → sync-start window and gets dismissed
    // by the `useUploadProcessing` hook when Rust signals the cycle
    // has begun. Without this, an auto-generated id makes the dismiss
    // in the hook a no-op and leaves the toast stacked when the next
    // upload starts.
    const toastId = UPLOAD_PROCESSING_TOAST_ID;
    toast.loading(`Preparing ${firstFileName} for upload...`, { id: toastId });

    try {
      const processedPaths = await writeBrowserFilesToDisk(files);

      if (processedPaths.length === 0) {
        toast.error("No valid files to upload", { id: toastId });
        setIsUploading(false);
        return;
      }

      toast.loading(`Adding ${firstFileName} to sync folder\u2026`, {
        id: toastId,
      });

      props.reset();
      upload(
        processedPaths,
        { toastId },
        selectedSyncPath ?? undefined
      );
    } catch (error) {
      console.error("Error preparing files:", error);
      toast.error(
        `Error preparing ${firstFileName} for upload: ${
          errorMessage(error)
        }`,
        { id: toastId }
      );
      setIsUploading(false);
    }
  };

  // ── Folder-mode upload ─────────────────────────────────────────────────────

  const uploadFilesFolder = async () => {
    if (!isFolder || !files.length) return;

    if (!polkadotAddress) {
      toast.error("Wallet not connected. Please connect your wallet.");
      return;
    }

    // Live Rust eligibility check (replaces legacy stale-cache gate).
    // The Rust `add_files` IPC also enforces this internally via
    // `require_eligible(...)?` so the gate is impossible to bypass.
    if (!(await checkEligibility("folder-upload"))) {
      props.onCancel();
      return;
    }

    props.onCancel(); // Close dialog
    setIsUploading(true);
    setUploadProgress(0);

    const fileCount = files.length;
    // Use the shared UPLOAD_PROCESSING_TOAST_ID so this toast persists
    // until Rust's `hcfs_upload_processing { active: false }` event
    // (handled in `useUploadProcessing`). `duration: Infinity` keeps
    // it visible across the disk-copy + encryption + sync-prep window.
    const loadingToastId = UPLOAD_PROCESSING_TOAST_ID;
    toast.loading(
      fileCount === 1 ? "Adding file..." : `Adding ${fileCount} files...`,
      { id: loadingToastId, duration: Infinity, closeButton: true }
    );

    // Listen for per-file progress events from Rust
    const unlisten = await listen<{ completed: number; total: number }>("add_files_progress", (event) => {
      setUploadProgress(Math.round((event.payload.completed / event.payload.total) * 100));
    });

    try {
      // Reuse the shared helper for browser File → temp disk conversion
      const processedPaths = await writeBrowserFilesToDisk(files);
      if (processedPaths.length === 0) {
        toast.error("No valid files to process", { id: loadingToastId });
        setIsUploading(false);
        unlisten();
        return;
      }

      const baseSyncPath =
        syncBasePath || ((await getPrivateSyncPath(polkadotAddress ?? undefined))?.path ?? "");

      // Single batch call — Rust handles subfolder join, file copy, and sync trigger.
      // `forFolder: true` because this code path is reached only from the
      // folder-upload flow (`uploadFilesFolder` above bails for non-folder
      // mode), so the IPC enforces `FolderUpload` credit eligibility.
      const result = await invoke<{ added: string[]; failed: Array<{ name: string; error: string }> }>("add_files", {
        syncPath: baseSyncPath,
        filePaths: processedPaths,
        subfolder: props.subfolder ?? null,
        forFolder: true,
      });

      if (result.failed.length > 0) {
        // Partial-failure overwrites the loading toast with a warning;
        // explicit dismiss not needed because we reuse the same id.
        const failedNames = result.failed.map((f) => `${f.name}: ${f.error}`).join("; ");
        toast.warning(`${result.added.length} added, ${result.failed.length} failed: ${failedNames}`, {
          id: loadingToastId,
          duration: 6000,
          closeButton: true,
        });
      }
      // Success path: do NOT dismiss the loading toast here. The
      // `useUploadProcessing` hook dismisses `UPLOAD_PROCESSING_TOAST_ID`
      // on the Rust `hcfs_upload_processing { active: false }` event,
      // which fires when the sync cycle actually starts.

      queryClient.invalidateQueries({ queryKey: [DRIVE_STORAGE_STATS_QUERY_KEY] });
      props.onSuccess();
    } catch (error) {
      // Reuse the same toast id so the error overwrites the loading
      // toast instead of stacking — matches the partial-failure path.
      toast.error(
        `Failed to add ${fileCount === 1 ? "file" : "files"}: ${
          errorMessage(error)
        }`,
        { id: loadingToastId, closeButton: true }
      );
    } finally {
      unlisten();
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  // ── Derived values for rendering ───────────────────────────────────────────

  const handleUpload = isFolder ? uploadFilesFolder : uploadFilesRoot;
  const handleCancel = isFolder ? props.onCancel : props.reset;
  const uploadLabel = isFolder
    ? `Add ${files.length > 1 ? "Files" : "File"} to Folder`
    : `Upload File${files.length > 1 ? "s" : ""}`;
  const uploadingLabel = isFolder ? "Adding to Folder..." : "Preparing Files...";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="w-full">
      <FileDropzone
        setFiles={handleFiles}
      />

      {/* Sync folder selector — root mode only, shown when 2+ folders */}
      {!isFolder && (
        <SyncFolderSelect
          value={selectedFolderLabel}
          defaultLabel={
            (props as RootUploadProps).defaultFolderLabel
          }
          onChange={(label, path) => {
            setSelectedFolderLabel(label);
            setSelectedSyncPath(path);
          }}
          className="mt-4"
        />
      )}

      {/* Selected files list */}
      {files.length > 0 && (
        <div className="mt-4">
          <label className="mb-1.5 block text-sm font-medium text-grey-50 dark:text-grey-dark-600">
            Selected File{files.length > 1 ? "s" : ""}
          </label>
          <div className="max-h-[12.5rem] overflow-y-auto custom-scrollbar-thin rounded-[8px] border border-grey-80 bg-grey-90 pr-2 dark:border-[#313131] dark:bg-[#1a1a1a]">
            <div className="flex items-center gap-x-3 px-2 pr-1.5 py-1.5 font-medium">
              <div className="flex w-0 grow items-center justify-start text-grey-10 dark:text-white">
                <div className="w-fit truncate">{files[0].name}</div>
                {files.length > 1 && !revealFiles && (
                  <div className="ml-1 mr-auto min-w-fit rounded-[0.125rem] border border-grey-80 p-0.5 px-[0.1875rem] text-[0.625rem] text-grey-60 dark:border-[#3a3a3a] dark:text-grey-dark-600">
                    + {files.length - 1} More File
                    {files.length > 2 ? "s" : ""}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-x-2">
                {files.length > 1 && (
                  <button
                    onClick={() => setRevealFiles((v) => !v)}
                    className="flex items-center gap-x-2 text-sm text-grey-10 dark:text-white"
                    disabled={isUploading}
                  >
                    {revealFiles ? "Hide" : "View"}{" "}
                    <Icons.ArrowRight className="size-4" />
                  </button>
                )}
                <button
                  onClick={() => removeFile(0)}
                  className="text-grey-60 hover:text-error-50 dark:text-grey-dark-600"
                  title="Remove file"
                  disabled={isUploading}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>

            {revealFiles && (
              <div className="flex w-full flex-col gap-y-1 px-2 pb-1 font-medium text-grey-10 dark:text-white">
                {files.slice(1).map((file, i) => (
                  <div
                    key={file.path || file.name}
                    className="flex w-full items-center justify-between"
                  >
                    <div className="w-0 grow truncate">{file.name}</div>
                    <button
                      onClick={() => removeFile(i + 1)}
                      className="ml-2 flex-shrink-0 text-grey-60 hover:text-error-50 dark:text-grey-dark-600"
                      title="Remove file"
                      disabled={isUploading}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Progress bar — folder mode only */}
      {isFolder && isUploading && (
        <div className="mt-3">
          <div className="w-full h-2 bg-grey-80 dark:bg-[#313131] rounded-full overflow-hidden">
            <div
              className="h-full bg-primary-50 transition-all duration-300"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          <div className="mt-1 text-center text-sm text-grey-40 dark:text-grey-dark-600">
            {uploadProgress}% complete
          </div>
        </div>
      )}

      {/* Action buttons — match SyncDestinationDialog Figma styling */}
      <div className="mt-4 flex flex-col gap-3">
        <Button
          variant="primary"
          size="auto"
          onClick={handleUpload}
          disabled={files.length === 0 || isUploading}
          loading={isUploading}
          className={cn(
            "h-[52px] w-full rounded-[6px] border text-base font-normal tracking-[-0.36px] gap-2.5",
            "border-[#3167DD] bg-[#3167DD] text-white",
            "hover:bg-[#2454c4] hover:border-[#2454c4]",
            "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
          )}
        >
          {isUploading ? uploadingLabel : uploadLabel}
          {!isUploading && <ArrowRight className="size-4" />}
        </Button>
        <Button
          variant="defaultStable"
          size="auto"
          onClick={handleCancel}
          disabled={isUploading}
          className="h-[52px] w-full rounded-[6px] text-base font-normal tracking-[-0.36px]"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
};

export default UploadFilesFlow;