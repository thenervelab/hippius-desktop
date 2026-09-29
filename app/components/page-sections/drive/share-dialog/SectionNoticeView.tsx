"use client";

// How each section shows a refusal, inline under the controls it is about.
// The kinds come from `noticeForError`, which routes on Rust's structured
// subkinds; the words for the "coming soon" ones are pinned to Rust's.

import React from "react";
import { Users } from "lucide-react";
import { Button, Skeleton } from "@/components/ui";
import { cn } from "@/lib/utils";
import { COMING_SOON_COPY } from "../shareDriveModalState";
import { InlineNotice } from "./InlineNotice";
import type { SectionNotice } from "./shareDialogState";

const actionClass = "h-[30px] rounded-[6px] px-3 text-xs font-medium";

/**
 * The plan prompt. Sharing (email invites, invite links, anything that adds
 * people) is on Plus, Max and Scale; Rust decides who that is
 * (`canShareDrives`) and the server's 403 `shared_drives_not_entitled`
 * lands here too. People already shared with keep their access, and the
 * owner can still see and remove them, which the body says.
 */
export const NOT_ENTITLED_TITLE = "Sharing is available on Plus, Max and Scale plans.";
export const NOT_ENTITLED_BODY =
  "Upgrade to invite people and create links for your drives and folders. Anyone you've already shared with keeps their access.";
export const NOT_ENTITLED_ACTION = "Upgrade plan";

/**
 * The upgrade card that stands in for every control that adds people, for a
 * plan without sharing. A card, not a warning: nothing is wrong, the plan
 * just does not include it. Stacks on a narrow container, one row on a wide
 * one.
 */
export function NotEntitledNotice({
  onUpgrade,
  className,
}: {
  onUpgrade: () => void;
  className?: string;
}) {
  return (
    <div className={cn("@container", className)}>
      <div
        role="region"
        aria-label="Upgrade to share"
        className="flex flex-col gap-3 rounded-lg border border-primary-50/25 bg-primary-50/[0.06] p-3.5 @md:flex-row @md:items-center dark:border-primary-50/30 dark:bg-primary-50/10"
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-50/10 text-primary-50 dark:bg-primary-50/15 dark:text-primary-brand-dark"
          >
            <Users className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="break-words text-[13px] font-medium leading-5 text-grey-10 dark:text-white">
              {NOT_ENTITLED_TITLE}
            </p>
            <p className="mt-0.5 break-words text-xs leading-5 text-grey-40 dark:text-grey-dark-600">
              {NOT_ENTITLED_BODY}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="primary"
          size="auto"
          onClick={onUpgrade}
          className="h-[34px] w-full shrink-0 whitespace-nowrap rounded-[8px] px-4 text-[13px] font-medium @md:w-auto"
        >
          {NOT_ENTITLED_ACTION}
        </Button>
      </div>
    </div>
  );
}

/**
 * Stands where the add-people controls go while the plan is still loading,
 * so a Free or Starter account never sees them flash before the card, and a
 * paying account never sees the card flash before them.
 */
export function SharingActionsSkeleton({ className }: { className?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading sharing options" className={cn("space-y-2", className)}>
      <span className="sr-only">Loading sharing options…</span>
      <Skeleton width={96} height={14} className="rounded-md" />
      <Skeleton width="100%" height={34} className="rounded-[8px]" />
    </div>
  );
}

export function SectionNoticeView({
  notice,
  viewOnlyLabel,
  onViewOnly,
  onUpgrade,
  className,
}: {
  notice: SectionNotice;
  /** "Send as view only" or "Create as view only". */
  viewOnlyLabel: string;
  onViewOnly: () => void;
  onUpgrade: () => void;
  className?: string;
}) {
  switch (notice.kind) {
    case "comingSoon":
      return (
        <InlineNotice tone="info" className={className}>
          {notice.text}
        </InlineNotice>
      );
    case "folderEditor":
      return (
        <InlineNotice
          tone="info"
          className={className}
          action={
            <Button type="button" variant="primaryLight" size="auto" onClick={onViewOnly} className={actionClass}>
              {viewOnlyLabel}
            </Button>
          }
        >
          {COMING_SOON_COPY.folderEditor}
        </InlineNotice>
      );
    case "notEntitled":
      return <NotEntitledNotice onUpgrade={onUpgrade} className={className} />;
    case "error":
      return (
        <InlineNotice tone="error" className={className}>
          {notice.message}
        </InlineNotice>
      );
  }
}
