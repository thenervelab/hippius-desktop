"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { Camera, ChevronDown, PanelBottom, Settings2 } from "lucide-react";

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
import {
  captureDialogAtom,
  captureModesAtom,
  captureSupportedAtom,
  captureSurfacesAtom,
} from "@/app/lib/capture/captureFlow";
import { useStartCapture } from "@/app/lib/capture/useStartCapture";
import { useRecordAvailability } from "@/app/lib/capture/recordAvailability";
import { MODE_ICON, modeLabel, offeredModes } from "@/app/lib/capture/modes";
import { acceleratorKeys, isMacPlatform } from "@/app/lib/capture/shortcutLabel";
import { getCaptureShortcut, type CaptureKind } from "@/app/lib/tauri/capture";
import { SECONDARY_PILL_CLASSES } from "@/app/components/page-sections/drive/uploadActions";
import ShortcutKeys from "./ShortcutKeys";

export const SCREENSHOT_LABEL = "Screenshot";
export const RECORD_LABEL = "Record";
export const RECORD_TOOLTIP = "Record your screen";
export const OPEN_BAR_LABEL = "Open capture bar";
export const CHANGE_DRIVE_LABEL = "Change capture drive…";
/** The one Screenshot item where the desktop's own tool chooses (Wayland). */
export const SYSTEM_PICKER_LABEL = "Take a screenshot…";

/** "Take a screenshot (⇧⌘2)", or without the brackets when no shortcut is set. */
export function screenshotTooltip(keys: string[], mac: boolean): string {
  if (keys.length === 0) return "Take a screenshot";
  return `Take a screenshot (${keys.join(mac ? "" : "+")})`;
}

/**
 * The toolbar's two capture buttons. Each opens its own menu, the way a
 * split control in macOS or Loom does: the three modes for its kind, then
 * the capture bar and the capture drive.
 *
 * Labels show only where the content column is wide enough (a container
 * query on the app's scroll area, which is an `@container`); below that the
 * buttons are an icon and the chevron, with their names on `aria-label` and
 * `title`, so a 900px window with the sidebar open keeps its toolbar on one
 * line.
 *
 * The disabled Record uses `aria-disabled`, not `disabled`: a disabled button
 * takes no pointer events, so its tooltip, the one thing that says WHY, would
 * never show, and it would drop out of the tab order. It is not a menu
 * trigger at all, so it never opens.
 */
const captureButton = cva(
  cn(
    "shrink-0",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50 focus-visible:ring-offset-1 focus-visible:ring-offset-white",
    "dark:focus-visible:ring-primary-brand-dark dark:focus-visible:ring-offset-black-primary-bg",
  ),
  {
    variants: {
      size: {
        // The folder list's header, beside File / Folder / Sync a Folder.
        compact: "h-[26px] gap-1.5 rounded-[6px] text-[12px] font-medium tracking-normal",
        // The drive toolbar and the Overview header: the white pill.
        regular: SECONDARY_PILL_CLASSES,
      },
      labels: {
        auto: "",
        never: "",
      },
      unavailable: {
        true: cn(
          "cursor-not-allowed opacity-50",
          "active:translate-y-0 active:scale-100",
          // The corner dots are the Button's hover decoration; a control
          // that does nothing should not answer hover as if it did.
          "[&>span.absolute]:hidden",
        ),
        false: "",
      },
    },
    compoundVariants: [
      // Icon plus chevron: just wide enough for both, at the toolbar's height.
      { size: "compact", labels: "never", class: "w-auto gap-0.5 px-1.5" },
      { size: "compact", labels: "auto", class: "w-auto gap-0.5 px-1.5 @[52rem]:gap-1.5 @[52rem]:px-2.5" },
      { size: "regular", labels: "never", class: "w-auto gap-0.5 px-2" },
      { size: "regular", labels: "auto", class: "w-auto gap-0.5 px-2 @[52rem]:gap-1.5 @[52rem]:px-3" },
      // Hover leaves an unavailable button as it was.
      { size: "compact", unavailable: true, class: "hover:bg-grey-90 dark:hover:bg-[#2c2c2c]" },
      { size: "regular", unavailable: true, class: "hover:bg-white dark:hover:bg-black-primary-bg" },
    ],
    defaultVariants: { size: "regular", labels: "auto", unavailable: false },
  },
);

// Explicit colours: the shared DropdownMenuContent's base is `bg-popover`, a
// token this theme does not define, so an unstyled menu has no background.
export const CONTENT_CLASSES = cn(
  "min-w-[15rem] max-w-[calc(100vw-2rem)] rounded-lg p-1.5",
  "bg-white border border-grey-80",
  "dark:bg-black-500 dark:border-black-300",
  "shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] dark:shadow-[0px_12px_32px_8px_rgba(0,0,0,0.3)]",
);
export const ITEM_CLASSES = cn(
  "flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 outline-none",
  "font-geist text-[14px] font-medium tracking-[-0.4px]",
  "text-grey-50 hover:bg-grey-90 hover:text-grey-10 focus:bg-grey-90 focus:text-grey-10",
  "dark:text-grey-dark-200 dark:hover:bg-white/5 dark:hover:text-grey-light-100",
  "dark:focus:bg-white/5 dark:focus:text-grey-light-100",
);
export const SEPARATOR_CLASSES = "my-1 h-px bg-grey-80 dark:bg-black-300";
// A line of explanation inside a menu: wraps within the menu's width.
export const NOTE_CLASSES = cn(
  "max-w-[17rem] whitespace-normal px-1.5 pb-1 pt-0.5",
  "font-geist text-[12px] leading-[16px] tracking-normal text-grey-50 dark:text-grey-dark-600",
);

/** The Record glyph: a ring with a red dot, the way record reads everywhere. */
export function RecordGlyph({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-grid shrink-0 place-items-center rounded-full border-[1.5px] border-current", className)}
    >
      <span className="size-[45%] rounded-full bg-[#FF453A]" />
    </span>
  );
}

export interface CaptureButtonsProps {
  /** `compact` for the folder list's 26px header, `regular` elsewhere. */
  size?: "compact" | "regular";
  /** `auto` shows labels where there is room; `never` keeps icons only. */
  labels?: "auto" | "never";
  className?: string;
}

/**
 * Screenshot and Record, side by side, each opening its menu of modes. A
 * capture is filed in the capture drive the user chose, whatever drive is on
 * screen, so no surface gates these on the open drive's role.
 *
 * Renders nothing unless the feature is on for this lane AND Rust says this
 * platform can capture. Record follows `useRecordAvailability`; the modes
 * each menu offers follow Rust's `capture_support.modes` (`offeredModes`).
 */
export default function CaptureButtons({ size = "regular", labels = "auto", className }: CaptureButtonsProps) {
  const supported = useAtomValue(captureSupportedAtom);
  const modes = useAtomValue(captureModesAtom);
  const surfaces = useAtomValue(captureSurfacesAtom);
  const record = useRecordAvailability();
  const setDialog = useSetAtom(captureDialogAtom);
  const startCapture = useStartCapture();
  const [shortcut, setShortcut] = useState<string[]>([]);
  const mac = isMacPlatform();

  // Where Rust says there is no shortcut (Linux, for now), none is shown:
  // keycaps for a shortcut that never fires would send people looking.
  const shortcutWorks = surfaces?.shortcut.supported ?? true;
  // Wayland: the desktop's own screenshot tool chooses area, window or screen.
  const systemPicker = surfaces?.selection === "systemPicker";

  useEffect(() => {
    if (!SCREEN_CAPTURE_ENABLED || !supported) return;
    if (!shortcutWorks) {
      setShortcut([]);
      return;
    }
    getCaptureShortcut()
      .then((s) => setShortcut(s.accelerator ? acceleratorKeys(s.accelerator, isMacPlatform()) : []))
      .catch(() => setShortcut([]));
  }, [supported, shortcutWorks]);

  if (!SCREEN_CAPTURE_ENABLED || !supported) return null;

  const icon = size === "compact" ? "size-3.5" : "size-4";
  const chevron = cn(size === "compact" ? "size-3" : "size-3.5", "shrink-0 opacity-60");
  const label = (text: string) =>
    labels === "auto" ? <span className="hidden @[52rem]:inline">{text}</span> : null;
  const recordUnavailable = record.state === "disabled";

  /**
   * Screenshot where the desktop's own tool chooses (Wayland): one item that
   * opens it, Rust's line saying so, and the capture drive. No capture bar:
   * there is no Hippius overlay to open.
   */
  const systemPickerMenu = (name: string) => (
    <DropdownMenuContent align="start" aria-label={name} className={CONTENT_CLASSES}>
      <DropdownMenuItem className={ITEM_CLASSES} onSelect={() => void startCapture("screenshot")}>
        <Camera aria-hidden className="size-4 shrink-0" />
        {SYSTEM_PICKER_LABEL}
      </DropdownMenuItem>
      {surfaces?.systemPickerNote && <p className={NOTE_CLASSES}>{surfaces.systemPickerNote}</p>}
      <DropdownMenuSeparator className={SEPARATOR_CLASSES} />
      <DropdownMenuItem className={ITEM_CLASSES} onSelect={() => setDialog({ kind: "destination", resume: null })}>
        <Settings2 aria-hidden className="size-4 shrink-0" />
        {CHANGE_DRIVE_LABEL}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  /** One kind's menu: its modes, then the two items that belong to both. */
  const menu = (kind: CaptureKind, name: string) => (
    <DropdownMenuContent align="start" aria-label={name} className={CONTENT_CLASSES}>
      {offeredModes(kind, modes).map((mode) => {
        const ModeIcon = MODE_ICON[mode];
        return (
          <DropdownMenuItem key={mode} className={ITEM_CLASSES} onSelect={() => void startCapture(kind, mode)}>
            <ModeIcon aria-hidden className="size-4 shrink-0" />
            {modeLabel(kind, mode)}
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuSeparator className={SEPARATOR_CLASSES} />
      {/* The bar on this kind, on its last mode: from here the bar can switch to anything. */}
      <DropdownMenuItem className={ITEM_CLASSES} onSelect={() => void startCapture(kind)}>
        <PanelBottom aria-hidden className="size-4 shrink-0" />
        <span className="flex-1">{OPEN_BAR_LABEL}</span>
        <ShortcutKeys keys={shortcut} className="ml-4" />
      </DropdownMenuItem>
      <DropdownMenuItem className={ITEM_CLASSES} onSelect={() => setDialog({ kind: "destination", resume: null })}>
        <Settings2 aria-hidden className="size-4 shrink-0" />
        {CHANGE_DRIVE_LABEL}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  const trigger = (name: string, title: string, glyph: ReactNode) => (
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant="defaultStable"
        size="auto"
        aria-label={name}
        title={title}
        className={captureButton({ size, labels })}
      >
        {glyph}
        {label(name)}
        <ChevronDown aria-hidden className={chevron} />
      </Button>
    </DropdownMenuTrigger>
  );

  return (
    <div
      role="group"
      aria-label="Screen capture"
      className={cn("flex shrink-0 items-center", size === "compact" ? "gap-1.5" : "gap-2", className)}
    >
      <DropdownMenu>
        {trigger(
          SCREENSHOT_LABEL,
          screenshotTooltip(shortcut, mac),
          <Camera aria-hidden className={cn(icon, "shrink-0")} />,
        )}
        {systemPicker ? systemPickerMenu(SCREENSHOT_LABEL) : menu("screenshot", SCREENSHOT_LABEL)}
      </DropdownMenu>

      {record.state === "available" && (
        <DropdownMenu>
          {trigger(RECORD_LABEL, RECORD_TOOLTIP, <RecordGlyph className={icon} />)}
          {menu("recording", RECORD_LABEL)}
        </DropdownMenu>
      )}

      {record.state === "disabled" && (
        <Button
          type="button"
          variant="defaultStable"
          size="auto"
          aria-label={RECORD_LABEL}
          aria-disabled
          title={record.reason}
          className={captureButton({ size, labels, unavailable: recordUnavailable })}
        >
          <RecordGlyph className={icon} />
          {label(RECORD_LABEL)}
          <ChevronDown aria-hidden className={chevron} />
        </Button>
      )}
    </div>
  );
}
