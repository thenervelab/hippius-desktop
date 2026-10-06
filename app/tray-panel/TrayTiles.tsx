"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Camera, ChevronDown, ImagePlus, Settings2, Upload } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { CaptureKind, CaptureMode } from "@/app/lib/tauri/capture";
import { MODE_ICON, modeLabel } from "@/app/lib/capture/modes";
import {
  CHANGE_DRIVE_LABEL,
  CONTENT_CLASSES,
  ITEM_CLASSES,
  NOTE_CLASSES,
  RECORD_LABEL,
  RECORD_TOOLTIP,
  SCREENSHOT_LABEL,
  SEPARATOR_CLASSES,
  SYSTEM_PICKER_LABEL,
} from "@/app/components/capture/CaptureButtons";
import { TRAY_CAPTURE_DRIVE_EVENT, TRAY_CAPTURE_EVENT } from "@/app/lib/tray/trayWindowActions";
import { annotateChosenImage } from "@/app/lib/tauri/captureEditor";
import type { TrayCaptureView } from "./trayCaptureView";
import type { TrayShortcuts } from "./useTrayCaptureView";
import { openMainFiles, uploadDroppedPaths } from "./trayMainWindow";

export const ANNOTATE_IMAGE_LABEL = "Annotate an image…";
export const UPLOAD_LABEL = "Upload";
export const UPLOAD_HINT = "or drop files";

/**
 * The popover's three tiles under the header: Screenshot, Record and Upload,
 * the way CleanShot and Zight put their actions one click from the menu bar.
 *
 * Screenshot and Record start that kind on the mode used last, each with
 * its shortcut's keys underneath where Hippius holds it; the small
 * arrow in each tile's corner offers the Drive page's mode menu (area,
 * window, entire screen), and Screenshot's also "Annotate an image…" (any
 * picture, picked in the system's dialog, opened in the editor). Every
 * choice is Rust's (`capture_support`, read through `trayCaptureView`):
 * where capture is off or unsupported only Upload is shown.
 *
 * A capture hides the popover FIRST, then asks the main window to start
 * (`TRAY_CAPTURE_EVENT` → `CaptureHost` → `useStartCapture`), so the popover
 * is never in the shot and a first capture still gets the drive picker or
 * the permission explainer, which are main-window dialogs.
 *
 * Upload opens the Drive page in the main window, like the empty state's
 * button. Files dropped anywhere on the popover go to the main window's
 * upload dialog (`uploadDroppedPaths`); the tile lights up while they hover.
 */
export default function TrayTiles({ view, shortcut }: { view: TrayCaptureView; shortcut: TrayShortcuts }) {
  const dragging = useDropOnPanel();

  if (view.state === "loading") return <TrayTilesSkeleton />;

  if (view.state === "hidden") {
    return (
      <div role="group" aria-label="Upload" className="px-5 pt-4">
        <UploadTile dragging={dragging} wide />
      </div>
    );
  }

  const { record } = view;
  const recordTile =
    record.state === "available" ? (
      <CaptureTile
        kind="recording"
        label={RECORD_LABEL}
        title={RECORD_TOOLTIP}
        hint={shortcut.record.length > 0 ? shortcutText(shortcut.record) : null}
        icon={<span aria-hidden className="size-3 rounded-full bg-white" />}
        tone="bg-error-60"
        menu={<ModeItems kind="recording" modes={view.recordModes} />}
      />
    ) : record.state === "disabled" ? (
      <UnavailableRecordTile reason={record.reason} />
    ) : null;

  return (
    <div
      role="group"
      aria-label="Capture and upload"
      className={cn("grid gap-2 px-5 pt-4", recordTile ? "grid-cols-3" : "grid-cols-2")}
    >
      <CaptureTile
        kind="screenshot"
        label={SCREENSHOT_LABEL}
        title="Take a screenshot"
        hint={shortcut.screenshot.length > 0 ? shortcutText(shortcut.screenshot) : null}
        icon={<Camera aria-hidden className="size-[18px]" strokeWidth={2} />}
        tone="bg-primary-50"
        menu={
          <>
            {view.systemPicker ? (
              <>
                <DropdownMenuItem className={ITEM_CLASSES} onSelect={() => void captureFromTray("screenshot")}>
                  <Camera aria-hidden className="size-4 shrink-0" />
                  {SYSTEM_PICKER_LABEL}
                </DropdownMenuItem>
                {view.systemPickerNote && <p className={NOTE_CLASSES}>{view.systemPickerNote}</p>}
              </>
            ) : (
              <ModeItems kind="screenshot" modes={view.screenshotModes} />
            )}
            <DropdownMenuSeparator className={SEPARATOR_CLASSES} />
            <DropdownMenuItem className={ITEM_CLASSES} onSelect={() => void annotateFromTray()}>
              <ImagePlus aria-hidden className="size-4 shrink-0" />
              {ANNOTATE_IMAGE_LABEL}
            </DropdownMenuItem>
          </>
        }
      />
      {recordTile}
      <UploadTile dragging={dragging} />
    </div>
  );
}

/** "⇧⌘2" on a Mac, "Ctrl+Shift+2" elsewhere (the keys are already in order). */
function shortcutText(keys: string[]): string {
  const symbols = keys.every((k) => k.length === 1);
  return keys.join(symbols ? "" : "+");
}

/** One kind's modes, in the Drive menu's order and words. */
function ModeItems({ kind, modes }: { kind: CaptureKind; modes: CaptureMode[] }) {
  return (
    <>
      {modes.map((mode) => {
        const ModeIcon = MODE_ICON[mode];
        return (
          <DropdownMenuItem key={mode} className={ITEM_CLASSES} onSelect={() => void captureFromTray(kind, mode)}>
            <ModeIcon aria-hidden className="size-4 shrink-0" />
            {modeLabel(kind, mode)}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/** The tiles' shared surface: the search field's fill, so the row reads as one family. */
const TILE =
  "flex h-full w-full min-w-0 flex-col items-center justify-center gap-1.5 rounded-[12px] px-2 pb-2.5 pt-3 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-50 dark:focus-visible:ring-primary-brand-dark";
const TILE_FILL = "bg-[#0000000F] hover:bg-[#00000014] dark:bg-white/[0.06] dark:hover:bg-white/10";
const TILE_LABEL =
  "max-w-full truncate font-geist text-[14px] font-medium leading-5 tracking-[-0.28px] text-grey-10 dark:text-white";
const TILE_HINT =
  "max-w-full truncate font-geist text-[11px] font-medium leading-[14px] text-[rgba(0,0,0,0.4)] dark:text-white/40";

function CaptureTile({
  kind,
  label,
  title,
  hint,
  icon,
  tone,
  menu,
}: {
  kind: CaptureKind;
  label: string;
  title: string;
  /** The shortcut under the label; null leaves the line empty (it keeps its height). */
  hint: string | null;
  icon: ReactNode;
  /** The round icon's fill. */
  tone: string;
  menu: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const hintId = useId();
  // The popover hides on a click outside it (a window blur), which Radix
  // never hears: close the menu with it, so the next open is not stuck on it.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [open]);

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
        title={hint ? `${title} (${hint})` : title}
        onClick={() => void captureFromTray(kind)}
        className={cn(TILE, TILE_FILL)}
      >
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-white", tone)}>
          {icon}
        </span>
        <span className={TILE_LABEL}>{label}</span>
        <span id={hintId} className={TILE_HINT}>
          {hint ? (
            <>
              <span className="sr-only">Shortcut </span>
              {hint}
            </>
          ) : (
            " "
          )}
        </span>
      </button>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${label} options`}
            title={`${label} options`}
            className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-md text-[rgba(0,0,0,0.45)] outline-none transition-colors hover:bg-[rgba(0,0,0,0.08)] hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 data-[state=open]:bg-[rgba(0,0,0,0.08)] dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white dark:focus-visible:ring-primary-brand-dark dark:data-[state=open]:bg-white/10"
          >
            <ChevronDown aria-hidden className="size-3.5 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        {/* Named by its trigger ("Screenshot options"), which Radix links. */}
        <DropdownMenuContent align="start" className={CONTENT_CLASSES}>
          {menu}
          <DropdownMenuSeparator className={SEPARATOR_CLASSES} />
          <DropdownMenuItem className={ITEM_CLASSES} onSelect={() => void changeCaptureDriveFromTray()}>
            <Settings2 aria-hidden className="size-4 shrink-0" />
            {CHANGE_DRIVE_LABEL}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Record where this computer could record with another build or a newer OS:
 * kept in view, dimmed, saying why. `aria-disabled`, not `disabled`, so the
 * reason's tooltip still shows and the tile stays in the tab order.
 */
function UnavailableRecordTile({ reason }: { reason: string }) {
  const reasonId = useId();
  return (
    <div className="relative min-w-0">
      <button
        type="button"
        aria-label={RECORD_LABEL}
        aria-disabled
        aria-describedby={reasonId}
        title={reason}
        className={cn(TILE, "cursor-not-allowed bg-[#0000000F] opacity-50 dark:bg-white/[0.06]")}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-error-60 text-white">
          <span aria-hidden className="size-3 rounded-full bg-white" />
        </span>
        <span className={TILE_LABEL}>{RECORD_LABEL}</span>
        <span className={TILE_HINT}>Unavailable</span>
      </button>
      <span id={reasonId} className="sr-only">
        {reason}
      </span>
    </div>
  );
}

/** The quieter tile: a dashed outline, a neutral icon, and the drop hint. */
function UploadTile({ dragging, wide = false }: { dragging: boolean; wide?: boolean }) {
  return (
    <button
      type="button"
      aria-label={`${UPLOAD_LABEL}, ${UPLOAD_HINT}`}
      title="Upload files to Hippius"
      onClick={() => void openMainFiles()}
      data-dragging={dragging || undefined}
      className={cn(
        TILE,
        "border border-dashed",
        dragging
          ? "border-primary-50 bg-primary-50/10 dark:border-primary-brand-dark dark:bg-primary-brand-dark/10"
          : "border-[rgba(0,0,0,0.18)] hover:bg-[rgba(0,0,0,0.03)] dark:border-white/20 dark:hover:bg-white/[0.04]",
        wide && "flex-row gap-3 py-3",
      )}
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full",
          dragging
            ? "bg-primary-50 text-white dark:bg-primary-brand-dark"
            : "bg-[rgba(0,0,0,0.06)] text-[rgba(0,0,0,0.6)] dark:bg-white/10 dark:text-white/70",
        )}
      >
        <Upload aria-hidden className="size-[18px]" strokeWidth={2} />
      </span>
      <span className={cn("flex min-w-0 flex-col", wide ? "items-start" : "items-center gap-1.5")}>
        <span className={TILE_LABEL}>{dragging ? "Drop to upload" : UPLOAD_LABEL}</span>
        <span aria-hidden className={TILE_HINT}>
          {UPLOAD_HINT}
        </span>
      </span>
    </button>
  );
}

/**
 * Files dragged over the popover window. Scoped to this webview: a drop
 * elsewhere in the app is not ours. Where the platform delivers no drops to
 * the popover the listener simply never fires, and the tile still uploads
 * by click.
 */
function useDropOnPanel(): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const { payload } = event;
          if (payload.type === "enter" || payload.type === "over") setDragging(true);
          else if (payload.type === "leave") setDragging(false);
          else if (payload.type === "drop") {
            setDragging(false);
            void uploadDroppedPaths(payload.paths ?? []);
          }
        })
        .then((un) => {
          if (live) unlisten = un;
          else un();
        })
        .catch((error) => console.error("[TrayPanel] drop listener failed:", error));
    } catch (error) {
      console.error("[TrayPanel] drop listener failed:", error);
    }
    // A drag that leaves through a window blur sends no leave.
    const reset = () => setDragging(false);
    window.addEventListener("blur", reset);
    return () => {
      live = false;
      unlisten?.();
      window.removeEventListener("blur", reset);
    };
  }, []);
  return dragging;
}

/** Three tiles' places, while Rust is asked. */
function TrayTilesSkeleton() {
  const tile = "h-[94px] rounded-[12px] bg-[rgba(0,0,0,0.08)] dark:bg-white/10";
  return (
    <div aria-hidden data-testid="tray-capture-skeleton" className="grid animate-pulse grid-cols-3 gap-2 px-5 pt-4">
      <span className={tile} />
      <span className={tile} />
      <span className={tile} />
    </div>
  );
}

/**
 * Hide the popover, then ask the main window to start. Awaited in that order:
 * Rust also hides the popover when the capture starts, but the overlay must
 * never open over it, even for a moment.
 */
async function captureFromTray(kind: CaptureKind, mode?: CaptureMode) {
  try {
    await invoke("hide_tray_panel");
    await emit(TRAY_CAPTURE_EVENT, { kind, mode });
  } catch (error) {
    console.error("[TrayPanel] Failed to start a capture:", error);
  }
}

async function changeCaptureDriveFromTray() {
  try {
    await invoke("hide_tray_panel");
    await emit(TRAY_CAPTURE_DRIVE_EVENT, {});
  } catch (error) {
    console.error("[TrayPanel] Failed to open the capture drive picker:", error);
  }
}

/**
 * "Annotate an image…": hide the popover, then let Rust show the system's
 * file dialog and open the picked picture in the editor. The dialog and the
 * editor must not sit under an always-on-top popover. Rust tells the user
 * when nothing could be opened (the popover is gone by then).
 */
async function annotateFromTray() {
  try {
    await invoke("hide_tray_panel");
    await annotateChosenImage();
  } catch (error) {
    console.error("[TrayPanel] Failed to open a picture to annotate:", error);
  }
}
