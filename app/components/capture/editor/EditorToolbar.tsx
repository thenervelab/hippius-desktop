"use client";

import { useEffect, useRef } from "react";
import {
  ArrowUpRight,
  Circle,
  CircleDot,
  Crop,
  Droplets,
  Grid3x3,
  Highlighter,
  MousePointer2,
  Redo2,
  RotateCcw,
  Slash,
  Square,
  Type,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { ToolId } from "@/app/lib/capture/editor/model";
import { PALETTE, SIZES, type SizeId, TOOLS } from "@/app/lib/capture/editor/shortcuts";
import { ASPECT_PRESETS } from "@/app/lib/capture/editor/view";

const ICONS: Record<ToolId, LucideIcon> = {
  select: MousePointer2,
  crop: Crop,
  arrow: ArrowUpRight,
  line: Slash,
  rect: Square,
  ellipse: Circle,
  text: Type,
  highlight: Highlighter,
  step: CircleDot,
  blur: Droplets,
  pixelate: Grid3x3,
};

/**
 * The pill's groups, in the approved order: crop (with select, the hand
 * that moves what is drawn), then the drawing tools, then the redactions.
 * Every tool the editor has is here, so none is reachable by key alone.
 */
const GROUPS: ToolId[][] = [
  ["select", "crop"],
  ["arrow", "rect", "ellipse", "line", "text", "highlight", "step"],
  ["blur", "pixelate"],
];

/** Shared by every piece of the editor's dark chrome. */
export const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50 focus-visible:ring-offset-2 focus-visible:ring-offset-black-600";
export const PILL = "rounded-full border border-black-200 bg-black-primary-bg/95 shadow-[0_8px_24px_rgba(0,0,0,0.45)] backdrop-blur";
export const ICON_BUTTON = `grid size-8 shrink-0 place-items-center rounded-full text-grey-70 transition-colors hover:bg-black-300 hover:text-grey-100 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-grey-70 motion-reduce:transition-none ${FOCUS}`;
/** The active tool: filled with the brand blue. */
export const ACTIVE = "bg-primary-50 text-grey-100 hover:bg-primary-50 hover:text-grey-100";
const DIVIDER = "mx-1 h-5 w-px shrink-0 bg-black-200";

interface Props {
  tool: ToolId;
  onTool: (tool: ToolId) => void;
  color: string;
  size: SizeId;
  /** The colour panel is open (the dot's popover). */
  styleOpen: boolean;
  onStyleOpen: (open: boolean) => void;
  onColor: (color: string) => void;
  onSize: (size: SizeId) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  modKey: string;
}

/**
 * The one floating toolbar: the tools, a colour dot that opens the colour
 * and thickness choices, then undo and redo. Every button is named for a
 * screen reader with its key, and shows the same as a tooltip. On a narrow
 * window the pill scrolls sideways rather than wrapping into the picture.
 */
export default function EditorToolbar(p: Props) {
  const dot = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const colourName = PALETTE.find((c) => c.color === p.color)?.name ?? "Custom";

  // A press anywhere outside the panel and its dot closes it.
  const { styleOpen, onStyleOpen } = p;
  useEffect(() => {
    if (!styleOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && (panel.current?.contains(target) || dot.current?.contains(target))) return;
      onStyleOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [styleOpen, onStyleOpen]);

  return (
    <div className="relative max-w-full">
      <div role="toolbar" aria-label="Tools" className={`${PILL} flex max-w-full items-center gap-0.5 overflow-x-auto px-1.5 py-1 [scrollbar-width:none]`}>
        {GROUPS.map((group, i) => (
          <div key={group.join()} className="flex items-center gap-0.5">
            {i > 0 && <span className={DIVIDER} aria-hidden />}
            {group.map((id) => {
              const t = TOOLS.find((x) => x.id === id);
              if (!t) return null;
              const Icon = ICONS[id];
              const on = p.tool === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-label={`${t.label} (${t.key})`}
                  title={`${t.label} (${t.key})`}
                  aria-pressed={on}
                  onClick={() => p.onTool(id)}
                  className={`${ICON_BUTTON} ${on ? ACTIVE : ""}`}
                >
                  <Icon aria-hidden className="size-[17px]" strokeWidth={2} />
                </button>
              );
            })}
          </div>
        ))}
        <span className={DIVIDER} aria-hidden />
        <button
          ref={dot}
          type="button"
          aria-label={`Colour and thickness: ${colourName}`}
          title="Colour and thickness"
          aria-haspopup="dialog"
          aria-expanded={p.styleOpen}
          onClick={() => p.onStyleOpen(!p.styleOpen)}
          className={`${ICON_BUTTON} ${p.styleOpen ? "bg-black-300" : ""}`}
        >
          <span aria-hidden className="size-[18px] rounded-full border-2 border-grey-100/80" style={{ backgroundColor: p.color }} />
        </button>
        <span className={DIVIDER} aria-hidden />
        <button type="button" onClick={p.onUndo} disabled={!p.canUndo} className={ICON_BUTTON} aria-label="Undo" title={`Undo (${p.modKey}Z)`}>
          <Undo2 aria-hidden className="size-4" />
        </button>
        <button type="button" onClick={p.onRedo} disabled={!p.canRedo} className={ICON_BUTTON} aria-label="Redo" title={`Redo (Shift ${p.modKey}Z)`}>
          <Redo2 aria-hidden className="size-4" />
        </button>
      </div>

      {p.styleOpen && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Colour and thickness"
          className="absolute left-1/2 top-full z-10 mt-2 w-[min(17rem,calc(100vw-2rem))] -translate-x-1/2 rounded-[14px] border border-black-200 bg-black-primary-bg p-3 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
        >
          <ColourChoices color={p.color} onColor={p.onColor} />
          <div className="mt-3">
            <SizeChoices size={p.size} onSize={p.onSize} />
          </div>
        </div>
      )}
    </div>
  );
}

/** The palette as a labelled radio group. */
export function ColourChoices({ color, onColor, compact = false }: { color: string; onColor: (c: string) => void; compact?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Colour" className={`flex flex-wrap items-center ${compact ? "gap-0.5" : "gap-1.5"}`}>
      {PALETTE.map((c) => (
        <button
          key={c.color}
          type="button"
          role="radio"
          aria-checked={color === c.color}
          aria-label={c.name}
          title={c.name}
          onClick={() => onColor(c.color)}
          className={`grid ${compact ? "size-6" : "size-7"} place-items-center rounded-full ${FOCUS} ${
            color === c.color ? "ring-2 ring-primary-50 ring-offset-1 ring-offset-black-primary-bg" : ""
          }`}
        >
          <span aria-hidden className={`${compact ? "size-4" : "size-5"} rounded-full border border-grey-100/30`} style={{ backgroundColor: c.color }} />
        </button>
      ))}
    </div>
  );
}

/** Thin, medium, thick, as a labelled radio group. */
export function SizeChoices({ size, onSize }: { size: SizeId; onSize: (s: SizeId) => void }) {
  return (
    <div role="radiogroup" aria-label="Thickness" className="flex items-center gap-0.5">
      {SIZES.map((s) => (
        <button
          key={s.id}
          type="button"
          role="radio"
          aria-checked={size === s.id}
          aria-label={s.label}
          title={s.label}
          onClick={() => onSize(s.id)}
          className={`${ICON_BUTTON} ${size === s.id ? ACTIVE : ""}`}
        >
          <span aria-hidden className="block w-4 rounded-full bg-current" style={{ height: Math.max(2, s.stroke - 1) }} />
        </button>
      ))}
    </div>
  );
}

/** While cropping: the crop's shape, reset, and done. Sits under the pill. */
export function CropBar({
  aspect,
  onAspect,
  hasCrop,
  onReset,
  onDone,
}: {
  aspect: string;
  onAspect: (id: string) => void;
  hasCrop: boolean;
  onReset: () => void;
  onDone: () => void;
}) {
  return (
    <div className={`${PILL} flex max-w-full items-center gap-1 overflow-x-auto px-1.5 py-1 [scrollbar-width:none]`}>
      <div role="radiogroup" aria-label="Crop shape" className="flex items-center gap-0.5">
        {ASPECT_PRESETS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={aspect === a.id}
            onClick={() => onAspect(a.id)}
            className={`h-7 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium ${FOCUS} ${
              aspect === a.id ? "bg-black-300 text-grey-100" : "text-grey-70 hover:text-grey-100"
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>
      <button type="button" onClick={onReset} disabled={!hasCrop} className={ICON_BUTTON} aria-label="Reset crop" title="Reset crop">
        <RotateCcw aria-hidden className="size-4" />
      </button>
      <button
        type="button"
        onClick={onDone}
        className={`h-7 whitespace-nowrap rounded-full bg-primary-50 px-3 text-[12px] font-medium text-grey-100 hover:bg-primary-60 ${FOCUS}`}
      >
        Done cropping
      </button>
    </div>
  );
}
