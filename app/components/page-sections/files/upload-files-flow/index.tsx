// Unified file upload flow component — handles both root-level uploads and folder-targeted uploads.
import { FC, useState, useEffect, useCallback } from "react";
import useFilesUpload from "@/lib/hooks/useFilesUpload";
import { Icons, CardButton } from "@/components/ui";
import FileDropzone from "./FileDropzone";
import { useSetAtom, useAtomValue } from "jotai";
import { insufficientCreditsDialogOpenAtom } from "@/app/components/page-sections/files/atoms/query-atoms";
import { queryClientAtom } from "jotai-tanstack-query";
import { REMOTE_STORAGE_STATS_QUERY_KEY } from "@/app/lib/hooks/api/useRemoteStorageStats";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { basename } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { formatDisplayName } from "@/lib/utils/fileTypeUtils";
import SyncFolderSelect from "@/components/ui/SyncFolderSelect";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { getPrivateSyncPath } from "@/lib/utils/syncPathUtils";

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
      if (
        err instanceof Error &&
        err.message.includes("Insufficient Credits")
      ) {
        setInsufficient(true);
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

    for (const fileInfo of fileList) {
      if (fileInfo.file) {
        try {
          const arrayBuffer = await fileInfo.file.arrayBuffer();
          const tempPath = `/tmp/${fileInfo.name}`;
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

    const toastId = toast.loading(
      `Preparing ${firstFileName} for upload...`
    );

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
          error instanceof Error ? error.message : String(error)
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

    props.onCancel(); // Close dialog
    setIsUploading(true);
    setUploadProgress(0);

    const fileCount = files.length;

    // Show success toast immediately before backend work
    toast.success(
      fileCount === 1
        ? "File added. Your sync will start soon."
        : `${fileCount} files added. Your sync will start soon.`,
      { duration: 4000, closeButton: true }
    );

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        let filePath = file.path;

        if (file.file) {
          try {
            const arrayBuffer = await file.file.arrayBuffer();
            const tempPath = `/tmp/${file.name}`;
            const { writeFile: tauriWriteFile } = await import(
              "@tauri-apps/plugin-fs"
            );
            await tauriWriteFile(tempPath, new Uint8Array(arrayBuffer));
            filePath = tempPath;
          } catch (error) {
            console.error(`Error processing file ${file.name}:`, error);
            toast.error(`Failed to process file: ${file.name}`);
            continue;
          }
        }

        const baseSyncPath =
          syncBasePath || ((await getPrivateSyncPath(polkadotAddress ?? undefined))?.path ?? "");
        let targetPath = baseSyncPath;
        if (props.subfolder) {
          const { join } = await import("@tauri-apps/api/path");
          targetPath = await join(baseSyncPath, props.subfolder);
        }

        await invoke<string>("add_file", {
          syncPath: targetPath,
          filePath,
        });

        setUploadProgress(Math.round(((i + 1) / files.length) * 100));

        if (files.length > 1) await new Promise((r) => setTimeout(r, 300));
      }

      await invoke("trigger_sync_now").catch((err: unknown) => console.warn("[UploadFilesFlow] trigger_sync_now failed:", err));

      // Refresh file list AFTER backend has added the files so list_sync_folder sees them
      queryClient.invalidateQueries({ queryKey: [REMOTE_STORAGE_STATS_QUERY_KEY] });
      props.onSuccess();
    } catch (error) {
      console.error(
        "Failed to add files to folder:",
        error,
        "  ",
        props.folderName
      );
      toast.error(
        `Failed to add ${fileCount === 1 ? "file" : "files"}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
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
          <label className="text-sm font-medium text-grey-50 mb-1.5 block">
            Selected File{files.length > 1 ? "s" : ""}
          </label>
          <div className="bg-grey-90 max-h-[12.5rem] overflow-y-auto custom-scrollbar-thin pr-2 rounded-[0.5rem]">
            <div className="flex items-center font-medium px-2 gap-x-3 pr-1.5 py-1.5">
              <div className="text-grey-10 flex items-center justify-start w-0 grow">
                <div className="w-fit truncate">{files[0].name}</div>
                {files.length > 1 && !revealFiles && (
                  <div className="text-grey-60 ml-1 mr-auto min-w-fit p-0.5 px-[0.1875rem] border rounded-[0.125rem] border-grey-80 text-[0.625rem]">
                    + {files.length - 1} More File
                    {files.length > 2 ? "s" : ""}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-x-2">
                {files.length > 1 && (
                  <button
                    onClick={() => setRevealFiles((v) => !v)}
                    className="flex items-center gap-x-2 text-sm text-grey-10"
                    disabled={isUploading}
                  >
                    {revealFiles ? "Hide" : "View"}{" "}
                    <Icons.ArrowRight className="size-4" />
                  </button>
                )}
                <button
                  onClick={() => removeFile(0)}
                  className="text-grey-60 hover:text-error-50"
                  title="Remove file"
                  disabled={isUploading}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>

            {revealFiles && (
              <div className="px-2 flex flex-col w-full gap-y-1 pb-1 font-medium text-grey-10">
                {files.slice(1).map((file, i) => (
                  <div
                    key={file.path || file.name}
                    className="w-full flex items-center justify-between"
                  >
                    <div className="w-0 grow truncate">{file.name}</div>
                    <button
                      onClick={() => removeFile(i + 1)}
                      className="ml-2 text-grey-60 hover:text-error-50 flex-shrink-0"
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
          <div className="w-full h-2 bg-grey-80 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary-50 transition-all duration-300"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          <div className="mt-1 text-center text-sm text-grey-40">
            {uploadProgress}% complete
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-3 flex flex-col gap-y-3">
        <CardButton
          onClick={handleUpload}
          disabled={files.length === 0 || isUploading}
          className="w-full"
        >
          {isUploading ? uploadingLabel : uploadLabel}
        </CardButton>
        <CardButton
          onClick={handleCancel}
          className="w-full"
          variant="secondary"
          disabled={isUploading}
        >
          Cancel
        </CardButton>
      </div>
    </div>
  );
};

export default UploadFilesFlow;