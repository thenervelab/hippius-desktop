"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { AppWindow, Camera, Monitor, Scan, Settings2 } from "lucide-react";

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
import type { CaptureMode } from "@/app/lib/tauri/capture";
import { SECONDARY_PILL_CLASSES } from "@/app/components/page-sections/drive/uploadActions";

// Explicit colours, as every menu in the app sets them: the shared
// DropdownMenuContent's base is `bg-popover`, a token this theme does not
// define, so an unstyled menu has no background at all and its items sit
// unreadable over whatever is behind it — invisible in dark mode.
const CONTENT_CLASSES = cn(
  "min-w-[13rem] rounded-lg p-1.5",
  "bg-white border border-grey-80",
  "dark:bg-black-500 dark:border-black-300",
  "shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] dark:shadow-[0px_12px_32px_8px_rgba(0,0,0,0.3)]",
);
const ITEM_CLASSES = cn(
  "flex items-center gap-2.5 rounded-md px-1.5 py-1.5",
  "font-geist text-[14px] font-medium tracking-[-0.4px]",
  "text-[#52525C] hover:bg-grey-90 hover:text-grey-10",
  "dark:text-grey-dark-200 dark:hover:bg-white/5 dark:hover:text-grey-light-100",
);
const SEPARATOR_CLASSES = "my-1 h-px bg-grey-80 dark:bg-black-300";

const ITEMS: { mode: CaptureMode; label: string; icon: typeof Scan }[] = [
  { mode: "area", label: "Capture area", icon: Scan },
  { mode: "window", label: "Capture window", icon: AppWindow },
  { mode: "screen", label: "Capture full screen", icon: Monitor },
];

/**
 * The Drive header's Capture menu: screenshot an area, a window or a screen,
 * straight into the drive with the link copied.
 *
 * Renders nothing unless the feature is on for this lane AND Rust says this
 * platform can capture — a menu whose every item fails is worse than none.
 */
export default function CaptureMenu({ className }: { className?: string }) {
  const supported = useAtomValue(captureSupportedAtom);
  const setDialog = useSetAtom(captureDialogAtom);
  const startCapture = useStartCapture();

  if (!SCREEN_CAPTURE_ENABLED || !supported) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="defaultStable"
          size="auto"
          className={cn(SECONDARY_PILL_CLASSES, className)}
          title="Take a screenshot"
        >
          <Camera className="size-4 shrink-0" />
          Capture
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Capture" className={CONTENT_CLASSES}>
        {ITEMS.map(({ mode, label, icon: Icon }) => (
          <DropdownMenuItem key={mode} className={ITEM_CLASSES} onSelect={() => void startCapture(mode)}>
            <Icon className="size-4" />
            {label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator className={SEPARATOR_CLASSES} />
        <DropdownMenuItem
          className={ITEM_CLASSES}
          onSelect={() => setDialog({ kind: "destination", resumeMode: null })}
        >
          <Settings2 className="size-4" />
          Change capture drive…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
