// src/app/components/page-sections/files/ipfs/UploadFilesFlow.tsx
import { FC, useState, useEffect, useCallback } from "react";
import useFilesUpload from "@/lib/hooks/useFilesUpload";
import { Icons, CardButton } from "@/components/ui";
import FileDropzone from "./FileDropzone";
import { useSetAtom } from "jotai";
import { insufficientCreditsDialogOpenAtom } from "../atoms/query-atoms";
import { Trash2 } from "lucide-react";

interface UploadFilesFlowProps {
  reset: () => void;
  initialFiles?: FileList | null;
  isPrivateView: boolean;
}

const UploadFilesFlow: FC<UploadFilesFlowProps> = ({
  reset,
  initialFiles,
  isPrivateView
}) => {
  const [revealFiles, setRevealFiles] = useState(false);
  const [files, setFiles] = useState<FileList | null>(null);
  const setInsufficient = useSetAtom(insufficientCreditsDialogOpenAtom);

  const { upload } = useFilesUpload({
    onError(err) {
      if (
        err instanceof Error &&
        err.message.includes("Insufficient Credits")
      ) {
        setInsufficient(true);
      }
    },
    onSuccess() {
      reset();
    }
  });

  useEffect(() => {
    if (initialFiles && initialFiles.length > 0) {
      setFiles(initialFiles);
      if (initialFiles.length > 1) setRevealFiles(true);
    }
  }, [initialFiles]);

  const appendFiles = useCallback((newFiles: FileList | null) => {
    if (!newFiles?.length) return;
    setFiles((prev) => {
      if (!prev) return newFiles;
      const seen = new Set(
        Array.from(prev).map((f) => `${f.name}-${f.size}-${f.lastModified}`)
      );
      const unique = Array.from(newFiles).filter(
        (f) => !seen.has(`${f.name}-${f.size}-${f.lastModified}`)
      );
      if (!unique.length) return prev;
      const combined = [...Array.from(prev), ...unique];
      const dt = new DataTransfer();
      combined.forEach((f) => dt.items.add(f));
      if (combined.length > 1) setRevealFiles(true);
      return dt.files;
    });
  }, []);

  const removeFile = useCallback(
    (idx: number) => {
      if (!files) return;
      const arr = Array.from(files).filter((_, i) => i !== idx);
      if (!arr.length) return void setFiles(null);
      const dt = new DataTransfer();
      arr.forEach((f) => dt.items.add(f));
      setFiles(dt.files);
      if (arr.length === 1) setRevealFiles(false);
    },
    [files]
  );

  return (
    <div className="w-full">
      <FileDropzone setFiles={appendFiles} />

      {files?.length && (
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
              {Array.from(files)
                .slice(1)
                .map((f, i) => (
                  <div
                    key={`${f.name}-${f.lastModified}-${f.size}`}
                    className="w-full flex items-center justify-between"
                  >
                    <div className="w-0 grow truncate">{f.name}</div>
                    <button
                      onClick={() => removeFile(i + 1)}
                      className="ml-2 text-grey-60 hover:text-error-50 flex-shrink-0"
                      title="Remove file"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-y-3">
        <CardButton
          onClick={() => {
            if (files) {
              reset();
              upload(files, isPrivateView);
            }
          }}
          disabled={!files?.length}
          className="w-full"
        >
          Upload File{files && files.length > 1 ? "s" : ""}
        </CardButton>
        <CardButton onClick={reset} className="w-full" variant="secondary">
          Cancel
        </CardButton>
      </div>
    </div>
  );
};

export default UploadFilesFlow;
