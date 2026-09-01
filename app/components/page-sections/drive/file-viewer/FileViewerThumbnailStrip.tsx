"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
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

/** Flex gap between cells — must match the container's `gap-[13px]`. */
const CELL_GAP = 13;

/** Extra pixels of cells kept mounted beyond each edge of the viewport. */
const OVERSCAN_PX = 600;

/**
 * Viewport width assumed until the strip has been measured (first paint and
 * non-layout test environments). Wide enough that the initial window always
 * covers a real screen.
 */
const FALLBACK_VIEWPORT_PX = 1600;

const fileKey = (f: FormattedUserFile) =>
  f.actualFileName ?? `${f.arionHash}:${f.name}`;

const isImageFile = (f: FormattedUserFile): boolean => {
  const { fileFormat } = getFilePartsFromFileName(f.name);
  return getFileTypeFromExtension(fileFormat || null) === "image";
};

const cellWidth = (f: FormattedUserFile): number =>
  isImageFile(f) ? IMAGE_THUMB_WIDTH : NON_IMAGE_THUMB_WIDTH;

/**
 * Left x-offset of every cell inside the row, gap included after each cell
 * (`offsets[i]` = cell i's left edge; `offsets[length] - CELL_GAP` = the
 * row's total width). Real geometry is needed because image and non-image
 * cells differ in width.
 */
function buildOffsets(files: FormattedUserFile[]): number[] {
  const offsets = new Array<number>(files.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < files.length; i++) {
    offsets[i + 1] = offsets[i] + cellWidth(files[i]) + CELL_GAP;
  }
  return offsets;
}

/** Index of the last offset at or below `x` (binary search; offsets ascend). */
function lastIndexAtOrBelow(offsets: number[], x: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The filmstrip is virtualised, mirroring `SpreadsheetGrid`'s row
 * virtualisation: the viewer's file list is the FULL folder listing (not the
 * page's scroll window), and mapping it whole mounted a cell — a button, an
 * IntersectionObserver, and an image resolution — per file, freezing the
 * WebView the moment a photo in a 13,089-file camera folder was opened
 * (support ticket 142). Spacer divs stand in for the unmounted ranges, so
 * the scrollbar still spans the whole folder and dragging it anywhere
 * mounts the cells under it; selecting a file re-centers the scroll.
 */
const FileViewerThumbnailStrip: React.FC<FileViewerThumbnailStripProps> = ({
  files,
  currentFile,
  onSelect,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentKey = fileKey(currentFile);

  const offsets = useMemo(() => buildOffsets(files), [files]);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT_PX);
  const [scrollLeft, setScrollLeft] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setViewport(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const activeIndex = useMemo(
    () => files.findIndex((f) => fileKey(f) === currentKey),
    [files, currentKey],
  );

  // Center the active cell when it changes. Setting `scrollLeft` state (not
  // just the DOM scroll) mounts the cell in the same render, before any
  // scroll event fires. Geometry comes through a ref so a refetch that
  // leaves the active index unchanged never scroll-jacks the strip; an
  // active file missing from the list (-1) keeps the position and loses
  // only the highlight.
  const geometry = useRef({ offsets, viewport, files });
  geometry.current = { offsets, viewport, files };
  useEffect(() => {
    const { offsets, viewport, files } = geometry.current;
    if (activeIndex < 0 || activeIndex >= files.length) return;
    const target = Math.max(
      0,
      offsets[activeIndex] - (viewport - cellWidth(files[activeIndex])) / 2,
    );
    setScrollLeft(target);
    scrollRef.current?.scrollTo?.({ left: target, behavior: "smooth" });
  }, [activeIndex]);

  // rAF-throttled scroll tracking: one state update per frame at most.
  const frame = useRef(0);
  const handleScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setScrollLeft(scrollRef.current?.scrollLeft ?? 0);
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const [start, end] = useMemo(() => {
    const from = lastIndexAtOrBelow(offsets, Math.max(0, scrollLeft - OVERSCAN_PX));
    const to = Math.min(
      files.length,
      lastIndexAtOrBelow(offsets, scrollLeft + viewport + OVERSCAN_PX) + 1,
    );
    return [Math.min(from, to), to];
  }, [offsets, files.length, scrollLeft, viewport]);

  if (files.length === 0) return null;

  const totalWidth = offsets[files.length] - CELL_GAP;
  // The spacers join the flex row, so each absorbs one CELL_GAP the row
  // inserts around it; cell `start` must land exactly at `offsets[start]`.
  const leadingSpacer = start > 0 ? offsets[start] - CELL_GAP : 0;
  const trailingSpacer = end < files.length ? Math.max(0, totalWidth - offsets[end]) : 0;

  return (
    // Padding lives INSIDE the scroll container — overflow-x:auto coerces
    // overflow-y from visible to auto/clip per the CSS spec, which would
    // otherwise crop the active thumbnail's ring on top/bottom and crop
    // the first/last thumbnail's ring at the scroll-area's start/end edge.
    <div className="shrink-0 pb-[11px]">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
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
        {leadingSpacer > 0 && (
          <div
            aria-hidden
            data-testid="strip-leading-spacer"
            className="shrink-0"
            style={{ width: leadingSpacer }}
          />
        )}
        {files.slice(start, end).map((f) => (
          <StripThumbnail
            key={fileKey(f)}
            file={f}
            isActive={fileKey(f) === currentKey}
            onSelect={onSelect}
          />
        ))}
        {trailingSpacer > 0 && (
          <div
            aria-hidden
            data-testid="strip-trailing-spacer"
            className="shrink-0"
            style={{ width: trailingSpacer }}
          />
        )}
      </div>
    </div>
  );
};

/**
 * One filmstrip cell. Resolves its image thumbnail through {@link useThumbnail}
 * so cloud-only images (other devices / unsynced folders) render here too — the
 * resolution is gated on {@link useInView} so scrolling the strip doesn't fetch
 * every off-screen file at once. Non-images (and unresolved cloud thumbs) show
 * the file-type icon.
 */
const StripThumbnail: React.FC<{
  file: FormattedUserFile;
  isActive: boolean;
  onSelect: (file: FormattedUserFile) => void;
}> = ({ file, isActive, onSelect }) => {
  const { fileFormat } = getFilePartsFromFileName(file.name);
  const fileType = getFileTypeFromExtension(fileFormat || null);
  const isImage = fileType === "image";
  const { icon: Icon, color: iconColor } = getFileIcon(fileType || undefined, false);
  const width = isImage ? IMAGE_THUMB_WIDTH : NON_IMAGE_THUMB_WIDTH;

  const [inViewRef, inView] = useInView<HTMLButtonElement>();
  const thumb = useThumbnail(isImage ? file : null, { enabled: inView, maxDim: 160 });

  return (
    <button
      ref={inViewRef}
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
