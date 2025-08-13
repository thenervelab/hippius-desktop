// src/app/components/page-sections/files/ipfs/UploadFilesFlow.tsx
import { FC, useState, useEffect, useCallback } from "react";
import useFilesUpload from "@/lib/hooks/useFilesUpload";
import { Icons, CardButton, Input } from "@/components/ui";
import { Label } from "@/components/ui/label";
import FileDropzone from "./FileDropzone";
import { useSetAtom } from "jotai";
import { insufficientCreditsDialogOpenAtom } from "@/components/page-sections/files/ipfs/atoms/query-atoms";
import { Trash2, Check, AlertCircle } from "lucide-react";
import * as Checkbox from "@radix-ui/react-checkbox";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";


interface UploadFilesFlowProps {
  reset: () => void;
  initialFiles?: FileList | null;
  isPrivateView: boolean;
}

interface EncryptionKey {
  id: number;
  key: string;
}

const UploadFilesFlow: FC<UploadFilesFlowProps> = ({
  reset,
  initialFiles,
  isPrivateView
}) => {
  const [revealFiles, setRevealFiles] = useState(false);
  const [files, setFiles] = useState<FileList | null>(null);
  const [erasureCoding, setErasureCoding] = useState(false);
  const setInsufficient = useSetAtom(insufficientCreditsDialogOpenAtom);
  const [encryptionKeyError, setEncryptionKeyError] = useState<string | null>(
    null
  );
  const [encryptionKey, setEncryptionKey] = useState("");



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

  const uploadFiles = async (files: FileList): Promise<void> => {
    // Validate encryption key if provided
    if (encryptionKey) {
      try {
        const savedKeys: EncryptionKey[] = await invoke<EncryptionKey[]>(
          "get_encryption_keys"
        );

        const keyExists: boolean = savedKeys.some((k) => k.key === encryptionKey);

        if (!keyExists) {
          setEncryptionKeyError(
            "Incorrect encryption key. Please try again with a correct one."
          );
          return;
        }
      } catch (error) {
        console.error("Error validating encryption key:", error);
        toast.error("Failed to validate encryption key");
        return;
      }
    }
    reset();
    upload(files, isPrivateView, erasureCoding, encryptionKey);
  };

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

      {!isPrivateView && (
        <div className="flex items-start mt-3">
          <Checkbox.Root
            className="h-4 w-4 rounded border border-grey-70 flex items-center justify-center bg-grey-90 mt-[3px] data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 transition-colors"
            checked={erasureCoding}
            onCheckedChange={() => setErasureCoding((prev) => !prev)}
            id="erasureCoding"
          >
            <Checkbox.Indicator>
              <Check className="h-3.5 w-3.5 text-white" />
            </Checkbox.Indicator>
          </Checkbox.Root>
          <div className="ml-2">
            <label
              htmlFor="erasureCoding"
              className="text-[15px] font-medium text-grey-20 leading-[22px]"
            >
              Use Erasure Coding
            </label>
          </div>
        </div>
      )}

      {isPrivateView && (
        <div className="space-y-1 mt-4">
          <Label
            htmlFor="encryptionKey"
            className="text-sm font-medium text-grey-70"
          >
            Encryption Key (optional)
          </Label>
          <div className="relative flex items-start w-full">
            <Icons.ShieldSecurity className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
            <Input
              id="encryptionKey"
              placeholder="Enter encryption key"
              value={encryptionKey}
              onChange={(e) => {
                setEncryptionKey(e.target.value);
                setEncryptionKeyError(null);
              }}
              className={`pl-11 border-grey-80 h-14 text-grey-30 w-full
                bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none 
                hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus
                ${encryptionKeyError ? "border-error-50 focus:border-error-50" : ""}`}
            />
          </div>
          <p className="text-xs text-grey-70">
            {encryptionKey.trim()
              ? `Using custom encryption key.`
              : "Default encryption key will be used if left empty."}
          </p>

          {encryptionKeyError && (
            <div className="flex text-error-70 text-sm font-medium items-center gap-2">
              <AlertCircle className="size-4 !relative" />
              <span>{encryptionKeyError}</span>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-y-3">
        <CardButton
          onClick={() => {
            if (files) {
              uploadFiles(files)
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
