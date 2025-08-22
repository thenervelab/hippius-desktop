"use client";

import {
  useState,
  useCallback,
  FC,
  DragEvent,
} from "react";
import { toast } from "sonner";
import { open } from "@tauri-apps/plugin-dialog";

import { cn } from "@/lib/utils";
import { Icons, AbstractIconWrapper, P } from "@/components/ui";

// Type for handling both file paths (from dialog) and browser Files (from drop)
type SetFilesFunction = (paths: string[], browserFiles?: File[]) => void;

const FileDropzone: FC<{
  setFiles: SetFilesFunction;
}> = ({ setFiles }) => {
  const [isDragging, setIsDragging] = useState(false);

  const handleSelectFiles = useCallback(async () => {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
      });

      if (selected === null) {
        return; // User canceled the selection
      }

      // Handle both array of paths and single path
      const paths = Array.isArray(selected) ? selected : [selected];
      setFiles(paths);
    } catch (error) {
      console.error("File selection error:", error);
      toast.error("Failed to select files");
    }
  }, [setFiles]);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      // If files were dropped
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        // Convert FileList to array
        const droppedFiles = Array.from(e.dataTransfer.files);
        if (droppedFiles.length === 0) return;

        // Send empty paths array and browser files
        setFiles([], droppedFiles);
      }
    },
    [setFiles]
  );

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
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
        onClick={handleSelectFiles}
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
    </div>
  );
};

export default FileDropzone;
