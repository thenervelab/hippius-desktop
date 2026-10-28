"use client";

// The Shared Drives page's empty and error states, in the app's framed
// empty-state card (the one an empty drive list uses):
//
// - nothing shared either way: what a shared drive is for, the way to share
//   one (or, on a plan without sharing, the plan that includes it), and the
//   docs, with the teamwork picture above it;
// - one tab empty: what would go there and, where it is this account's move,
//   the way to start;
// - a list that could not load: what happened and Try again, never an empty
//   state, because the page does not know.
//
// The words are in `sharedDrivesCopy.ts`.

import React from "react";
import { ArrowUpRight, CloudOff, Plus, RotateCw, Sparkles } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import NoEntriesFound from "@/components/ui/NoEntriesFound";

import {
  SHARE_A_DRIVE_LABEL,
  TRY_AGAIN_LABEL,
  UPGRADE_PLAN_LABEL,
  sharedDrivesEmptyCopy,
  sharedDrivesErrorCopy,
} from "./sharedDrivesCopy";
import type { SharedDrivesFilter } from "./sharedDrivesState";

export {
  SHARE_A_DRIVE_EMPTY_LINE,
  SHARE_A_DRIVE_EMPTY_TITLE,
  SHARE_A_DRIVE_LABEL,
} from "./sharedDrivesCopy";
export const SHARED_DRIVES_DOCS_URL = "https://docs.hippius.com/use/desktop/shared-drives";

/** Two drives' worth of files side by side over a shared ground. */
function TeamworkIllustration() {
  return (
    <svg
      aria-hidden
      data-testid="teamwork-illustration"
      viewBox="0 0 160 104"
      className="h-[80px] w-[124px] sm:h-[104px] sm:w-[160px]"
    >
      <rect
        x="0"
        y="0"
        width="160"
        height="104"
        rx="16"
        className="fill-primary-50/10 dark:fill-primary-brand-dark/15"
      />
      <g transform="rotate(-7 58 58)">
        <rect
          x="36"
          y="30"
          width="42"
          height="54"
          rx="6"
          strokeWidth="1.5"
          className="fill-white stroke-primary-50 dark:fill-[#161616] dark:stroke-primary-brand-dark"
        />
        <path
          d="M44 44h26M44 52h20M44 60h24"
          strokeWidth="2"
          strokeLinecap="round"
          className="stroke-primary-50/40 dark:stroke-primary-brand-dark/50"
        />
      </g>
      <g transform="rotate(7 102 58)">
        <rect
          x="82"
          y="30"
          width="42"
          height="54"
          rx="6"
          strokeWidth="1.5"
          className="fill-white stroke-primary-50 dark:fill-[#161616] dark:stroke-primary-brand-dark"
        />
        <path
          d="M90 44h26M90 52h18M90 60h24"
          strokeWidth="2"
          strokeLinecap="round"
          className="stroke-primary-50/40 dark:stroke-primary-brand-dark/50"
        />
      </g>
      <circle cx="80" cy="22" r="11" className="fill-primary-50 dark:fill-primary-brand-dark" />
      <path
        d="M75 22.5l3.5 3.5 6.5-7"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-white dark:stroke-[#161616]"
      />
    </svg>
  );
}

/** A cloud with a line through it, on the same tinted ground. */
function LoadErrorIllustration() {
  return (
    <span
      aria-hidden
      data-testid="load-error-illustration"
      className="flex size-12 items-center justify-center rounded-xl bg-grey-90 text-grey-50 dark:bg-white/[0.06] dark:text-grey-dark-700"
    >
      <CloudOff className="size-6" />
    </span>
  );
}

function DocsLink() {
  return (
    <a
      href={SHARED_DRIVES_DOCS_URL}
      // Docs open in the browser, never in the app's own webview.
      onClick={(e) => {
        e.preventDefault();
        void openUrl(SHARED_DRIVES_DOCS_URL).catch((err) =>
          console.error("Failed to open the shared drives docs:", err),
        );
      }}
      className="text-center text-primary-50 hover:underline dark:text-primary-brand-dark"
    >
      How shared drives work
      {/* Inline, so on a narrow window the arrow wraps with the last
          word instead of standing apart from it. */}
      <ArrowUpRight className="ml-1 inline size-3.5 align-[-2px]" aria-hidden />
    </a>
  );
}

// The page's own padding scales up to 80px on wide screens; inside a section
// card that is a lot of frame around one short line.
const CARD_PADDING = "p-4 sm:p-8 2xl:p-10";

export interface ShareADriveEmptyStateProps {
  /** Which list is empty: everything, or one tab. */
  scope?: SharedDrivesFilter;
  /**
   * Whether this account's plan shares drives. False words the card for
   * Free and Starter: the plan that includes sharing, and Upgrade plan in
   * place of Share a drive.
   */
  canShare?: boolean;
  onShareDrive: () => void;
  onUpgrade?: () => void;
}

export default function ShareADriveEmptyState({
  scope = "all",
  canShare = true,
  onShareDrive,
  onUpgrade,
}: ShareADriveEmptyStateProps) {
  const copy = sharedDrivesEmptyCopy(scope, canShare);
  const titleId = `shared-drives-empty-${scope}-title`;
  const action =
    copy.action === "share"
      ? { text: SHARE_A_DRIVE_LABEL, icon: <Plus className="size-4" aria-hidden />, onClick: onShareDrive }
      : copy.action === "upgrade" && onUpgrade
        ? { text: UPGRADE_PLAN_LABEL, icon: <Sparkles className="size-4" aria-hidden />, onClick: onUpgrade }
        : null;

  return (
    <section aria-labelledby={titleId} data-testid={`shared-drives-empty-${scope}`} className="p-3">
      <NoEntriesFound
        cardView
        className={CARD_PADDING}
        titleId={titleId}
        illustration={<TeamworkIllustration />}
        title={copy.title}
        description={copy.description}
        buttonText={action?.text}
        buttonIcon={action?.icon}
        onButtonClick={action?.onClick}
        footerLink={<DocsLink />}
      />
    </section>
  );
}

/**
 * The list could not be loaded. Says what happened in plain words and
 * offers Try again; the page also retries by itself when the connection
 * comes back.
 */
export function SharedDrivesLoadError({
  scope = "all",
  offline,
  onRetry,
}: {
  scope?: SharedDrivesFilter;
  offline: boolean;
  onRetry: () => void;
}) {
  const copy = sharedDrivesErrorCopy(scope, offline);
  const titleId = `shared-drives-error-${scope}-title`;
  return (
    <section aria-labelledby={titleId} role="alert" data-testid="shared-drives-error" className="p-3">
      <NoEntriesFound
        cardView
        className={CARD_PADDING}
        titleId={titleId}
        illustration={<LoadErrorIllustration />}
        title={copy.title}
        description={copy.description}
        buttonText={TRY_AGAIN_LABEL}
        buttonIcon={<RotateCw className="size-4" aria-hidden />}
        onButtonClick={onRetry}
      />
    </section>
  );
}
