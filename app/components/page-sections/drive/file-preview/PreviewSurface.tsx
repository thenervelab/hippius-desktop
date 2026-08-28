"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Padding between the viewer chrome and the preview content. Every renderer
 * uses the same inset so the canvas does not shift as the user steps between
 * files of different types with the arrow keys or the thumbnail rail.
 */
export const PREVIEW_INSET_CLASS = "px-4 pb-4 pt-2";

/**
 * The "sheet of paper" card used by text-like previews (plain text, JSON,
 * Markdown, spreadsheets). Content with its own native page colour — Word
 * pages, slides — sits directly on the surface instead.
 */
export const PREVIEW_CARD_CLASS = cn(
  "rounded-[8px] border border-grey-dark-100 bg-white",
  "shadow-[0_14px_31px_rgba(0,0,0,0.06),0_56px_56px_rgba(0,0,0,0.05)]",
  "dark:border-black-300 dark:bg-black-primary-bg",
);

/**
 * The one theme-aware canvas every preview body renders into.
 *
 * `FileViewerLayout` already paints the frosted app background, so the surface
 * itself is transparent and only owns the box model. Renderers must not
 * introduce their own shell — that is exactly the per-type drift this replaces.
 */
export default function PreviewSurface({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Fills the surface with the standard inset applied. A flex column, so
 * children fill it with `flex-1 min-h-0`.
 */
export function PreviewPane({
  children,
  className,
  scroll = false,
}: {
  children: ReactNode;
  className?: string;
  /** Let the pane scroll (documents) instead of clipping (grids). */
  scroll?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-0 w-full flex-1 flex-col",
        scroll ? "overflow-auto" : "overflow-hidden",
        PREVIEW_INSET_CLASS,
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A themed document card that fills its pane. */
export function PreviewCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 w-full flex-1 flex-col overflow-hidden animate-scale-in-95-0.4",
        PREVIEW_CARD_CLASS,
        className,
      )}
    >
      {children}
    </div>
  );
}
