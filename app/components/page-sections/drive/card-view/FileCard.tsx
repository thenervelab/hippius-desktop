import React, { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { cn } from "@/lib/utils";
import { FileTypeIcon } from "@/components/ui";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
// import { Graphsheet } from "@/components/ui";
import { Loader2, Play } from "lucide-react";
import Link from "next/link";
import {
  formatDisplayName,
  getFileIcon,
} from "@/lib/utils/fileTypeUtils";
import { Folder2 } from "@/components/ui/icons";
import SharedLinkBadge from "@/components/page-sections/drive/SharedLinkBadge";
import { useUrlParams } from '@/app/utils/hooks/useUrlParams';
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";
import { useThumbnail } from "@/app/lib/hooks/useThumbnail";
import { useInView } from "@/app/lib/hooks/useInView";
import { buildFolderPath } from '@/app/utils/folderPathUtils';
import { useFileSelection } from '@/app/contexts/FileSelectionContext';
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
interface FileCardProps {
  file: FormattedUserFile;
  state: "success" | "pending" | "error";
  onClick: () => void;
  actionMenu: React.ReactNode;
}

const FileCard: React.FC<FileCardProps> = ({
  file,
  state,
  onClick,
  actionMenu,
}) => {
  const { fileName, fileFormat } = getFilePartsFromFileName(file.name);
  const { isSelectionMode, isFileSelected, toggleFileSelection } = useFileSelection();
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [thumbnailError, setThumbnailError] = useState(false);
  const [isLoadingThumbnail, setIsLoadingThumbnail] = useState(false);
  const [loadAttempts, setLoadAttempts] = useState(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const fileIdRef = useRef<string>("");

  const fileType = getFileTypeFromExtension(fileFormat || null);
  const shouldLoadThumbnail = !file.isFolder && (fileType === "image" || fileType === "video");
  const isImageType = fileType === "image";

  // Lazy-load: only fetch a cloud thumbnail once the card scrolls into view.
  const [cardRef, inView] = useInView<HTMLDivElement>();
  // Images (local AND cloud-only — other devices / unsynced folders) resolve
  // through the shared thumbnailer; cloud fetches are gated on `inView`. Videos
  // keep the canvas-frame path in the effect below (local only for now).
  const imageThumb = useThumbnail(isImageType ? file : null, { enabled: inView });

  const displayName = formatDisplayName(file.name);
  const { icon: Icon, color } = getFileIcon(fileType ?? undefined, !!file.isFolder);

  const { getParam } = useUrlParams();

  // Get current path information for folder navigation
  const folderActualName = file.isFolder ? file.actualFileName || "" : "";
  const mainFolderHash = getParam("mainFolderCid", "");
  const mainFolderActualName = getParam("mainFolderActualName", folderActualName);
  const subFolderPath = getParam("subFolderPath", "");
  const effectiveMainFolderHash = mainFolderHash || file.arionHash;
  const effectiveMainFolderActualName = mainFolderActualName || folderActualName;

  // Build the folder path for navigation
  const { mainFolderCid: newMainFolderHash, mainFolderActualName: newMainFolder, subFolderPath: newSubFolderPath } = buildFolderPath(
    folderActualName,
    effectiveMainFolderHash,
    effectiveMainFolderActualName,
    subFolderPath
  );

  // Reset thumbnail state when file changes
  useEffect(() => {
    // Generate a unique ID for this file to track changes
    const currentFileId = `${file.arionHash}-${file.name}`;

    // If the file changed, reset all thumbnail states
    if (fileIdRef.current !== currentFileId) {
      fileIdRef.current = currentFileId;
      setThumbnailUrl(null);
      setThumbnailError(false);
      setIsLoadingThumbnail(false);
      setLoadAttempts(0);

      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }
  }, [file.arionHash, file.name]);

  useEffect(() => {
    // Video-only: images now resolve through `useThumbnail` (which also handles
    // cloud-only files). This canvas-frame grab stays for local videos and is
    // deferred until the card is in view.
    if (
      fileType !== "video" ||
      !inView ||
      thumbnailUrl ||
      thumbnailError ||
      loadAttempts >= 2 ||
      isLoadingThumbnail ||
      file.isFolder
    ) {
      return;
    }

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    setIsLoadingThumbnail(true);
    setLoadAttempts((prev) => prev + 1);

    const handleError = () => {
      setThumbnailError(true);
      setIsLoadingThumbnail(false);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    const handleSuccess = (url: string) => {
      setThumbnailUrl(url);
      setIsLoadingThumbnail(false);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    try {
      const { url: localUrl, isLocal: isFromLocal } = getFileUrl(file);

      timeoutRef.current = setTimeout(handleError, 15000);

      // Cloud-only videos have no local URL to grab a frame from; fall back to
      // the file-type icon. Downloading a whole video just for a card frame is
      // too costly — only images go through the cached Rust thumbnailer.
      if (!isFromLocal || !localUrl) {
        handleError();
        return;
      }

      const video = document.createElement("video");
      video.src = localUrl;
      video.preload = "metadata";

      video.onloadedmetadata = () => {
        try {
          const seekTime = Math.min(1, video.duration * 0.25);
          video.currentTime = seekTime;

          video.onseeked = () => {
            try {
              const canvas = document.createElement("canvas");
              canvas.width = video.videoWidth || 300;
              canvas.height = video.videoHeight || 200;
              const ctx = canvas.getContext("2d");

              if (ctx) {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const dataUrl = canvas.toDataURL("image/jpeg");
                handleSuccess(dataUrl);
              } else {
                console.error(`Failed to get canvas context for ${file.name}`);
                handleError();
              }
            } catch (error) {
              console.error(`Failed to generate thumbnail for ${file.name}:`, error);
              handleError();
            }
          };
        } catch (error) {
          console.error(`Failed to seek video for ${file.name}:`, error);
          handleError();
        }
      };

      video.onerror = (error) => {
        console.warn(`Video load error for ${file.name}:`, error);
        handleError();
      };
    } catch (error) {
      console.error(`Thumbnail generation error for ${file.name}:`, error);
      handleError();
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    file.arionHash,
    file.name,
    file.isFolder,
    fileType,
    inView,
    thumbnailUrl,
    thumbnailError,
    loadAttempts,
    isLoadingThumbnail
  ]);

  // Images come from the shared thumbnailer (local + cloud); videos from the
  // canvas grab above. One pair of display vars so the render stays uniform.
  const displayUrl = isImageType ? imageThumb.url : thumbnailUrl;
  const displayLoading = isImageType ? imageThumb.isLoading : isLoadingThumbnail;
  // `thumbnailError` also covers an <Image> onError for a resolved image URL.
  const displayFailed = isImageType
    ? !!imageThumb.error || thumbnailError
    : thumbnailError;

  return (
    <div
      ref={cardRef}
      className={cn(
        "w-full relative border rounded-[5px] overflow-hidden h-[220px] flex flex-col transition-all duration-200",
        // Folder containers use a subtle grey/dark background; files stay white/black-500.
        file.isFolder
          ? "bg-grey-light-300 dark:bg-black-primary-bg"
          : "bg-white dark:bg-black-500",
        state === "pending" && "animate-pulse",
        state === "error" && "bg-red-200/20 border-red-300",
        // Selection mode styles
        isSelectionMode && file.isAssigned && "cursor-pointer hover:scale-[1.02]",
        isSelectionMode && file.isAssigned && isFileSelected(file) && "border-2 border-primary-50 bg-primary-90/10 shadow-lg",
        isSelectionMode && file.isAssigned && !isFileSelected(file) && "border-grey-dark-100 dark:border-black-300 hover:border-primary-50",
        // Disabled file styles
        isSelectionMode && !file.isAssigned && "opacity-50 cursor-not-allowed bg-grey-95 border-grey-90",
        // Normal mode styles
        !isSelectionMode && "border-grey-dark-100 dark:border-black-300 cursor-pointer"
      )}
      onClick={() => {
        if (isSelectionMode) {
          // In selection mode, clicking anywhere should toggle selection only if file can be deleted
          if (file.isAssigned) {
            toggleFileSelection(file);
          }
        } else {
          // Normal mode behavior
          onClick();
        }
      }}
    >
      <div className="px-2 pt-2 pb-1 flex items-center justify-between relative gap-1 h-9 w-full shrink-0">
        {file.isFolder ? (
          <div className="flex items-center min-w-0 flex-1">
            {/* Selection checkbox - inline with filename */}
            {isSelectionMode && (
              <Checkbox.Root
                className="h-4 w-4 rounded border border-grey-70 flex items-center justify-center bg-white data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 transition-colors mr-2 flex-shrink-0"
                checked={isFileSelected(file)}
                onCheckedChange={() => toggleFileSelection(file)}
                onClick={(e) => e.stopPropagation()}
              >
                <Checkbox.Indicator>
                  <Check className="h-3 w-3 text-white" />
                </Checkbox.Indicator>
              </Checkbox.Root>
            )}
            <Icon className={cn("size-5 mr-1 flex-shrink-0", color)} />
            {isSelectionMode ? (
              <span
                className={cn(
                  "text-sm text-grey-20 dark:text-grey-light-100 hover:text-primary-40 transition truncate cursor-pointer"
                )}
              >
                {displayName}
              </span>
            ) : (
              <Link href={`/files?folderCid=${file.arionHash}&folderName=${encodeURIComponent(file.name)}&folderActualName=${encodeURIComponent(file.actualFileName ?? "")}&mainFolderCid=${encodeURIComponent(newMainFolderHash)}&mainFolderActualName=${encodeURIComponent(newMainFolder)}&subFolderPath=${encodeURIComponent(newSubFolderPath)}&folderSource=${file.source}&mainReqHash=${file.mainReqHash}`} draggable={false}>
                <span
                  className={cn(
                    "text-sm text-grey-20 dark:text-grey-light-100 hover:text-primary-40 transition truncate"
                  )}
                >
                  {displayName}
                </span>
              </Link>
            )}
          </div>
        ) : (
          <div className="flex items-center min-w-0 flex-1">
            {/* Selection checkbox - inline with filename */}
            {isSelectionMode && (
              <Checkbox.Root
                className="h-4 w-4 rounded border border-grey-70 flex items-center justify-center bg-white data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 transition-colors mr-2 flex-shrink-0"
                checked={isFileSelected(file)}
                onCheckedChange={() => toggleFileSelection(file)}
                onClick={(e) => e.stopPropagation()}
              >
                <Checkbox.Indicator>
                  <Check className="h-3 w-3 text-white" />
                </Checkbox.Indicator>
              </Checkbox.Root>
            )}
            <Icon className={cn("size-5 mr-1 flex-shrink-0", color)} />
            <span className="text-sm text-grey-20 dark:text-grey-light-100 truncate">{displayName}</span>
            <SharedLinkBadge
              label={file.label}
              actualName={file.actualFileName}
              isFolder={file.isFolder}
              className="ml-1.5"
            />
          </div>
        )}
        <div className="flex-shrink-0 ml-1">{actionMenu}</div>
      </div>

      <div
        className={cn(
          "flex flex-1 min-h-0 items-center justify-center relative border-t border-grey-dark-100 dark:border-black-300 cursor-pointer overflow-hidden",
          file.isFolder
            ? "bg-grey-light-300 dark:bg-black-primary-bg"
            : "bg-white dark:bg-black-500"
        )}
      >
        {shouldLoadThumbnail && displayUrl && !displayFailed ? (
          <div className="relative w-full h-full">
            <Image
              src={displayUrl}
              alt={fileName}
              fill
              className="object-cover"
              onError={() => setThumbnailError(true)}
            />
            {fileType === "video" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 hover:bg-black/60 transition-colors">
                <div className="flex items-center justify-center rounded-full bg-black/50 p-2">
                  <Play className="size-4 text-white fill-white" />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center p-4 h-full w-full">
            {shouldLoadThumbnail && displayLoading ? (
              <div className="flex flex-col items-center justify-center space-y-2">
                <Loader2 className="h-8 w-8 animate-spin text-primary-50" />
                <span className="text-xs text-gray-500">
                  Loading preview...
                </span>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full w-full">
                <div className="flex items-center sm:justify-center h-[3.5rem] w-[3.5rem] relative">
                  {file.isFolder ? (
                    <Folder2 className="size-10 text-primary-50" />
                  ) : (
                    <div className="flex items-center justify-center size-9 bg-primary-50 rounded-[0.5rem] relative">
                      <FileTypeIcon
                        fileType={fileType ?? undefined}
                        file={file}
                        size="md"
                        className="text-grey-100"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div >
  );
};

export default React.memo(FileCard);
