"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Camera, ChevronDown, Settings2 } from "lucide-react";

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
    <div className="flex min-w-0 flex-1">
      <Button
        type="button"
        variant="subtle"
        size="auto"
        title={title}
        onClick={() => void captureFromTray(kind)}
        className={cn(HALF, "flex-1 justify-start gap-2 rounded-r-none px-3")}
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
              "w-9 shrink-0 rounded-l-none border-l border-[rgba(0,0,0,0.08)] dark:border-white/10",
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
    <div className="flex min-w-0 flex-1">
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
          "flex-1 cursor-not-allowed justify-start gap-2 px-3 opacity-50 active:translate-y-0 active:scale-100",
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

/** Two pills where the buttons will be, while Rust is asked. */
function TrayCaptureRowSkeleton() {
  const bar = "h-10 flex-1 rounded-[12px] bg-[rgba(0,0,0,0.08)] dark:bg-white/10";
  return (
    <div aria-hidden data-testid="tray-capture-skeleton" className="flex animate-pulse gap-2 px-5 pt-3">
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
