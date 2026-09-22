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
      <DropdownMenuContent align="end" aria-label="Capture">
        {ITEMS.map(({ mode, label, icon: Icon }) => (
          <DropdownMenuItem key={mode} onSelect={() => void startCapture(mode)}>
            <Icon className="size-4" />
            {label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setDialog({ kind: "destination", resumeMode: null })}>
          <Settings2 className="size-4" />
          Change capture drive…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
