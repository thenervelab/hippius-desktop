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

  // Listen to Tauri native drag-drop events for the dropzone.
  // `cancelled` guards against the async-await + effect-cleanup race
  // where an `await listen(...)` resolves after cleanup ran, leaking a
  // stale listener bound to a previous `setFiles` reference.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const safePush = (un: () => void) => {
      if (cancelled) {
        un();
        return;
      }
      unlisteners.push(un);
    };

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;

        const unDragEnter = await listen<{ paths: string[] }>(
          "tauri://drag-enter",
          () => {
            setIsDragging(true);
          }
        );
        safePush(unDragEnter);
        if (cancelled) return;

        const unDragOver = await listen(
          "tauri://drag-over",
          () => {
            // Keep showing drag state
          }
        );
        safePush(unDragOver);
        if (cancelled) return;

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
        safePush(unDragDrop);
        if (cancelled) return;

        const unDragLeave = await listen(
          "tauri://drag-leave",
          () => {
            setIsDragging(false);
          }
        );
        safePush(unDragLeave);
      } catch (err) {
        console.error("[FileDropzone] Failed to register drag listeners:", err);
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [setFiles]);

  return (
    <div
      className={cn(
        "w-full h-full rounded-[8px] border p-2 transition-colors duration-200",
        "border-grey-80 bg-white",
        "dark:border-[#333] dark:bg-[#171717]",
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
          "dark:border-[#444] dark:bg-[#1e1e1e] dark:hover:bg-[#252525]",
          isDragging &&
            "border-primary-50 dark:border-primary-50 bg-primary-50/10"
        )}
      >
        <AbstractIconWrapper
          transparent
          className="size-10 text-primary-50"
          iconGridClassName="text-[#d4e0fb] dark:text-[#2a3a5c]"
        >
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
