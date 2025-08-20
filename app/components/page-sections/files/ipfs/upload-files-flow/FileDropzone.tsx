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

const FileDropzone: FC<{
  setFiles: (filePaths: string[]) => void;
}> = ({ setFiles }) => {
  const [isDragging, setIsDragging] = useState(false);

  const handleFilePaths = useCallback(
    (paths: string[]) => {
      if (!paths.length) {
        toast.error("No Files Found");
        return;
      }
      setFiles(paths);
    },
    [setFiles]
  );

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
      handleFilePaths(paths);
    } catch (error) {
      console.error("File selection error:", error);
      toast.error("Failed to select files");
    }
  }, [handleFilePaths]);

  // This is just a visual handler for drag & drop
  // The actual file selection will happen through the Tauri dialog
  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      // We'll open the dialog instead of handling dropped files
      handleSelectFiles();
    },
    [handleSelectFiles]
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
              Select Files to Upload
            </P>
            <P
              size="sm"
              className="mt-2 text-center text-grey-60 max-w-[264px]"
            >
              Click to select one or more files from your computer
            </P>
          </div>
        </div>
      </button>
    </div>
  );
};

export default FileDropzone;
