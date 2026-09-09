"use client";

import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Why a sync root inside another cloud provider's folder behaves differently.
 *
 * macOS never renders a Finder Sync extension on a File Provider path, so
 * inside Google Drive / Dropbox / OneDrive / iCloud Drive there is no
 * "Share with Hippius" item and no badge no matter how the extension is
 * configured — and every scan first makes that provider download its
 * placeholder files. The classification is Rust's (`sync::root_host`); this
 * only says it, in one place, for the folder row and the add-folder dialog.
 */
export function hostedRootMessage(provider: string): string {
  return `This folder is inside ${provider}. Finder badges and “Share with Hippius” are unavailable here, and syncing waits for ${provider} to download each file first.`;
}

export default function HostedRootNote({
  provider,
  className,
}: {
  provider: string;
  className?: string;
}) {
  return (
    <p
      role="note"
      className={cn(
        "flex items-start gap-1.5 text-xs leading-snug text-grey-50 dark:text-grey-dark-600",
        className
      )}
    >
      <Info className="mt-0.5 size-3.5 flex-shrink-0 text-warning-50" aria-hidden="true" />
      <span>{hostedRootMessage(provider)}</span>
    </p>
  );
}
