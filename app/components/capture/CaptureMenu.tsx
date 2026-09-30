"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { Camera, Settings2, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";
import {
  captureDialogAtom,
  captureRecordingAtom,
  captureRecordingNoteAtom,
  captureSupportedAtom,
} from "@/app/lib/capture/captureFlow";
import { useStartCapture } from "@/app/lib/capture/useStartCapture";
import { acceleratorKeys, isMacPlatform } from "@/app/lib/capture/shortcutLabel";
import ShortcutKeys from "./ShortcutKeys";
import { getCaptureShortcut } from "@/app/lib/tauri/capture";
import { MENU_MODES, MODE_ICON, modeLabel } from "@/app/lib/capture/modes";
import { SECONDARY_PILL_CLASSES } from "@/app/components/page-sections/drive/uploadActions";

// Explicit colours, as every menu in the app sets them: the shared
// DropdownMenuContent's base is `bg-popover`, a token this theme does not
// define, so an unstyled menu has no background at all and its items sit
// unreadable over whatever is behind it — invisible in dark mode.
const CONTENT_CLASSES = cn(
  "min-w-[15rem] rounded-lg p-1.5",
  "bg-white border border-grey-80",
  "dark:bg-black-500 dark:border-black-300",
  "shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] dark:shadow-[0px_12px_32px_8px_rgba(0,0,0,0.3)]",
);
const ITEM_CLASSES = cn(
  "flex items-center gap-2.5 rounded-md px-1.5 py-1.5",
  "font-geist text-[14px] font-medium tracking-[-0.4px]",
  "text-grey-50 hover:bg-grey-90 hover:text-grey-10",
  "dark:text-grey-dark-200 dark:hover:bg-white/5 dark:hover:text-grey-light-100",
);
const LABEL_CLASSES = cn(
  "px-1.5 py-1 font-geist text-[11px] font-semibold uppercase tracking-[0.04em]",
  "text-grey-50 dark:text-grey-dark-600",
);
const SEPARATOR_CLASSES = "my-1 h-px bg-grey-80 dark:bg-black-300";
// Why the Record items below it are disabled; wraps on a narrow window.
const NOTE_CLASSES = cn(
  "max-w-[15rem] px-1.5 pb-1 font-geist text-[12px] leading-snug",
  "text-grey-50 dark:text-grey-dark-600",
);


/**
 * The Drive header's Capture menu. "Open capture bar" (and the system-wide
 * shortcut it shows) opens the bar on whatever was used last; each item below
 * opens it with that mode already chosen. Everything lands in the drive with
 * the link copied. Items use the bar's own names and icons
 * (`app/lib/capture/modes.ts`), so a mode reads the same in both places.
 *
 * Renders nothing unless the feature is on for this lane AND Rust says this
 * platform can capture — a menu whose every item fails is worse than none.
 * Record items work when `capture_support.recording` is true (macOS 13+ with
 * the helper built). On a Mac without the helper or without macOS 13 they are
 * listed disabled under Rust's reason, so a build that lacks recording says
 * so; where the platform has no recorder they are left out.
 */
export default function CaptureMenu({ className, iconClassName }: { className?: string; iconClassName?: string }) {
  const supported = useAtomValue(captureSupportedAtom);
  const recording = useAtomValue(captureRecordingAtom);
  const recordingNote = useAtomValue(captureRecordingNoteAtom);
  const setDialog = useSetAtom(captureDialogAtom);
  const startCapture = useStartCapture();
  const [shortcut, setShortcut] = useState<string[]>([]);

  useEffect(() => {
    if (!SCREEN_CAPTURE_ENABLED || !supported) return;
    getCaptureShortcut()
      .then((s) => setShortcut(s.accelerator ? acceleratorKeys(s.accelerator, isMacPlatform()) : []))
      .catch(() => setShortcut([]));
  }, [supported]);

  if (!SCREEN_CAPTURE_ENABLED || !supported) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="defaultStable"
          size="auto"
          className={cn(SECONDARY_PILL_CLASSES, className)}
          title="Take a screenshot or start a recording"
        >
          <Camera className={cn("size-4 shrink-0", iconClassName)} />
          Capture
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label="Capture" className={CONTENT_CLASSES}>
        <DropdownMenuItem className={ITEM_CLASSES} onSelect={() => void startCapture()}>
          <Camera className="size-4" />
          <span className="flex-1">Open capture bar</span>
          <ShortcutKeys keys={shortcut} className="ml-4" />
        </DropdownMenuItem>
        <DropdownMenuSeparator className={SEPARATOR_CLASSES} />
        <DropdownMenuLabel className={LABEL_CLASSES}>Screenshot</DropdownMenuLabel>
        {MENU_MODES.map((mode) => {
          const Icon = MODE_ICON[mode];
          return (
            <DropdownMenuItem
              key={`shot-${mode}`}
              className={ITEM_CLASSES}
              onSelect={() => void startCapture("screenshot", mode)}
            >
              <Icon className="size-4" />
              {modeLabel("screenshot", mode)}
            </DropdownMenuItem>
          );
        })}
        {(recording || recordingNote) && (
          <>
            <DropdownMenuSeparator className={SEPARATOR_CLASSES} />
            <DropdownMenuLabel className={LABEL_CLASSES}>
              <span className="inline-flex items-center gap-1.5">
                <Video className="size-3" />
                Record
              </span>
            </DropdownMenuLabel>
            {!recording && recordingNote && (
              <p className={NOTE_CLASSES}>{recordingNote}</p>
            )}
            {MENU_MODES.map((mode) => {
              const Icon = MODE_ICON[mode];
              return (
                <DropdownMenuItem
                  key={`rec-${mode}`}
                  className={ITEM_CLASSES}
                  // A disabled item takes no pointer, so the line above says why.
                  disabled={!recording}
                  onSelect={() => void startCapture("recording", mode)}
                >
                  <Icon className="size-4" />
                  {modeLabel("recording", mode)}
                </DropdownMenuItem>
              );
            })}
          </>
        )}
        <DropdownMenuSeparator className={SEPARATOR_CLASSES} />
        <DropdownMenuItem
          className={ITEM_CLASSES}
          onSelect={() => setDialog({ kind: "destination", resume: null })}
        >
          <Settings2 className="size-4" />
          Change capture drive…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
