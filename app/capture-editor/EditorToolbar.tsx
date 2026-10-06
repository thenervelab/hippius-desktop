"use client";

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
  Trash2,
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

export const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50 focus-visible:ring-offset-1";
const ICON_BUTTON = `grid size-8 shrink-0 place-items-center rounded-[8px] text-grey-50 transition-colors hover:bg-grey-90 hover:text-grey-10 disabled:opacity-40 disabled:hover:bg-transparent dark:text-grey-70 dark:hover:bg-black-300 dark:hover:text-grey-100 motion-reduce:transition-none ${FOCUS}`;
const PRESSED = "bg-primary-90 text-primary-50 hover:bg-primary-90 hover:text-primary-50 dark:bg-primary-50/25 dark:text-primary-90 dark:hover:bg-primary-50/25 dark:hover:text-primary-90";
const DIVIDER = "mx-1 h-6 w-px shrink-0 bg-grey-80 dark:bg-black-300";

interface Props {
  tool: ToolId;
  onTool: (tool: ToolId) => void;
  color: string;
  onColor: (color: string) => void;
  size: SizeId;
  onSize: (size: SizeId) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  canDelete: boolean;
  onDelete: () => void;
  aspect: string;
  onAspect: (id: string) => void;
  hasCrop: boolean;
  onResetCrop: () => void;
  onApplyCrop: () => void;
  modKey: string;
}

/**
 * The tools, the colour and size, undo / redo, and while cropping the
 * shape presets. Every button is named for a screen reader with its key, and
 * the row wraps rather than scrolls when the window is narrow.
 */
export default function EditorToolbar(p: Props) {
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 border-b border-grey-80 bg-white px-3 py-2 dark:border-black-300 dark:bg-black-primary-bg">
      <div role="toolbar" aria-label="Tools" className="flex flex-wrap items-center gap-0.5">
        {TOOLS.map((t) => {
          const Icon = ICONS[t.id];
          const on = p.tool === t.id;
          return (
            <button
              key={t.id}
              type="button"
              aria-label={`${t.label} (${t.key})`}
              title={`${t.label} (${t.key})`}
              aria-pressed={on}
              onClick={() => p.onTool(t.id)}
              className={`${ICON_BUTTON} ${on ? PRESSED : ""}`}
            >
              <Icon aria-hidden className="size-[18px]" strokeWidth={2} />
            </button>
          );
        })}
      </div>
      <span className={DIVIDER} aria-hidden />

      {p.tool === "crop" ? (
        <div className="flex flex-wrap items-center gap-1">
          <div role="radiogroup" aria-label="Crop shape" className="flex items-center gap-0.5 rounded-[9px] bg-grey-90 p-0.5 dark:bg-black-300">
            {ASPECT_PRESETS.map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={p.aspect === a.id}
                onClick={() => p.onAspect(a.id)}
                className={`h-7 whitespace-nowrap rounded-[7px] px-2 text-[12px] font-medium ${FOCUS} ${
                  p.aspect === a.id
                    ? "bg-white text-grey-10 shadow-sm dark:bg-black-primary-bg dark:text-grey-100"
                    : "text-grey-50 hover:text-grey-10 dark:text-grey-70 dark:hover:text-grey-100"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
          <button type="button" onClick={p.onResetCrop} disabled={!p.hasCrop} className={`${ICON_BUTTON}`} aria-label="Reset crop" title="Reset crop">
            <RotateCcw aria-hidden className="size-4" />
          </button>
          <button
            type="button"
            onClick={p.onApplyCrop}
            className={`h-8 whitespace-nowrap rounded-[8px] bg-primary-50 px-3 text-[12px] font-medium text-white hover:bg-primary-60 ${FOCUS}`}
          >
            Done cropping
          </button>
        </div>
      ) : (
        <>
          <div role="radiogroup" aria-label="Colour" className="flex flex-wrap items-center gap-1">
            {PALETTE.map((c) => (
              <button
                key={c.color}
                type="button"
                role="radio"
                aria-checked={p.color === c.color}
                aria-label={c.name}
                title={c.name}
                onClick={() => p.onColor(c.color)}
                className={`grid size-7 place-items-center rounded-full ${FOCUS} ${
                  p.color === c.color ? "ring-2 ring-primary-50 ring-offset-1 ring-offset-white dark:ring-offset-black-primary-bg" : ""
                }`}
              >
                <span
                  aria-hidden
                  className="size-5 rounded-full border border-[#000]/15 dark:border-white/25"
                  style={{ backgroundColor: c.color }}
                />
              </button>
            ))}
          </div>
          <span className={DIVIDER} aria-hidden />
          <div role="radiogroup" aria-label="Size" className="flex items-center gap-0.5">
            {SIZES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={p.size === s.id}
                aria-label={s.label}
                title={s.label}
                onClick={() => p.onSize(s.id)}
                className={`${ICON_BUTTON} ${p.size === s.id ? PRESSED : ""}`}
              >
                <span aria-hidden className="block w-4 rounded-full bg-current" style={{ height: Math.max(2, s.stroke - 1) }} />
              </button>
            ))}
          </div>
        </>
      )}

      <div className="ml-auto flex items-center gap-0.5">
        <button type="button" onClick={p.onDelete} disabled={!p.canDelete} className={ICON_BUTTON} aria-label="Delete selected" title="Delete (Backspace)">
          <Trash2 aria-hidden className="size-4" />
        </button>
        <button type="button" onClick={p.onUndo} disabled={!p.canUndo} className={ICON_BUTTON} aria-label="Undo" title={`Undo (${p.modKey}Z)`}>
          <Undo2 aria-hidden className="size-4" />
        </button>
        <button type="button" onClick={p.onRedo} disabled={!p.canRedo} className={ICON_BUTTON} aria-label="Redo" title={`Redo (Shift ${p.modKey}Z)`}>
          <Redo2 aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  );
}
