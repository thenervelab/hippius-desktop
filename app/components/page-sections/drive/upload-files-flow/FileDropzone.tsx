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
import { Icons, AbstractIconWrapper, P } from "@/components/ui";
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
        "w-full h-full border rounded-[0.5rem] p-2 transition-colors duration-200",
        isDragging
          ? "border-primary-50 border-2 bg-primary-50/5"
          : "border-grey-80"
      )}
    >
      <button
        onClick={handleSelectFiles}
        className={cn(
          "h-full w-full flex border border-dashed justify-center py-10 px-10 bg-white cursor-pointer hover:bg-grey-90 duration-300 rounded-[0.5rem]",
          isDragging
            ? "border-primary-50 bg-primary-50/10"
            : "border-grey-80"
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
              className="mt-2 text-center text-grey-60 max-w-[16.5rem]"
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
