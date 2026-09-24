"use client";

// How each section shows a refusal, inline under the controls it is about.
// The kinds come from `noticeForError`, which routes on Rust's structured
// subkinds; the words for the "coming soon" ones are pinned to Rust's.

import React from "react";
import { Button } from "@/components/ui";
import { COMING_SOON_COPY } from "../shareDriveModalState";
import { InlineNotice } from "./InlineNotice";
import type { SectionNotice } from "./shareDialogState";

const actionClass = "h-[30px] rounded-[6px] px-3 text-xs font-medium";

/** The plan prompt, shared by both sections and by a known-unentitled plan. */
export const NOT_ENTITLED_TITLE = "Sharing needs a Plus, Max or Scale plan";
export const NOT_ENTITLED_BODY =
  "Upgrade your plan to share drives and folders. Anyone you've already shared with keeps their access.";

export function NotEntitledNotice({
  onUpgrade,
  className,
}: {
  onUpgrade: () => void;
  className?: string;
}) {
  return (
    <InlineNotice
      tone="info"
      className={className}
      action={
        <Button type="button" variant="primary" size="auto" onClick={onUpgrade} className={actionClass}>
          Upgrade plan
        </Button>
      }
    >
      <span className="block font-medium text-grey-10 dark:text-white">{NOT_ENTITLED_TITLE}</span>
      {NOT_ENTITLED_BODY}
    </InlineNotice>
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
