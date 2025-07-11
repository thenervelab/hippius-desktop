import { FC, useState, useEffect, useCallback } from "react";
import { useUploadIpfsFileAndSubmitToBlockchain } from "@/lib/hooks";

import { Icons, Button } from "@/components/ui";
import FileDropzone from "./FileDropzone";
import { useSetAtom } from "jotai";
import { uploadProgressAtom, insufficientCreditsDialogOpenAtom } from "../atoms/query-atoms";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

interface UploadFilesFlowProps {
  reset: () => void;
  initialFiles?: FileList | null;
}

const UploadFilesFlow: FC<UploadFilesFlowProps> = ({ reset, initialFiles }) => {
  const [revealFiles, setRevealFiles] = useState(false);
  const [files, setFiles] = useState<FileList | null>(null);
  const setProgress = useSetAtom(uploadProgressAtom);
  const setInsufficientCreditsDialogOpen = useSetAtom(insufficientCreditsDialogOpenAtom);

  useEffect(() => {
    if (initialFiles && initialFiles.length > 0) {
      setFiles(initialFiles);
      if (initialFiles.length > 1) {
        setRevealFiles(true);
      }
    }
  }, [initialFiles]);

  const hasMultipleFiles = files ? files.length > 1 : false;

  const appendFiles = useCallback((newFiles: FileList | null) => {
    if (!newFiles || newFiles.length === 0) return;

    setFiles(prevFiles => {
      if (!prevFiles) return newFiles;

      const existingFiles = new Map();
      Array.from(prevFiles).forEach(file => {
        const fileKey = `${file.name}-${file.size}-${file.lastModified}`;
        existingFiles.set(fileKey, true);
      });

      const uniqueNewFiles = Array.from(newFiles).filter(file => {
        const fileKey = `${file.name}-${file.size}-${file.lastModified}`;
        return !existingFiles.has(fileKey);
      });

      if (uniqueNewFiles.length === 0) {
        toast.info("All files already selected");
        return prevFiles;
      }

      const combinedArray = [...Array.from(prevFiles), ...uniqueNewFiles];

      const dataTransfer = new DataTransfer();
      combinedArray.forEach(file => dataTransfer.items.add(file));

      if (combinedArray.length > 1) {
        setRevealFiles(true);
      }

      return dataTransfer.files;
    });
  }, []);

  const removeFile = useCallback((indexToRemove: number) => {
    if (!files) return;

    const filesArray = Array.from(files);

    if (indexToRemove < 0 || indexToRemove >= filesArray.length) {
      return;
    }

    const updatedFiles = filesArray.filter((_, index) => index !== indexToRemove);

    if (updatedFiles.length === 0) {
      setFiles(null);
      return;
    }

    const dataTransfer = new DataTransfer();
    updatedFiles.forEach(file => dataTransfer.items.add(file));

    setFiles(dataTransfer.files);

    if (updatedFiles.length === 1) {
      setRevealFiles(false);
    }
  }, [files]);

  const { upload } = useUploadIpfsFileAndSubmitToBlockchain({
    onError(error) {
      if (error instanceof Error && error.message.includes("Insufficient Credits")) {
        setInsufficientCreditsDialogOpen(true);
      } else if (error instanceof Error) {
        toast.error(error.message);
      } else {
        console.log("error", error);
        toast.error("Oops and error occured!");
      }
      setProgress(0);
    },
    onSuccess() {
      toast.success(files ? `${files?.length} file${files?.length > 1 ? "s" : ""} uploaded successfully!` : "File uploaded successfully!");
      setProgress(0);
    },
  });

  return (
    <>
      <div className="w-full">
        <FileDropzone setFiles={appendFiles} />

        {files?.length && (
          <div className="bg-grey-90 max-h-[200px] overflow-y-auto custom-scrollbar-thin pr-2 rounded-[8px] mt-4">
            <div className="flex items-center font-medium px-2 gap-x-3 pr-1.5 py-1.5">
              <div className="text-grey-10 flex items-center justify-start w-0 grow">
                <div className="w-fit truncate">{files[0].name}</div>
                {hasMultipleFiles && !revealFiles && (
                  <div className="text-grey-60 ml-1 mr-auto min-w-fit p-0.5 px-[3px] border rounded-[2px] border-grey-80 text-[10px]">
                    + {files.length - 1} More File{files.length > 2 ? "s" : ""}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-x-2">
                {hasMultipleFiles && (
                  <button
                    onClick={() => {
                      setRevealFiles((v) => !v);
                    }}
                    className="flex items-center gap-x-2 text-sm text-grey-10"
                  >
                    {revealFiles ? "Hide" : "View"}{" "}
                    <Icons.ArrowRight className="size-4" />
                  </button>
                )}
                <button
                  onClick={() => removeFile(0)}
                  className="text-grey-60 hover:text-error-50"
                  title="Remove file"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>

            {revealFiles && (
              <div className="px-2 flex flex-col w-full gap-y-1 pb-1 font-medium text-grey-10">
                {Array.from(files).map((file, i) => {
                  if (i > 0) {
                    return (
                      <div
                        className="w-full flex items-center justify-between"
                        key={`${file.name}-${file.lastModified}-${file.size}`}
                      >
                        <div className="w-0 grow truncate">{file.name}</div>
                        <button
                          onClick={() => removeFile(i)}
                          className="ml-2 text-grey-60 hover:text-error-50 flex-shrink-0"
                          title="Remove file"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-col gap-y-3">
          <Button
            onClick={() => {
              if (files) {
                reset();
                upload(files);
              }
            }}
            disabled={!files || !files.length}
            className="w-full"
          >
            Upload File{files && files.length > 1 ? "s" : ""}
          </Button>
          <Button onClick={reset} className="w-full" variant="secondary">
            Cancel
          </Button>
        </div>
      </div>
    </>
  );
};

export default UploadFilesFlow;
