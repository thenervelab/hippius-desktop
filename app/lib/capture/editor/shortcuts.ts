import type { ToolId } from "./model";

/**
 * The editor's tools and keys. Letters follow CleanShot X's annotate tool
 * (V move, K crop, A arrow, L line, R rectangle, E ellipse, T text,
 * M highlighter, C counter, P pixelate), with B for blur. Undo, redo,
 * save and copy use the platform's own modifier.
 */

export interface ToolInfo {
  id: ToolId;
  label: string;
  key: string;
}

export const TOOLS: ToolInfo[] = [
  { id: "select", label: "Select and move", key: "V" },
  { id: "crop", label: "Crop", key: "K" },
  { id: "arrow", label: "Arrow", key: "A" },
  { id: "line", label: "Line", key: "L" },
  { id: "rect", label: "Rectangle", key: "R" },
  { id: "ellipse", label: "Ellipse", key: "E" },
  { id: "text", label: "Text", key: "T" },
  { id: "highlight", label: "Highlighter", key: "M" },
  { id: "step", label: "Numbered step", key: "C" },
  { id: "blur", label: "Blur", key: "B" },
  { id: "pixelate", label: "Pixelate", key: "P" },
];

export type Command =
  | { type: "tool"; tool: ToolId }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "save" }
  | { type: "copy" }
  | { type: "delete" }
  | { type: "escape" }
  | { type: "applyCrop" }
  | { type: "zoomIn" }
  | { type: "zoomOut" }
  | { type: "zoomFit" }
  | { type: "nudge"; dx: number; dy: number };

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * What a key press means, or null. `isMac` picks Command over Control.
 * A press inside a text field is never passed here (the caller checks).
 */
export function commandFor(e: KeyLike, isMac: boolean): Command | null {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod) {
    if (key === "z") return e.shiftKey ? { type: "redo" } : { type: "undo" };
    if (key === "y" && !isMac) return { type: "redo" };
    if (key === "s") return { type: "save" };
    // Shift+Cmd+C is CleanShot's "copy screenshot"; plain Cmd+C does the same
    // here, since there is no object clipboard.
    if (key === "c") return { type: "copy" };
    // The browser's zoom keys: "=" is "+" without Shift on most layouts.
    if (key === "=" || key === "+") return { type: "zoomIn" };
    if (key === "-" || key === "_") return { type: "zoomOut" };
    if (key === "0") return { type: "zoomFit" };
    return null;
  }
  if (e.altKey) return null;
  if (key === "Backspace" || key === "Delete") return { type: "delete" };
  if (key === "Escape") return { type: "escape" };
  if (key === "Enter") return { type: "applyCrop" };
  const step = e.shiftKey ? 10 : 1;
  if (key === "ArrowLeft") return { type: "nudge", dx: -step, dy: 0 };
  if (key === "ArrowRight") return { type: "nudge", dx: step, dy: 0 };
  if (key === "ArrowUp") return { type: "nudge", dx: 0, dy: -step };
  if (key === "ArrowDown") return { type: "nudge", dx: 0, dy: step };
  if (e.shiftKey) return null;
  const tool = TOOLS.find((t) => t.key.toLowerCase() === key);
  return tool ? { type: "tool", tool: tool.id } : null;
}

/** The small preset palette: system red first, as every markup tool starts. */
export const PALETTE: { name: string; color: string }[] = [
  { name: "Red", color: "#FF3B30" },
  { name: "Orange", color: "#FF9500" },
  { name: "Yellow", color: "#FFCC00" },
  { name: "Green", color: "#34C759" },
  { name: "Blue", color: "#007AFF" },
  { name: "Purple", color: "#AF52DE" },
  { name: "Black", color: "#000000" },
  { name: "White", color: "#FFFFFF" },
];

export type SizeId = "s" | "m" | "l";

export const SIZES: { id: SizeId; label: string; stroke: number; text: number }[] = [
  { id: "s", label: "Thin", stroke: 3, text: 18 },
  { id: "m", label: "Medium", stroke: 5, text: 26 },
  { id: "l", label: "Thick", stroke: 9, text: 38 },
];
