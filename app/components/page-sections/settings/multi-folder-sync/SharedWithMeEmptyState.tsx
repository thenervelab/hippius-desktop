"use client";

// "Shared with Me" with nothing in it yet: what a shared drive is for, the
// way to share one, and the docs. The app's framed empty-state card, the
// same one an empty drive list uses, with the teamwork picture above it.

import React from "react";
import { ArrowUpRight, Plus } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import NoEntriesFound from "@/components/ui/NoEntriesFound";

export const SHARED_WITH_ME_EMPTY_TITLE = "A place for teamwork";
export const SHARED_WITH_ME_EMPTY_LINE =
  "Share a drive to work on the same encrypted files with your team.";
export const SHARE_A_DRIVE_LABEL = "Share a drive";
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

export default function SharedWithMeEmptyState({ onShareDrive }: { onShareDrive: () => void }) {
  return (
    <section aria-labelledby="shared-with-me-empty-title" className="p-3">
      <NoEntriesFound
        cardView
        // The page's own padding scales up to 80px on wide screens; inside a
        // section card that is a lot of frame around one short line.
        className="p-4 sm:p-8 2xl:p-10"
        titleId="shared-with-me-empty-title"
        illustration={<TeamworkIllustration />}
        title={SHARED_WITH_ME_EMPTY_TITLE}
        description={SHARED_WITH_ME_EMPTY_LINE}
        buttonText={SHARE_A_DRIVE_LABEL}
        buttonIcon={<Plus className="size-4" aria-hidden />}
        onButtonClick={onShareDrive}
        footerLink={
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
        }
      />
    </section>
  );
}
