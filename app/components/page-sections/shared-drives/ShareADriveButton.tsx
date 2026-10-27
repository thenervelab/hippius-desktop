"use client";

// "Share a drive" in the Shared Drives page header, by plan:
//
// - a plan that shares: the filled button that opens the picker;
// - Free or Starter: the same words with the plan that includes sharing on
//   a pill ("Plus"), a hover that says which plans, and a click that goes
//   to Settings > Billing, where every Drive upgrade prompt in the app goes.
//   Never a "Share a drive" that opens a picker only to refuse at the end;
// - plan not known yet: a placeholder of the button's size, so neither
//   version flashes before the other.
//
// The rule is Rust's (`canShareDrives`); `sharingGate` only reads it.

import React from "react";
import { Plus, Sparkles } from "lucide-react";

import { Skeleton } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { SharingGate } from "@/components/page-sections/drive/share-dialog/shareDialogState";

import { SHARE_A_DRIVE_LABEL, SHARING_PLAN_PILL, SHARING_UPGRADE_HINT } from "./sharedDrivesCopy";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-primary-brand-dark dark:focus-visible:ring-offset-black-primary-bg";

export default function ShareADriveButton({
  gate,
  onShare,
  onUpgrade,
}: {
  gate: SharingGate;
  onShare: () => void;
  onUpgrade: () => void;
}) {
  if (gate === "loading") {
    return (
      <span role="status" aria-label="Loading sharing options" data-testid="share-a-drive-placeholder">
        <Skeleton width={132} height={32} className="rounded-md" />
      </span>
    );
  }

  if (gate === "allowed") {
    return (
      <Button type="button" variant="primary" size="sm" onClick={onShare} className={`gap-1.5 px-3.5 font-medium ${FOCUS_RING}`}>
        <Plus className="size-4" aria-hidden />
        {SHARE_A_DRIVE_LABEL}
      </Button>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="primaryOutline"
            size="sm"
            onClick={onUpgrade}
            // The accessible name says the requirement and where the click
            // goes, since the pill alone reads as just "Plus".
            aria-label={`${SHARE_A_DRIVE_LABEL}. ${SHARING_UPGRADE_HINT}`}
            data-testid="share-a-drive-upgrade"
            className={`gap-1.5 px-3 font-medium ${FOCUS_RING}`}
          >
            <Sparkles className="size-4" aria-hidden />
            {SHARE_A_DRIVE_LABEL}
            <span
              aria-hidden
              className="ml-0.5 rounded-full bg-primary-50 px-1.5 py-px text-[11px] font-semibold leading-4 text-white dark:bg-primary-brand-dark dark:text-black-primary-bg"
            >
              {SHARING_PLAN_PILL}
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="end"
          className="max-w-[260px] bg-grey-10 text-white dark:bg-white dark:text-grey-10"
        >
          {SHARING_UPGRADE_HINT}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
