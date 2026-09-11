"use client";

import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HostedBy } from "@/app/lib/types/sync-folder";

/**
 * Why a sync root inside another cloud provider's folder, or a macOS
 * special folder, behaves differently for Finder.
 *
 * The classification is Rust's (`sync::root_host`); this only says it,
 * in one place, for the folder row and the add-folder dialog.
 */
export function hostedRootMessage(host: HostedBy): string {
  if (host.kind === "fileProvider") {
    return `This folder is inside ${host.name}. Finder badges and “Share with Hippius” are unavailable here, and syncing waits for ${host.name} to download each file first.`;
  }
  return `Finder may not show badges or “Share with Hippius” on ${host.name} — macOS treats that folder as special.`;
}

export default function HostedRootNote({
  host,
  className,
}: {
  host: HostedBy;
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
      <span>{hostedRootMessage(host)}</span>
    </p>
  );
}
