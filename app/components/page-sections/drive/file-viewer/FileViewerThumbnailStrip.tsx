"use client";

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

/**
 * Flex gap between cells and the container's horizontal padding. Both are
 * emitted as inline styles from THESE constants (never as Tailwind classes)
 * because the offset math below assumes them: a class edited without the
 * constant desyncs the geometry silently — at 13k files a 1px gap drift
 * misplaces cells by ~13,000px and the scrollbar stops corresponding to the
 * cells mounted under it, and no test catches it since jsdom does no layout.
 */
const CELL_GAP = 13;
const STRIP_PADDING_X = 15;

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
  const [scrollLeft, setScrollLeftState] = useState(0);

  // Mirrors the last scrollLeft committed to state, for the quantised
  // scroll tracker below.
  const storedScroll = useRef(0);

  // Measure BEFORE first paint: the state update lands in the same commit,
  // so the first centering pass below sees the real width instead of the
  // fallback (which mis-centered every viewer open in windows narrower than
  // the fallback, with nothing ever correcting it).
  useLayoutEffect(() => {
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

  // Center the active cell when the OPEN FILE changes (keyed on its
  // identity, not its index — a list swap can leave a different file at the
  // same index) and when the viewport is measured/resized. Setting
  // `scrollLeft` state (not just the DOM scroll) mounts the cell in the same
  // render, before any scroll event fires. The list geometry comes through a
  // ref so a refetch that keeps the same open file never scroll-jacks the
  // strip; an active file missing from the list keeps the position and
  // loses only the highlight. Far jumps scroll instantly — a smooth
  // animation from the far end would sweep a mount/unmount window across
  // the whole strip and cancel the active cell's own thumbnail job.
  const geometry = useRef({ offsets, files });
  geometry.current = { offsets, files };
  useEffect(() => {
    const { offsets, files } = geometry.current;
    const index = files.findIndex((f) => fileKey(f) === currentKey);
    if (index < 0) return;
    const target = Math.max(
      0,
      STRIP_PADDING_X + offsets[index] - (viewport - cellWidth(files[index])) / 2,
    );
    storedScroll.current = target;
    setScrollLeftState(target);
    const el = scrollRef.current;
    const distance = Math.abs((el?.scrollLeft ?? 0) - target);
    el?.scrollTo?.({ left: target, behavior: distance > viewport ? "auto" : "smooth" });
  }, [currentKey, viewport]);

  // rAF-throttled AND quantised scroll tracking: the window carries
  // OVERSCAN_PX of slack on each side, so state — and with it a re-render
  // of every mounted cell — only needs to move in coarse steps, not on
  // every frame of a scroll.
  const frame = useRef(0);
  const handleScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const next = scrollRef.current?.scrollLeft ?? 0;
      if (Math.abs(next - storedScroll.current) < OVERSCAN_PX / 3) return;
      storedScroll.current = next;
      setScrollLeftState(next);
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const [start, end] = useMemo(() => {
    const origin = Math.max(0, scrollLeft - STRIP_PADDING_X);
    const from = lastIndexAtOrBelow(offsets, Math.max(0, origin - OVERSCAN_PX));
    const to = Math.min(
      files.length,
      lastIndexAtOrBelow(offsets, origin + viewport + OVERSCAN_PX) + 1,
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
        data-testid="strip-scroll"
        className={cn(
          "flex items-center overflow-x-auto",
          // `safe center` centers the row when its content fits, but
          // falls back to flex-start when the row overflows so the
          // first thumbnail stays reachable via scroll.
          "[justify-content:safe_center]",
          "custom-scrollbar-thin",
          "py-[8px]",
        )}
        // Gap and horizontal padding come from the geometry constants — see
        // CELL_GAP / STRIP_PADDING_X.
        style={{ gap: CELL_GAP, paddingLeft: STRIP_PADDING_X, paddingRight: STRIP_PADDING_X }}
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
 *
 * Memoised: the quantised scroll tracker re-renders the parent on coarse
 * scroll steps, and ~20+ mounted cells re-running the filename/type/icon
 * derivation each time is exactly the per-frame work this strip exists to
 * avoid.
 */
const StripThumbnail = React.memo(function StripThumbnail({
  file,
  isActive,
  onSelect,
}: {
  file: FormattedUserFile;
  isActive: boolean;
  onSelect: (file: FormattedUserFile) => void;
}) {
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
});

export default FileViewerThumbnailStrip;
