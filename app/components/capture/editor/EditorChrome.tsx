"use client";

import { ChevronDown, Copy, Loader, Minus, Plus, Trash2 } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { Annotation } from "@/app/lib/capture/editor/model";
import type { SizeId } from "@/app/lib/capture/editor/shortcuts";
import type { EditorContext, SaveMode } from "@/app/lib/tauri/captureEditor";
import { ColourChoices, FOCUS, ICON_BUTTON, PILL, SizeChoices } from "./EditorToolbar";
import { SECONDARY } from "./EditorDialogs";

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

/** What each way of saving is called, on the button and in its menu. */
export const SAVE_COPY_LABEL = "Save copy";
export const REPLACE_ORIGINAL_LABEL = "Replace original";
export const SAVE_TO_CAPTURES_LABEL = "Save to Captures";

/**
 * The main Save button says what a press does: a picture from outside the
 * drives goes to Captures; otherwise the remembered choice, and a copy
 * (the safe one) when the user is asked each time, where the dialog opens
 * on it.
 */
export function saveLabel(context: Pick<EditorContext, "saveKind" | "savePreference">): string {
  if (context.saveKind === "newCapture") return SAVE_TO_CAPTURES_LABEL;
  if (context.savePreference === "replace") return REPLACE_ORIGINAL_LABEL;
  return SAVE_COPY_LABEL;
}

const SPLIT = `flex h-9 items-center justify-center gap-1.5 whitespace-nowrap bg-primary-50 text-[13px] font-medium text-grey-100 hover:bg-primary-60 disabled:opacity-50 disabled:hover:bg-primary-50 ${FOCUS}`;
const MENU_ITEM =
  "flex cursor-pointer select-none items-center rounded-[8px] px-2.5 py-2 text-[13px] font-medium text-grey-100 outline-none data-[highlighted]:bg-black-300";

/**
 * The top bar's right end: Copy image, then Save as a split button. The
 * main part saves the way {@link saveLabel} says; the chevron offers both
 * ways for a picture in a drive. `onSave(undefined)` is the main button
 * (and the keyboard's Save), `onSave(mode)` a choice from the menu; the
 * editor decides whether that still asks first (the "Ask" preference).
 * These never shrink: the file name gives way first.
 */
export function SaveActions({
  context,
  dirty,
  busy,
  showSpinner,
  modKey,
  onCopy,
  onSave,
}: {
  context: Pick<EditorContext, "saveKind" | "savePreference">;
  dirty: boolean;
  busy: boolean;
  /** A save without the dialog is running. */
  showSpinner: boolean;
  modKey: string;
  onCopy: () => void;
  onSave: (mode?: SaveMode) => void;
}) {
  const label = saveLabel(context);
  const offersChoice = context.saveKind !== "newCapture";
  const disabled = busy || !dirty;
  return (
    <div data-testid="editor-save-actions" className="flex shrink-0 items-center gap-2">
      <button type="button" onClick={onCopy} disabled={busy} className={SECONDARY} aria-label="Copy image" title={`Copy image (${modKey}C)`}>
        <Copy aria-hidden className="size-4" />
        <span>Copy image</span>
      </button>
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          onClick={() => onSave()}
          disabled={disabled}
          className={`${SPLIT} px-4 ${offersChoice ? "rounded-l-[10px]" : "rounded-[10px]"}`}
          title={dirty ? `${label} (${modKey}S)` : "Nothing to save yet"}
        >
          {showSpinner && <Loader aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
          {label}
        </button>
        {offersChoice && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild disabled={disabled}>
              <button
                type="button"
                aria-label="More ways to save"
                title="More ways to save"
                className={`${SPLIT} w-8 rounded-r-[10px] border-l border-primary-70/60`}
              >
                <ChevronDown aria-hidden className="size-4" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              {/* Above the editor layer (z-1000) and its dialogs. */}
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="z-[1003] min-w-[11rem] rounded-[12px] border border-black-200 bg-black-primary-bg p-1 shadow-[0_16px_40px_rgba(0,0,0,0.55)]"
              >
                <DropdownMenu.Item className={MENU_ITEM} onSelect={() => onSave("copy")}>
                  {SAVE_COPY_LABEL}
                </DropdownMenu.Item>
                <DropdownMenu.Item className={MENU_ITEM} onSelect={() => onSave("replace")}>
                  {REPLACE_ORIGINAL_LABEL}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>
    </div>
  );
}
