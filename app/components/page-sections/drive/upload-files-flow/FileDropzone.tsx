"use client";

import {
  useState,
  useCallback,
  useEffect,
  FC,
} from "react";
import { toast } from "sonner";
import { open } from "@tauri-apps/plugin-dialog";

import { cn } from "@/lib/utils";
import { Icons, AbstractIconWrapper } from "@/components/ui";
import { getLastBrowseDirectory, saveLastBrowseDirectory } from "@/lib/utils/userPreferencesDb";

// Type for handling both file paths (from dialog) and browser Files (from drop)
type SetFilesFunction = (paths: string[], browserFiles?: File[]) => void;

const FileDropzone: FC<{
  setFiles: SetFilesFunction;
}> = ({ setFiles }) => {
  const [isDragging, setIsDragging] = useState(false);

  const handleSelectFiles = useCallback(async () => {
    try {
      const defaultPath = await getLastBrowseDirectory();
      const selected = await open({
        multiple: true,
        directory: false,
        defaultPath,
      });

      if (selected === null) {
        return; // User canceled the selection
      }

      // Handle both array of paths and single path
      const paths = Array.isArray(selected) ? selected : [selected];
      setFiles(paths);

      // Remember this directory for next time
      saveLastBrowseDirectory(paths[0], true);
    } catch (error) {
      console.error("File selection error:", error);
      toast.error("Failed to select files");
    }
  }, [setFiles]);

  // Listen to Tauri native drag-drop events for the dropzone
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");

        const unDragEnter = await listen<{ paths: string[] }>(
          "tauri://drag-enter",
          () => {
            setIsDragging(true);
          }
        );
        unlisteners.push(unDragEnter);

        const unDragOver = await listen(
          "tauri://drag-over",
          () => {
            // Keep showing drag state
          }
        );
        unlisteners.push(unDragOver);

        const unDragDrop = await listen<{ paths: string[] }>(
          "tauri://drag-drop",
          async (event) => {
            setIsDragging(false);
            const paths = event.payload.paths;
            if (!paths || paths.length === 0) return;

            // Filter out directories (shows toast if any dropped)
            try {
              const { filterDroppedPaths } = await import("@/lib/utils/filterDroppedPaths");
              const filePaths = await filterDroppedPaths(paths);
              if (filePaths.length > 0) {
                setFiles(filePaths);
              }
            } catch (err) {
              console.error("[FileDropzone] Error checking paths:", err);
              // Fallback: pass all paths through
              setFiles(paths);
            }
          }
        );
        unlisteners.push(unDragDrop);

        const unDragLeave = await listen(
          "tauri://drag-leave",
          () => {
            setIsDragging(false);
          }
        );
        unlisteners.push(unDragLeave);
      } catch (err) {
        console.error("[FileDropzone] Failed to register drag listeners:", err);
      }
    })();

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, [setFiles]);

  return (
    <div
      className={cn(
        "w-full h-full rounded-[8px] border p-2 transition-colors duration-200",
        "border-grey-80 bg-white",
        "dark:border-[#313131] dark:bg-[#1a1a1a]",
        isDragging &&
          "border-primary-50 dark:border-primary-50 bg-primary-50/5 dark:bg-primary-50/10"
      )}
    >
      <button
        type="button"
        onClick={handleSelectFiles}
        className={cn(
          "h-full w-full flex flex-col items-center justify-center gap-3 rounded-[8px] border border-dashed px-6 py-6 cursor-pointer transition-colors duration-200",
          "border-grey-80 bg-white hover:bg-grey-light-300",
          "dark:border-[#313131] dark:bg-[#1a1a1a] dark:hover:bg-[#222222]",
          isDragging &&
            "border-primary-50 dark:border-primary-50 bg-primary-50/10"
        )}
      >
        <AbstractIconWrapper className="size-10">
          <Icons.Box className="relative size-4" />
        </AbstractIconWrapper>

        <div className="flex flex-col items-center gap-1">
          <span className="font-geist text-base font-medium leading-[22px] tracking-[-0.32px] text-grey-10 dark:text-white">
            Upload a File Here
          </span>
          <span className="font-geist text-sm font-medium leading-5 tracking-[-0.28px] text-center text-grey-60 dark:text-grey-dark-600 max-w-[262px]">
            Drag and drop or click to add one or more files here to upload
          </span>
        </div>
      </button>
    </div>
  );
};

export default FileDropzone;
