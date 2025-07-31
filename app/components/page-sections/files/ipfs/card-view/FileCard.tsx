import React, { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { cn } from "@/lib/utils";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { FileTypeIcon } from "@/components/ui";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { Graphsheet } from "@/components/ui";
import { Loader2, PlayCircle } from "lucide-react";
import Link from "next/link";
import {
  formatDisplayName,
  getFileIcon,
  isDirectory
} from "@/lib/utils/fileTypeUtils";
import { EC } from "@/components/ui/icons";
import { convertFileSrc } from "@tauri-apps/api/core";
import { toBlobUrl } from "../files-table/VideoPlayer";

interface FileCardProps {
  file: FormattedUserIpfsFile;
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
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [thumbnailError, setThumbnailError] = useState(false);
  const [isLoadingThumbnail, setIsLoadingThumbnail] = useState(false);
  const [loadAttempts, setLoadAttempts] = useState(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const fileType = getFileTypeFromExtension(fileFormat || null);
  const shouldLoadThumbnail = fileType === "image" || fileType === "video";
  const isDir = isDirectory(file.name);
  const displayName = formatDisplayName(file.name);
  const { icon: Icon, color } = getFileIcon(fileType ?? undefined, isDir);

  useEffect(() => {
    if (
      thumbnailUrl ||
      thumbnailError ||
      !shouldLoadThumbnail ||
      loadAttempts >= 2 ||
      isLoadingThumbnail
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
        const isHippius = file.source === "Hippius";
        const normalised = file.source?.replace(/\\/g, "/");
        let cidUrl = isHippius
          ? `https://get.hippius.network/ipfs/${decodeHexCid(file.cid)}`
          : convertFileSrc(normalised ?? "");

        if (fileType === "image") {
          const img = document.createElement("img");
          img.onload = () => handleSuccess(cidUrl);
          img.onerror = handleError;
          img.src = cidUrl;

          timeoutRef.current = setTimeout(handleError, 10000);
        } else if (fileType === "video") {
          timeoutRef.current = setTimeout(handleError, 15000);

          if (!isHippius) {
            try {
              const blobUrl = await toBlobUrl(cidUrl);
              cidUrl = blobUrl;
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
          video.crossOrigin = "anonymous";
          video.src = cidUrl;
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
  }, [
    file.cid,
    file.name,
    file.source,
    fileType,
    thumbnailUrl,
    thumbnailError,
    loadAttempts,
    shouldLoadThumbnail,
    isLoadingThumbnail
  ]);

  return (
    <div
      className={cn(
        "w-full relative border border-grey-80 rounded-lg overflow-hidden aspect-[4/3]",
        state === "pending" && "animate-pulse",
        state === "error" && "bg-red-200/20 border-red-300"
      )}
    >
      {!isDir && (
        <Graphsheet
          majorCell={{
            lineColor: [31, 80, 189, 1.0],
            lineWidth: 2,
            cellDim: 50
          }}
          minorCell={{
            lineColor: [255, 255, 255, 1.0],
            lineWidth: 0,
            cellDim: 0
          }}
          className="absolute w-full h-full left-0 opacity-10"
        />
      )}

      <div className="p-2 flex items-center justify-between relative bg-white bg-opacity-80 border-b border-grey-80 h-[40px] w-full">
        {isDir ? (
          <Link href={`/dashboard/storage/ipfs/${decodeHexCid(file.cid)}`}>
            <div className="flex items-center">
              <Icon className={cn("size-5 mr-1", color)} />
              <span
                className={cn(
                  "text-sm text-grey-20 hover:text-primary-40 transition truncate"
                )}
              >
                {displayName}
              </span>
            </div>
          </Link>
        ) : (
          <div className="flex items-center">
            <Icon className={cn("size-5 mr-1", color)} />
            <span className="text-sm text-grey-20 truncate">{displayName}</span>
          </div>
        )}
        <div className="max-w-[20px] pr-8">{actionMenu}</div>
      </div>

      <div
        className="flex items-center justify-center cursor-pointer relative h-[calc(100%-40px)]"
        onClick={onClick}
      >
        {thumbnailUrl && !thumbnailError ? (
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
            {isLoadingThumbnail && shouldLoadThumbnail ? (
              <div className="flex flex-col items-center justify-center space-y-2">
                <Loader2 className="h-8 w-8 animate-spin text-primary-50" />
                <span className="text-xs text-gray-500">
                  Loading preview...
                </span>
              </div>
            ) : (
              <div className="flex items-center sm:justify-center h-[56px] w-[56px] relative">
                {isDir ? (
                  <>
                    <Graphsheet
                      majorCell={{
                        lineColor: [31, 80, 189, 1],
                        lineWidth: 2,
                        cellDim: 40
                      }}
                      minorCell={{
                        lineColor: [31, 80, 189, 1],
                        lineWidth: 2,
                        cellDim: 40
                      }}
                      className="absolute w-full h-full inset-0 duration-300 opacity-10"
                    />
                    <EC className="size-10 text-primary-50" />
                  </>
                ) : (
                  <div className="flex items-center justify-center size-9 bg-primary-50 rounded-[8px] relative">
                    <FileTypeIcon
                      fileType={fileType ?? undefined}
                      rawName={file.name}
                      cid={file.cid}
                      size="md"
                      className="text-grey-100"
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default FileCard;
