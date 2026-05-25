"use client";

import React, { useEffect, useRef } from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { getFileIcon } from "@/app/lib/utils/fileTypeUtils";
import { cn } from "@/app/lib/utils";

interface FileViewerThumbnailStripProps {
  files: FormattedUserFile[];
  currentFile: FormattedUserFile;
  onSelect: (file: FormattedUserFile) => void;
}

const THUMB_HEIGHT = 82;
const IMAGE_THUMB_WIDTH = 135;
const NON_IMAGE_THUMB_WIDTH = 92;

const fileKey = (f: FormattedUserFile) =>
  f.actualFileName ?? `${f.arionHash}:${f.name}`;

const FileViewerThumbnailStrip: React.FC<FileViewerThumbnailStripProps> = ({
  files,
  currentFile,
  onSelect,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const currentKey = fileKey(currentFile);

  // Scroll the active thumbnail into view whenever it changes.
  useEffect(() => {
    if (!activeRef.current) return;
    activeRef.current.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [currentKey]);

  if (files.length === 0) return null;

  return (
    // Padding lives INSIDE the scroll container — overflow-x:auto coerces
    // overflow-y from visible to auto/clip per the CSS spec, which would
    // otherwise crop the active thumbnail's ring on top/bottom and crop
    // the first/last thumbnail's ring at the scroll-area's start/end edge.
    <div className="shrink-0 pb-[11px]">
      <div
        ref={scrollRef}
        className={cn(
          "flex items-center gap-[13px] overflow-x-auto",
          // `safe center` centers the row when its content fits, but
          // falls back to flex-start when the row overflows so the
          // first thumbnail stays reachable via scroll.
          "[justify-content:safe_center]",
          "custom-scrollbar-thin",
          "py-[8px] px-[15px]",
        )}
      >
        {files.map((f) => {
          const isActive = fileKey(f) === currentKey;
          const { fileFormat } = getFilePartsFromFileName(f.name);
          const fileType = getFileTypeFromExtension(fileFormat || null);
          const isImage = fileType === "image";
          const url = isImage ? getFileUrl(f).url : "";
          const { icon: Icon, color: iconColor } = getFileIcon(
            fileType || undefined,
            false,
          );
          const width = isImage ? IMAGE_THUMB_WIDTH : NON_IMAGE_THUMB_WIDTH;

          return (
            <button
              key={fileKey(f)}
              ref={isActive ? activeRef : null}
              type="button"
              onClick={() => onSelect(f)}
              title={f.name}
              aria-label={`Open ${f.name}`}
              aria-current={isActive ? "true" : undefined}
              style={{ width, height: THUMB_HEIGHT }}
              className={cn(
                "relative shrink-0 overflow-hidden rounded-[9px]",
                "transition-opacity duration-150",
                isActive ? "opacity-100" : "opacity-40 hover:opacity-100",
                // Active ring for stronger affordance — Figma shows the
                // current thumb at full opacity with no ring, but a subtle
                // ring is needed for accessibility when neighbour thumbs
                // are close to opacity-100 (e.g. high-contrast pictures).
                isActive &&
                  "ring-1 ring-primary-50 ring-offset-1 ring-offset-transparent",
              )}
            >
              {isImage && url ? (
                <img
                  src={url}
                  alt=""
                  className="absolute inset-0 size-full object-cover"
                  loading="lazy"
                  draggable={false}
                />
              ) : (
                <div
                  className={cn(
                    "absolute inset-0 flex items-center justify-center",
                    "bg-grey-light-300 border-t border-grey-dark-100",
                    "dark:bg-black-600 dark:border-black-300",
                  )}
                >
                  <Icon className={cn("size-[28px]", iconColor)} />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default FileViewerThumbnailStrip;
