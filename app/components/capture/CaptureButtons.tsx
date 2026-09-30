"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { cva } from "class-variance-authority";
import { Camera, Ellipsis, Settings2 } from "lucide-react";

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
import { captureDialogAtom, captureSupportedAtom } from "@/app/lib/capture/captureFlow";
import { useStartCapture } from "@/app/lib/capture/useStartCapture";
import { useRecordAvailability } from "@/app/lib/capture/recordAvailability";
import { acceleratorKeys, isMacPlatform } from "@/app/lib/capture/shortcutLabel";
import { getCaptureShortcut } from "@/app/lib/tauri/capture";
import { SECONDARY_PILL_CLASSES } from "@/app/components/page-sections/drive/uploadActions";
import ShortcutKeys from "./ShortcutKeys";

export const SCREENSHOT_LABEL = "Screenshot";
export const RECORD_LABEL = "Record";
export const RECORD_TOOLTIP = "Record your screen";
export const MORE_OPTIONS_LABEL = "More capture options";

/** "Take a screenshot (⇧⌘2)", or without the brackets when no shortcut is set. */
export function screenshotTooltip(keys: string[], mac: boolean): string {
  if (keys.length === 0) return "Take a screenshot";
  return `Take a screenshot (${keys.join(mac ? "" : "+")})`;
}

/**
 * The toolbar's two capture buttons, and one "…" for the rest.
 *
 * Labels show only where the content column is wide enough (a container
 * query on the app's scroll area, which is an `@container`); below that the
 * buttons are icons with their names on `aria-label` and `title`, so a 900px
 * window with the sidebar open keeps its toolbar on one line.
 *
 * The disabled Record uses `aria-disabled`, not `disabled`: a disabled button
 * takes no pointer events, so its tooltip, the one thing that says WHY, would
 * never show, and it would drop out of the tab order.
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
        /** The "…" trigger: always an icon. */
        icon: "",
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
      { size: "compact", labels: ["never", "icon"], class: "w-[26px] px-0" },
      { size: "compact", labels: "auto", class: "w-[26px] px-0 @[52rem]:w-auto @[52rem]:px-2.5" },
      { size: "regular", labels: ["never", "icon"], class: "w-[30px] px-0" },
      { size: "regular", labels: "auto", class: "w-[30px] px-0 @[52rem]:w-auto @[52rem]:px-3" },
      // Hover leaves an unavailable button as it was.
      { size: "compact", unavailable: true, class: "hover:bg-grey-90 dark:hover:bg-[#2c2c2c]" },
      { size: "regular", unavailable: true, class: "hover:bg-white dark:hover:bg-black-primary-bg" },
    ],
    defaultVariants: { size: "regular", labels: "auto", unavailable: false },
  },
);

// Explicit colours: the shared DropdownMenuContent's base is `bg-popover`, a
// token this theme does not define, so an unstyled menu has no background.
const CONTENT_CLASSES = cn(
  "min-w-[15rem] rounded-lg p-1.5",
  "bg-white border border-grey-80",
  "dark:bg-black-500 dark:border-black-300",
  "shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] dark:shadow-[0px_12px_32px_8px_rgba(0,0,0,0.3)]",
);
const ITEM_CLASSES = cn(
  "flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 outline-none",
  "font-geist text-[14px] font-medium tracking-[-0.4px]",
  "text-grey-50 hover:bg-grey-90 hover:text-grey-10 focus:bg-grey-90 focus:text-grey-10",
  "dark:text-grey-dark-200 dark:hover:bg-white/5 dark:hover:text-grey-light-100",
  "dark:focus:bg-white/5 dark:focus:text-grey-light-100",
);
const SEPARATOR_CLASSES = "my-1 h-px bg-grey-80 dark:bg-black-300";

/** The Record glyph: a ring with a red dot, the way record reads everywhere. */
function RecordGlyph({ className }: { className?: string }) {
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
 * Screenshot and Record, side by side, then "…" for the capture bar's
 * shortcut and the capture drive. Each opens the capture bar on its kind
 * (the bar remembers the last mode). A capture is filed in the capture drive
 * the user chose, whatever drive is on screen, so no surface gates these on
 * the open drive's role.
 *
 * Renders nothing unless the feature is on for this lane AND Rust says this
 * platform can capture. Record follows `useRecordAvailability`.
 */
export default function CaptureButtons({ size = "regular", labels = "auto", className }: CaptureButtonsProps) {
  const supported = useAtomValue(captureSupportedAtom);
  const record = useRecordAvailability();
  const setDialog = useSetAtom(captureDialogAtom);
  const startCapture = useStartCapture();
  const [shortcut, setShortcut] = useState<string[]>([]);
  const mac = isMacPlatform();

  useEffect(() => {
    if (!SCREEN_CAPTURE_ENABLED || !supported) return;
    getCaptureShortcut()
      .then((s) => setShortcut(s.accelerator ? acceleratorKeys(s.accelerator, isMacPlatform()) : []))
      .catch(() => setShortcut([]));
  }, [supported]);

  if (!SCREEN_CAPTURE_ENABLED || !supported) return null;

  const icon = size === "compact" ? "size-3.5" : "size-4";
  const label = (text: string) =>
    labels === "auto" ? <span className="hidden @[52rem]:inline">{text}</span> : null;
  const recordUnavailable = record.state === "disabled";

  return (
    <div
      role="group"
      aria-label="Screen capture"
      className={cn("flex shrink-0 items-center", size === "compact" ? "gap-1.5" : "gap-2", className)}
    >
      <Button
        type="button"
        variant="defaultStable"
        size="auto"
        aria-label={SCREENSHOT_LABEL}
        title={screenshotTooltip(shortcut, mac)}
        className={captureButton({ size, labels })}
        onClick={() => void startCapture("screenshot")}
      >
        <Camera aria-hidden className={cn(icon, "shrink-0")} />
        {label(SCREENSHOT_LABEL)}
      </Button>

      {record.state !== "hidden" && (
        <Button
          type="button"
          variant="defaultStable"
          size="auto"
          aria-label={RECORD_LABEL}
          aria-disabled={recordUnavailable || undefined}
          title={record.state === "disabled" ? record.reason : RECORD_TOOLTIP}
          className={captureButton({ size, labels, unavailable: recordUnavailable })}
          onClick={() => {
            if (recordUnavailable) return;
            void startCapture("recording");
          }}
        >
          <RecordGlyph className={icon} />
          {label(RECORD_LABEL)}
        </Button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="defaultStable"
            size="auto"
            aria-label={MORE_OPTIONS_LABEL}
            title={MORE_OPTIONS_LABEL}
            className={captureButton({ size, labels: "icon" })}
          >
            <Ellipsis aria-hidden className={cn(icon, "shrink-0")} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label={MORE_OPTIONS_LABEL} className={CONTENT_CLASSES}>
          <DropdownMenuItem className={ITEM_CLASSES} onSelect={() => void startCapture()}>
            <Camera aria-hidden className="size-4" />
            <span className="flex-1">Open capture bar</span>
            <ShortcutKeys keys={shortcut} className="ml-4" />
          </DropdownMenuItem>
          <DropdownMenuSeparator className={SEPARATOR_CLASSES} />
          <DropdownMenuItem
            className={ITEM_CLASSES}
            onSelect={() => setDialog({ kind: "destination", resume: null })}
          >
            <Settings2 aria-hidden className="size-4" />
            Change capture drive…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
