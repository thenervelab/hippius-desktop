"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Camera, ChevronDown, FolderOpen, Image as ImageIcon, PencilLine, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";
import { getCaptureSupport, type CaptureKind, type CaptureMode, type CaptureSupport } from "@/app/lib/tauri/capture";
import { MODE_ICON, modeLabel } from "@/app/lib/capture/modes";
import { isMacPlatform } from "@/app/lib/capture/shortcutLabel";
import {
  CHANGE_DRIVE_LABEL,
  CONTENT_CLASSES,
  ITEM_CLASSES,
  NOTE_CLASSES,
  RECORD_LABEL,
  RECORD_TOOLTIP,
  RecordGlyph,
  SCREENSHOT_LABEL,
  SEPARATOR_CLASSES,
  SYSTEM_PICKER_LABEL,
} from "@/app/components/capture/CaptureButtons";
import { TRAY_CAPTURE_DRIVE_EVENT, TRAY_CAPTURE_EVENT } from "@/app/lib/tray/trayWindowActions";
import {
  annotateChosenImage,
  annotateLatestScreenshot,
  getLatestScreenshot,
  type LatestScreenshot,
} from "@/app/lib/tauri/captureEditor";
import { trayCaptureView } from "./trayCaptureView";

/**
 * Screenshot and Record from the menu bar, the way CleanShot and Zight do it:
 * one click on the icon, one click here, and the capture overlay is up on the
 * display under the pointer (window and screen are click-to-capture there),
 * with the share link copied when it is done.
 *
 * Each button is split: its body starts that kind at once (the capture bar
 * opens on the mode used last), its chevron offers the same menu as the Drive
 * page's `CaptureButtons` (area / window / entire screen, then the capture
 * drive). Every choice is Rust's (`capture_support`, via `trayCaptureView`).
 *
 * The popover hides itself FIRST, then asks the main window to start
 * (`TRAY_CAPTURE_EVENT` → `CaptureHost` → `useStartCapture` → `capture_start`),
 * so the popover is never in the shot and a first capture still gets the
 * drive picker or the permission explainer, which are main-window dialogs.
 *
 * Annotate opens a picture in the screenshot editor: the latest screenshot
 * or one picked in the system's file dialog (see `AnnotateButton`).
 */
export default function TrayCaptureRow() {
  // undefined = asking Rust, null = it could not say.
  const [support, setSupport] = useState<CaptureSupport | null | undefined>(
    SCREEN_CAPTURE_ENABLED ? undefined : null,
  );
  useEffect(() => {
    if (!SCREEN_CAPTURE_ENABLED) return;
    let live = true;
    getCaptureSupport()
      .then((s) => live && setSupport(s))
      .catch(() => live && setSupport(null));
    return () => {
      live = false;
    };
  }, []);

  const view = trayCaptureView(SCREEN_CAPTURE_ENABLED, support, isMacPlatform());
  if (view.state === "hidden") return null;
  if (view.state === "loading") return <TrayCaptureRowSkeleton />;

  const { record } = view;
  return (
    <div role="group" aria-label="Screen capture" className="@container flex min-w-0 gap-2 px-5 pt-3">
      <SplitCaptureButton
        kind="screenshot"
        label={SCREENSHOT_LABEL}
        title="Take a screenshot"
        glyph={<Camera aria-hidden className="size-4 shrink-0" />}
        menu={
          view.systemPicker ? (
            <>
              <DropdownMenuItem className={ITEM_CLASSES} onSelect={() => void captureFromTray("screenshot")}>
                <Camera aria-hidden className="size-4 shrink-0" />
                {SYSTEM_PICKER_LABEL}
              </DropdownMenuItem>
              {view.systemPickerNote && <p className={NOTE_CLASSES}>{view.systemPickerNote}</p>}
            </>
          ) : (
            <ModeItems kind="screenshot" modes={view.screenshotModes} />
          )
        }
      />
      {record.state === "available" && (
        <SplitCaptureButton
          kind="recording"
          label={RECORD_LABEL}
          title={RECORD_TOOLTIP}
          glyph={<RecordGlyph className="size-4" />}
          menu={<ModeItems kind="recording" modes={view.recordModes} />}
        />
      )}
      {record.state === "disabled" && <UnavailableRecordButton reason={record.reason} />}
      <AnnotateButton />
    </div>
  );
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

/** A button's icon, dropped when the row is too narrow for it and the whole
 *  label (the row is a container), so "Screenshot" never truncates first. */
function Glyph({ children }: { children: ReactNode }) {
  return <span className="hidden shrink-0 @[18rem]:inline-flex">{children}</span>;
}

const HALF = "h-10 min-w-0 text-[14px] font-medium tracking-[-0.28px]";
/** A button's body: three share the row, so the padding is kept tight. */
const BODY = "justify-start gap-1.5 px-2.5";

function SplitCaptureButton({
  kind,
  label,
  title,
  glyph,
  menu,
}: {
  kind: CaptureKind;
  label: string;
  title: string;
  glyph: ReactNode;
  menu: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // The popover hides on a click outside it (a window blur), which Radix
  // never hears: close the menu with it, so the next open is not stuck on it.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [open]);

  return (
    <div className="flex min-w-0 flex-auto">
      <Button
        type="button"
        variant="subtle"
        size="auto"
        title={title}
        onClick={() => void captureFromTray(kind)}
        className={cn(HALF, BODY, "flex-1 rounded-r-none")}
      >
        <Glyph>{glyph}</Glyph>
        <span className="min-w-0 truncate">{label}</span>
      </Button>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="subtle"
            size="auto"
            aria-label={`${label} options`}
            title={`${label} options`}
            className={cn(
              HALF,
              "w-8 shrink-0 rounded-l-none border-l border-[rgba(0,0,0,0.08)] dark:border-white/10",
            )}
          >
            <ChevronDown aria-hidden className="size-3.5 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        {/* Named by its trigger ("Screenshot options"), which Radix links. */}
        <DropdownMenuContent align="end" className={CONTENT_CLASSES}>
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
 * Record where this Mac could record with another build or a newer macOS:
 * kept in view, dimmed, saying why. `aria-disabled`, not `disabled`, so the
 * reason's tooltip still shows and the button stays in the tab order.
 */
function UnavailableRecordButton({ reason }: { reason: string }) {
  const reasonId = useId();
  return (
    <div className="flex min-w-0 flex-auto">
      <Button
        type="button"
        variant="subtle"
        size="auto"
        aria-label={RECORD_LABEL}
        aria-disabled
        aria-describedby={reasonId}
        title={reason}
        className={cn(
          HALF,
          BODY,
          "flex-1 cursor-not-allowed opacity-50 active:translate-y-0 active:scale-100",
        )}
      >
        <Glyph>
          <RecordGlyph className="size-4" />
        </Glyph>
        <span className="min-w-0 truncate">{RECORD_LABEL}</span>
      </Button>
      <span id={reasonId} className="sr-only">
        {reason}
      </span>
    </div>
  );
}

export const ANNOTATE_LABEL = "Annotate";
export const ANNOTATE_LATEST_LABEL = "Latest screenshot";
export const ANNOTATE_CHOOSE_LABEL = "Choose image…";

/**
 * Annotate: open a picture in the screenshot editor. With a latest
 * screenshot (Rust's answer, asked again whenever the popover gets focus,
 * so it is current each time it opens) the button opens a small menu,
 * "Latest screenshot" and "Choose image…"; with none it goes straight to the
 * file dialog. Rust shows the dialog, decides where the edit is saved, and
 * tells the user when nothing could be opened (the popover is gone by then).
 */
function AnnotateButton() {
  const [latest, setLatest] = useState<LatestScreenshot | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    const ask = () => {
      getLatestScreenshot()
        .then((l) => live && setLatest(l ?? null))
        .catch(() => live && setLatest(null));
    };
    ask();
    window.addEventListener("focus", ask);
    return () => {
      live = false;
      window.removeEventListener("focus", ask);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [open]);

  const body = (
    <>
      <Glyph>
        <PencilLine aria-hidden className="size-4" />
      </Glyph>
      <span className="min-w-0 truncate">{ANNOTATE_LABEL}</span>
    </>
  );
  const className = cn(HALF, BODY, "shrink-0");
  const title = "Edit a screenshot or picture";

  if (!latest) {
    return (
      <Button
        type="button"
        variant="subtle"
        size="auto"
        title={title}
        onClick={() => void annotateFromTray("choose")}
        className={className}
      >
        {body}
      </Button>
    );
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="subtle" size="auto" title={title} className={className}>
          {body}
          <ChevronDown aria-hidden className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      {/* Named by its trigger ("Annotate"), which Radix links. */}
      <DropdownMenuContent align="end" className={CONTENT_CLASSES}>
        <DropdownMenuItem className={ITEM_CLASSES} onSelect={() => void annotateFromTray("latest")}>
          <ImageIcon aria-hidden className="size-4 shrink-0" />
          <span className="flex min-w-0 flex-col">
            {ANNOTATE_LATEST_LABEL}
            <span className="max-w-[14rem] truncate text-[12px] font-normal opacity-60">{latest.fileName}</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem className={ITEM_CLASSES} onSelect={() => void annotateFromTray("choose")}>
          <FolderOpen aria-hidden className="size-4 shrink-0" />
          {ANNOTATE_CHOOSE_LABEL}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Hide the popover, then let Rust open the picture: the dialog and the
 * editor must not sit under an always-on-top popover. "Latest" falls back
 * to the dialog when the screenshot has gone since the menu was drawn.
 */
async function annotateFromTray(source: "latest" | "choose") {
  try {
    await invoke("hide_tray_panel");
    if (source === "latest" && (await annotateLatestScreenshot())) return;
    await annotateChosenImage();
  } catch (error) {
    // Rust has already told the user, in a notification.
    console.error("[TrayPanel] Failed to open a picture to annotate:", error);
  }
}

/** Three pills where the buttons will be, while Rust is asked. */
function TrayCaptureRowSkeleton() {
  const bar = "h-10 flex-1 rounded-[12px] bg-[rgba(0,0,0,0.08)] dark:bg-white/10";
  return (
    <div aria-hidden data-testid="tray-capture-skeleton" className="flex animate-pulse gap-2 px-5 pt-3">
      <span className={bar} />
      <span className={bar} />
      <span className={bar} />
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
