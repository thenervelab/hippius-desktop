import React, { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { cn } from "@/lib/utils";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { FileTypeIcon } from "@/components/ui";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
// import { Graphsheet } from "@/components/ui";
import { Loader2, PlayCircle } from "lucide-react";
import Link from "next/link";
import {
  formatDisplayName,
  getFileIcon,
} from "@/lib/utils/fileTypeUtils";
import { Folder2 } from "@/components/ui/icons";
import { toBlobUrl } from "@/app/components/page-sections/files/files-table/VideoPlayer";
import { useUrlParams } from '@/app/utils/hooks/useUrlParams';
import { getFileUrlAndSourceSync } from "@/app/lib/utils/ipfsUrlResolver";
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
  actionMenu
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
  const displayName = formatDisplayName(file.name);
  const { icon: Icon, color } = getFileIcon(fileType ?? undefined, !!file.isFolder);

  const { getParam } = useUrlParams();

  // Get current path information for folder navigation
  const folderActualName = file.isFolder ? file.actualFileName || "" : "";
  const mainFolderCid = getParam("mainFolderCid", "");
  const mainFolderActualName = getParam("mainFolderActualName", folderActualName);
  const subFolderPath = getParam("subFolderPath", "");
  const effectiveMainFolderCid = mainFolderCid || file.cid;
  const effectiveMainFolderActualName = mainFolderActualName || folderActualName;

  // Build the folder path for navigation
  const { mainFolderCid: newMainFolderCID, mainFolderActualName: newMainFolder, subFolderPath: newSubFolderPath } = buildFolderPath(
    folderActualName,
    effectiveMainFolderCid,
    effectiveMainFolderActualName,
    subFolderPath
  );

  // Reset thumbnail state when file changes
  useEffect(() => {
    // Generate a unique ID for this file to track changes
    const currentFileId = `${file.cid}-${file.name}`;

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
  }, [file.cid, file.name]);

  useEffect(() => {
    // Only attempt to load thumbnails for image and video files
    // and make sure we're not already loading or have a thumbnail
    if (
      !shouldLoadThumbnail ||
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

    (async () => {
      try {
        const { url: cidUrl, isFromIpfs, isFromLocal } = getFileUrlAndSourceSync(file);
        let finalUrl = cidUrl;

        if (fileType === "image") {
          const img = document.createElement("img");
          img.onload = () => handleSuccess(finalUrl);
          img.onerror = handleError;
          img.src = finalUrl;

          timeoutRef.current = setTimeout(handleError, 10000);
        } else if (fileType === "video") {
          timeoutRef.current = setTimeout(handleError, 15000);

          if (!isFromIpfs && !isFromLocal) {
            try {
              const blobUrl = await toBlobUrl(finalUrl);
              finalUrl = blobUrl;
            } catch (error) {
              console.error(
                `Failed to create blob URL for ${file.name}:`,
                error
              );
              handleError();
              return;
            }
          }

          const video = document.createElement("video");
          if (!isFromLocal) {
            video.crossOrigin = "anonymous";
          }
          video.src = finalUrl || cidUrl;
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
                    console.error(
                      `Failed to get canvas context for ${file.name}`
                    );
                    handleError();
                  }
                } catch (error) {
                  console.error(
                    `Failed to generate thumbnail for ${file.name}:`,
                    error
                  );
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
        } else {
          handleError();
        }
      } catch (error) {
        console.error(`Thumbnail generation error for ${file.name}:`, error);
        handleError();
      }
    })();

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    file.cid,
    file.name,
    file.isFolder,
    fileType,
    shouldLoadThumbnail,
    thumbnailUrl,
    thumbnailError,
    loadAttempts,
    isLoadingThumbnail
  ]);

  return (
    <div
      className={cn(
        "w-full relative border rounded-lg overflow-hidden aspect-[4/3] transition-all duration-200",
        state === "pending" && "animate-pulse",
        state === "error" && "bg-red-200/20 border-red-300",
        // Selection mode styles
        isSelectionMode && file.isAssigned && "cursor-pointer hover:scale-[1.02]",
        isSelectionMode && file.isAssigned && isFileSelected(file) && "border-2 border-primary-50 bg-primary-90/10 shadow-lg",
        isSelectionMode && file.isAssigned && !isFileSelected(file) && "border-grey-80 hover:border-primary-50",
        // Disabled file styles
        isSelectionMode && !file.isAssigned && "opacity-50 cursor-not-allowed bg-grey-95 border-grey-90",
        // Normal mode styles
        !isSelectionMode && "border-grey-80 cursor-pointer"
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
      {!file.isFolder && (
        <Image
          src="/assets/file-card-gridlines.png"
          alt="File Card Gridlines"
          fill
          className="object-cover"
        />
      )}

      <div className="p-2 flex items-center justify-between relative bg-white bg-opacity-80 border-b border-grey-80 h-10 w-full">
        {file.isFolder ? (
          <div className="flex items-center">
            {/* Selection checkbox - inline with filename */}
            {isSelectionMode && (
              <Checkbox.Root
                className="h-4 w-4 rounded border border-grey-70 flex items-center justify-center bg-white data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 transition-colors mr-2"
                checked={isFileSelected(file)}
                onCheckedChange={() => toggleFileSelection(file)}
                onClick={(e) => e.stopPropagation()}
              >
                <Checkbox.Indicator>
                  <Check className="h-3 w-3 text-white" />
                </Checkbox.Indicator>
              </Checkbox.Root>
            )}
            <Icon className={cn("size-5 mr-1", color)} />
            {isSelectionMode ? (
              <span
                className={cn(
                  "text-sm text-grey-20 hover:text-primary-40 transition truncate cursor-pointer"
                )}
              >
                {displayName}
              </span>
            ) : (
              <Link href={`/files?folderCid=${decodeHexCid(file.cid)}&folderName=${encodeURIComponent(file.name)}&folderActualName=${encodeURIComponent(file.actualFileName ?? "")}&mainFolderCid=${encodeURIComponent(newMainFolderCID)}&mainFolderActualName=${encodeURIComponent(newMainFolder)}&subFolderPath=${encodeURIComponent(newSubFolderPath)}&folderSource=${file.source}&mainReqHash=${file.mainReqHash}`} draggable={false}>
                <span
                  className={cn(
                    "text-sm text-grey-20 hover:text-primary-40 transition truncate"
                  )}
                >
                  {displayName}
                </span>
              </Link>
            )}
          </div>
        ) : (
          <div className="flex items-center">
            {/* Selection checkbox - inline with filename */}
            {isSelectionMode && (
              <Checkbox.Root
                className="h-4 w-4 rounded border border-grey-70 flex items-center justify-center bg-white data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 transition-colors mr-2"
                checked={isFileSelected(file)}
                onCheckedChange={() => toggleFileSelection(file)}
                onClick={(e) => e.stopPropagation()}
              >
                <Checkbox.Indicator>
                  <Check className="h-3 w-3 text-white" />
                </Checkbox.Indicator>
              </Checkbox.Root>
            )}
            <Icon className={cn("size-5 mr-1", color)} />
            <span className="text-sm text-grey-20 truncate">{displayName}</span>
          </div>
        )}
        <div className="max-w-[20px] pr-8">{actionMenu}</div>
      </div>

      <div
        className={cn(
          "flex items-center justify-center relative h-[calc(100%-40px)]",
          isSelectionMode ? "cursor-pointer" : "cursor-pointer"
        )}
      >
        {shouldLoadThumbnail && thumbnailUrl && !thumbnailError ? (
          <div className="relative w-full h-full">
            <Image
              src={thumbnailUrl}
              alt={fileName}
              fill
              className="object-cover"
              onError={() => setThumbnailError(true)}
            />
            {fileType === "video" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-20 hover:bg-opacity-30 transition-all">
                <PlayCircle className="size-12 text-white opacity-80 hover:opacity-100" />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center p-4 h-full w-full">
            {shouldLoadThumbnail && isLoadingThumbnail ? (
              <div className="flex flex-col items-center justify-center space-y-2">
                <Loader2 className="h-8 w-8 animate-spin text-primary-50" />
                <span className="text-xs text-gray-500">
                  Loading preview...
                </span>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full w-full">
                {file.isFolder && (
                  <Image
                    src="/assets/file-card-small-gridlines.png"
                    alt="File Card Gridlines"
                    fill
                    className="object-center object-contain"
                  />
                )}
                <div className="flex items-center sm:justify-center h-[56px] w-[56px] relative">
                  {file.isFolder ? (
                    <Folder2 className="size-10 text-primary-50" />
                  ) : (
                    <div className="flex items-center justify-center size-9 bg-primary-50 rounded-[8px] relative">
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

export default FileCard;
