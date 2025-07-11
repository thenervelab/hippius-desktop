"use client";

import {
  useState,
  useCallback,
  FC,
  DragEvent,
  ChangeEvent,
  useRef,
} from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Icons, AbstractIconWrapper, P } from "@/components/ui";

const FileDropzone: FC<{
  setFiles: (files: FileList | null) => void;
}> = ({ setFiles }) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: FileList) => {
      if (!files.length) {
        toast.error("No Files Found");
        return;
      }
      setFiles(files);
    },
    [setFiles]
  );

  const handleOnChange = (e: ChangeEvent<HTMLInputElement>) => {
    const targetFiles = e.target.files;

    if (targetFiles) {
      handleFiles(targetFiles);
    }
  };

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const targetFiles = e.dataTransfer.files;
      if (targetFiles) {
        handleFiles(targetFiles);
      }
    },
    [handleFiles]
  );

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };
  return (
    <div
      className="w-full h-full border border-grey-80 rounded-[8px] p-2"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <button
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          "h-full w-full flex border border-dashed border-grey-80 justify-center py-10 px-10 bg-white cursor-pointer hover:bg-grey-90 duration-300 rounded-[8px]",
          isDragging && "bg-grey-90"
        )}
      >
        <div className="flex flex-col items-center">
          <AbstractIconWrapper className="size-8">
            <Icons.Box className="relative" />
          </AbstractIconWrapper>

          <div className="mt-2 flex flex-col">
            <P className="font-semibold text-grey-10" size="md">
              Upload a File Here
            </P>
            <P
              size="sm"
              className="mt-2 text-center text-grey-60 max-w-[264px]"
            >
              Drag and drop or click to add one or more files here to upload
            </P>
          </div>
        </div>
      </button>
      <input
        multiple
        type="file"
        ref={fileInputRef}
        onChange={handleOnChange}
        className="hidden"
      />
    </div>
  );
};

export default FileDropzone;
