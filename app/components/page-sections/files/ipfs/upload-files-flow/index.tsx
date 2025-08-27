// src/app/components/page-sections/files/ipfs/UploadFilesFlow.tsx
import { FC, useState, useEffect, useCallback } from "react";
import useFilesUpload from "@/lib/hooks/useFilesUpload";
import { Icons, CardButton } from "@/components/ui";
import FileDropzone from "./FileDropzone";
import { useSetAtom } from "jotai";
import { insufficientCreditsDialogOpenAtom } from "@/components/page-sections/files/ipfs/atoms/query-atoms";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { basename } from '@tauri-apps/api/path';
import { invoke } from "@tauri-apps/api/core";
import { formatDisplayName } from "@/lib/utils/fileTypeUtils"; // Add this import


interface UploadFilesFlowProps {
  reset: () => void;
  initialFiles?: FileList | null;
  isPrivateView: boolean;
}

interface FilePathInfo {
  path: string;
  name: string;
  file?: File;
}

const UploadFilesFlow: FC<UploadFilesFlowProps> = ({
  reset,
  initialFiles,
  isPrivateView
}) => {
  const [revealFiles, setRevealFiles] = useState(false);
  const [files, setFiles] = useState<FilePathInfo[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const setInsufficient = useSetAtom(insufficientCreditsDialogOpenAtom);

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
      reset();
      setIsUploading(false);
    }
  });

  // Handle initial files - just store references without writing to disk yet
  useEffect(() => {
    if (initialFiles && initialFiles.length > 0) {
      const fileInfos = Array.from(initialFiles).map(file => ({
        path: '', // Path will be set during upload
        name: file.name,
        file: file // Store the File object
      }));

      setFiles(fileInfos);
      if (fileInfos.length > 1) setRevealFiles(true);
    }
  }, [initialFiles]);

  // Handle files from both file dialog and drag-and-drop
  const handleFiles = useCallback(async (paths: string[], browserFiles?: File[]) => {
    try {
      let newPathInfos: FilePathInfo[] = [];

      // Handle file paths from file dialog
      if (paths.length > 0) {
        newPathInfos = await Promise.all(
          paths.map(async (path) => ({
            path,
            name: await basename(path)
          }))
        );
      }

      // Handle browser File objects from drag and drop
      if (browserFiles && browserFiles.length > 0) {
        const browserFileInfos = browserFiles.map(file => ({
          path: '',
          name: file.name,
          file: file
        }));
        newPathInfos = [...newPathInfos, ...browserFileInfos];
      }

      if (newPathInfos.length === 0) return;

      setFiles((prev) => {
        if (!prev.length) return newPathInfos;

        // Create a Set of existing paths/names to avoid duplicates
        const seen = new Set(prev.map(f => f.path || f.name));
        const unique = newPathInfos.filter(f => !seen.has(f.path || f.name));

        if (unique.length === 0) return prev;

        const combined = [...prev, ...unique];
        if (combined.length > 1) setRevealFiles(true);
        return combined;
      });
    } catch (error) {
      console.error("Error processing files:", error);
      toast.error("Failed to process selected files");
    }
  }, []);

  const removeFile = useCallback(
    (idx: number) => {
      const newFiles = files.filter((_, i) => i !== idx);
      setFiles(newFiles);
      if (newFiles.length === 1) setRevealFiles(false);
    },
    [files]
  );

  const uploadFiles = async () => {
    if (files.length === 0) return;

    setIsUploading(true);

    const firstFileName = files.length === 1
      ? formatDisplayName(files[0].name)
      : `${files.length} files`;

    const toastId = toast.loading(`Preparing ${firstFileName} for upload...`);

    try {
      // Process the files - write browser File objects to disk first
      const processedPaths: string[] = [];
      console.log("fileInfo", files)

      for (const fileInfo of files) {
        if (fileInfo.file) {
          try {
            const arrayBuffer = await fileInfo.file.arrayBuffer();
            const tempPath = `/tmp/${fileInfo.name}`;

            // Write file to disk using Tauri command
            await invoke("write_file", {
              path: tempPath,
              data: Array.from(new Uint8Array(arrayBuffer)),
            });

            processedPaths.push(tempPath);
          } catch (error) {
            console.error(`Error processing file ${fileInfo.name}:`, error);
            toast.error(`Failed to process file: ${formatDisplayName(fileInfo.name)}`);
          }
        } else if (fileInfo.path) {
          // This is already a path to a file on disk
          processedPaths.push(fileInfo.path);
        }
      }

      if (processedPaths.length === 0) {
        toast.error("No valid files to upload", { id: toastId });
        setIsUploading(false);
        return;
      }

      toast.loading(`Starting upload of ${firstFileName}...`, { id: toastId });

      reset(); // Close dialog
      // Pass the toast id so the hook reuses and updates the same toast
      upload(processedPaths, isPrivateView, {
        toastId,
        messages: {
          startSingle: files.length === 1 ? `Uploading ${firstFileName}: 0%` : undefined,
          uploadingSingle: (percent) => files.length === 1 ? `Uploading ${firstFileName}: ${percent}%` : `Uploading: ${percent}%`,
          successSingle: files.length === 1 ? `${firstFileName} successfully uploaded!` : undefined,
          errorSingle: files.length === 1 ? `Failed to upload ${firstFileName}` : undefined
        }
      });
    } catch (error) {
      console.error("Error preparing files:", error);
      toast.error(
        `Error preparing ${firstFileName} for upload: ${error instanceof Error ? error.message : String(error)}`,
        { id: toastId }
      );
      setIsUploading(false);
    }
  };

  return (
    <div className="w-full">
      <FileDropzone setFiles={handleFiles} />

      {files.length > 0 && (
        <div className="bg-grey-90 max-h-[200px] overflow-y-auto custom-scrollbar-thin pr-2 rounded-[8px] mt-4">
          <div className="flex items-center font-medium px-2 gap-x-3 pr-1.5 py-1.5">
            <div className="text-grey-10 flex items-center justify-start w-0 grow">
              <div className="w-fit truncate">{files[0].name}</div>
              {files.length > 1 && !revealFiles && (
                <div className="text-grey-60 ml-1 mr-auto min-w-fit p-0.5 px-[3px] border rounded-[2px] border-grey-80 text-[10px]">
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
      )}

      <div className="mt-3 flex flex-col gap-y-3">
        <CardButton
          onClick={uploadFiles}
          disabled={files.length === 0 || isUploading}
          className="w-full"
        >
          {isUploading
            ? "Preparing Files..."
            : `Upload File${files.length > 1 ? "s" : ""}`}
        </CardButton>
        <CardButton
          onClick={reset}
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
