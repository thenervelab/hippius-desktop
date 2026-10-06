"use client";

import { Minus, Plus, Trash2 } from "lucide-react";
import type { Annotation } from "@/app/lib/capture/editor/model";
import type { SizeId } from "@/app/lib/capture/editor/shortcuts";
import { ColourChoices, FOCUS, ICON_BUTTON, PILL, SizeChoices } from "./EditorToolbar";

/**
 * The small bar beside a selected annotation: its colour, its thickness
 * (text size for text and steps), and delete. A blur or pixelate has no
 * colour or thickness, so it shows delete alone.
 */
export function SelectionBar({
  annotation,
  color,
  size,
  onColor,
  onSize,
  onDelete,
}: {
  annotation: Annotation;
  color: string;
  size: SizeId;
  onColor: (c: string) => void;
  onSize: (s: SizeId) => void;
  onDelete: () => void;
}) {
  const styled = annotation.kind !== "blur" && annotation.kind !== "pixelate";
  return (
    <div role="toolbar" aria-label="Selected annotation" className={`${PILL} flex w-max max-w-[calc(100vw-2rem)] flex-wrap items-center justify-center gap-1 !rounded-[18px] px-1.5 py-1`}>
      {styled && (
        <>
          <ColourChoices color={color} onColor={onColor} compact />
          <span className="mx-0.5 h-5 w-px shrink-0 bg-black-200" aria-hidden />
          <SizeChoices size={size} onSize={onSize} />
          <span className="mx-0.5 h-5 w-px shrink-0 bg-black-200" aria-hidden />
        </>
      )}
      <button type="button" onClick={onDelete} className={ICON_BUTTON} aria-label="Delete" title="Delete (Backspace)">
        <Trash2 aria-hidden className="size-4" />
      </button>
    </div>
  );
}

/** "Fit · 64%" when fitted, "150%" when zoomed. */
export function zoomLabel(zoom: number, fitted: boolean): string {
  const percent = `${Math.round(zoom * 100)}%`;
  return fitted ? `Fit · ${percent}` : percent;
}

/**
 * The zoom pill under the picture: out, the zoom (press to fit), in. The
 * keys are the platform's zoom keys.
 */
export function ZoomPill({
  zoom,
  fitted,
  canZoomIn,
  canZoomOut,
  onZoomIn,
  onZoomOut,
  onFit,
  modKey,
}: {
  zoom: number;
  fitted: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  modKey: string;
}) {
  return (
    <div role="group" aria-label="Zoom" className={`${PILL} flex items-center gap-0.5 px-1 py-1`}>
      <button type="button" onClick={onZoomOut} disabled={!canZoomOut} className={ICON_BUTTON} aria-label="Zoom out" title={`Zoom out (${modKey}-)`}>
        <Minus aria-hidden className="size-4" />
      </button>
      <button
        type="button"
        onClick={onFit}
        aria-label={fitted ? `Zoom ${Math.round(zoom * 100)}%, fitted to the window` : `Zoom ${Math.round(zoom * 100)}%. Fit to the window`}
        title={`Fit to the window (${modKey}0)`}
        className={`h-8 min-w-[5.5rem] rounded-full px-2 text-[12px] font-medium tabular-nums text-grey-100 hover:bg-black-300 ${FOCUS}`}
      >
        {zoomLabel(zoom, fitted)}
      </button>
      <button type="button" onClick={onZoomIn} disabled={!canZoomIn} className={ICON_BUTTON} aria-label="Zoom in" title={`Zoom in (${modKey}+)`}>
        <Plus aria-hidden className="size-4" />
      </button>
    </div>
  );
}
