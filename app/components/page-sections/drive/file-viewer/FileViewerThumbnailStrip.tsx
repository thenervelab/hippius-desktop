"use client";

import React, { useEffect, useRef } from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { getFileIcon } from "@/app/lib/utils/fileTypeUtils";
import { useThumbnail } from "@/app/lib/hooks/useThumbnail";
import { useInView } from "@/app/lib/hooks/useInView";
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
        {files.map((f) => (
          <StripThumbnail
            key={fileKey(f)}
            file={f}
            isActive={fileKey(f) === currentKey}
            activeRef={fileKey(f) === currentKey ? activeRef : undefined}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * One filmstrip cell. Resolves its image thumbnail through {@link useThumbnail}
 * so cloud-only images (other devices / unsynced folders) render here too — the
 * download is gated on {@link useInView} so scrolling the strip doesn't fetch
 * every off-screen file at once. Non-images (and unresolved cloud thumbs) show
 * the file-type icon.
 *
 * `activeRef` is the parent's scroll-into-view ref for the current item; it's
 * merged with the in-view observer ref onto the same button.
 */
const StripThumbnail: React.FC<{
  file: FormattedUserFile;
  isActive: boolean;
  activeRef?: React.RefObject<HTMLButtonElement | null>;
  onSelect: (file: FormattedUserFile) => void;
}> = ({ file, isActive, activeRef, onSelect }) => {
  const { fileFormat } = getFilePartsFromFileName(file.name);
  const fileType = getFileTypeFromExtension(fileFormat || null);
  const isImage = fileType === "image";
  const { icon: Icon, color: iconColor } = getFileIcon(fileType || undefined, false);
  const width = isImage ? IMAGE_THUMB_WIDTH : NON_IMAGE_THUMB_WIDTH;

  const [inViewRef, inView] = useInView<HTMLButtonElement>();
  const thumb = useThumbnail(isImage ? file : null, { enabled: inView, maxDim: 160 });

  // Merge the in-view observer ref with the parent's active-scroll ref.
  const setRefs = (el: HTMLButtonElement | null) => {
    inViewRef.current = el;
    if (activeRef) activeRef.current = el;
  };

  return (
    <button
      ref={setRefs}
      type="button"
      onClick={() => onSelect(file)}
      title={file.name}
      aria-label={`Open ${file.name}`}
      aria-current={isActive ? "true" : undefined}
      style={{ width, height: THUMB_HEIGHT }}
      className={cn(
        "relative shrink-0 overflow-hidden rounded-[9px]",
        "transition-opacity duration-150",
        isActive ? "opacity-100" : "opacity-40 hover:opacity-100",
        // Active ring for stronger affordance — Figma shows the current thumb at
        // full opacity with no ring, but a subtle ring is needed for
        // accessibility when neighbour thumbs are near opacity-100.
        isActive && "ring-1 ring-primary-50 ring-offset-1 ring-offset-transparent",
      )}
    >
      {isImage && thumb.url ? (
        <img
          src={thumb.url}
          alt=""
          className="absolute inset-0 size-full object-cover"
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
};

export default FileViewerThumbnailStrip;
