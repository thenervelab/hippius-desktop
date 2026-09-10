"use client";

import React, { useCallback, useEffect, useState } from "react";
import { FolderOpen, Loader2, X } from "lucide-react";
import Link from "next/link";

import { cn } from "@/app/lib/utils";
import { useDriveServiceStatus } from "@/app/lib/hooks/useDriveServiceStatus";
import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";

import {
  getDriveStatusBanner,
  type DriveStatusBanner as DriveStatusBannerContent,
} from "./driveStatusBannerState";

/**
 * Tone styling, shared with the web console's `ServiceStatusBanner` so a
 * cancelled plan looks the same in both places.
 *
 * A tinted frame with a soft glow and a solid badge, rather than a flat
 * block of colour: the earlier version painted the whole banner in
 * `warning/10` with a matching border, which reads as a filled alert box
 * and shouts louder than a cancelled plan warrants. Here the colour is
 * concentrated in the badge and fades out across the frame, so the tone
 * is legible without the banner dominating the page it sits above.
 */
const TONE = {
  info: {
    frame:
      "border-primary-50/20 dark:border-primary-50/25 bg-gradient-to-r from-primary-50/[0.08] via-primary-50/[0.03] to-transparent dark:from-primary-50/[0.16] dark:via-primary-50/[0.06] dark:to-transparent",
    glow: "bg-primary-50/20 dark:bg-primary-50/15",
    badge: "bg-primary-50 text-white",
    action: "text-primary-50 hover:text-primary-40",
  },
  warning: {
    frame:
      "border-warning-50/30 dark:border-warning-50/30 bg-gradient-to-r from-warning-50/[0.10] via-warning-50/[0.04] to-transparent dark:from-warning-50/[0.18] dark:via-warning-50/[0.06] dark:to-transparent",
    glow: "bg-warning-50/20 dark:bg-warning-50/15",
    badge: "bg-warning-50 text-white",
    action: "text-warning-50 hover:text-warning-40",
  },
  // Reserved for a state that is LOSING the user something, so it does
  // not look like a plan that is merely setting itself up.
  danger: {
    frame:
      "border-error-50/30 dark:border-error-50/30 bg-gradient-to-r from-error-50/[0.10] via-error-50/[0.04] to-transparent dark:from-error-50/[0.18] dark:via-error-50/[0.06] dark:to-transparent",
    glow: "bg-error-50/20 dark:bg-error-50/15",
    badge: "bg-error-50 text-white",
    action: "text-error-50 hover:text-error-40",
  },
} as const;

/**
 * The banner itself: tone, badge, copy, optional action, optional
 * dismissal. Purely presentational and content-agnostic, so any page can
 * draw the same frame from its own resolver — the Overview page uses it
 * for the no-plan state without inheriting the Drive page's billing
 * states.
 *
 * Renders nothing when there is nothing to say, so it can be mounted
 * unconditionally.
 *
 * `className` carries the caller's own spacing: this component ships
 * none, because the Drive page and the Overview page sit in wrappers
 * with different horizontal padding and a baked-in `mx-3` double-indents
 * one of them.
 */
export const StatusBanner: React.FC<{
  banner: DriveStatusBannerContent | null;
  className?: string;
}> = ({ banner, className }) => {
  const dismissKey = banner?.dismissKey;

  // Read once on mount rather than during render: localStorage is
  // unavailable in some contexts and throws, and a banner is not worth
  // failing a page for.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!dismissKey) return;
    try {
      setDismissed(window.localStorage.getItem(dismissKey) === "1");
    } catch {
      setDismissed(false);
    }
  }, [dismissKey]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (!dismissKey) return;
    try {
      window.localStorage.setItem(dismissKey, "1");
    } catch {
      // A dismissal that cannot be remembered is still worth honouring
      // for this session.
    }
  }, [dismissKey]);

  if (!banner || dismissed) return null;

  const styles = TONE[banner.tone];
  // A plan still being provisioned resolves on its own, so the badge shows
  // progress rather than the product mark — the page around it already
  // says this is Drive, and the spinner is the useful half.
  const busy = banner.tone === "info";

  return (
    <div
      role="status"
      className={cn(
        "relative overflow-hidden rounded-[10px] border px-4 py-3.5 sm:px-5",
        styles.frame,
        className,
      )}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -left-10 -top-14 size-36 rounded-full blur-3xl",
          styles.glow,
        )}
      />

      <div className="relative flex items-start gap-3.5">
        <span
          className={cn(
            "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[8px] shadow-[inset_0_-2px_0_0_rgba(0,0,0,0.14)]",
            styles.badge,
          )}
        >
          {busy ? (
            <Loader2 aria-hidden className="size-[18px] motion-safe:animate-spin" />
          ) : (
            <FolderOpen aria-hidden className="size-[18px]" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold leading-5 tracking-[-0.28px] text-grey-10 dark:text-white">
            {banner.title}
          </h3>
          <p className="mt-1 text-[13px] font-medium leading-5 tracking-[-0.26px] text-grey-60 dark:text-[#c4c4c4]">
            {banner.description}
          </p>
          {banner.action && (
            /* A text link, not a button: the banner is telling the user
               something, and a filled button competes with the page's own
               actions for the same glance. */
            <Link
              href={banner.action.href}
              className={cn(
                "mt-2 inline-block text-[13px] font-semibold tracking-[-0.26px] underline underline-offset-2 transition-colors",
                styles.action,
              )}
            >
              {banner.action.label}
            </Link>
          )}
        </div>

        {banner.dismissKey && (
          <button
            type="button"
            onClick={dismiss}
            aria-label={`Dismiss ${banner.title}`}
            className="-mr-1 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-[6px] text-grey-50 transition-colors hover:bg-grey-10/10 hover:text-grey-10 dark:text-[#a3a3a3] dark:hover:bg-white/5 dark:hover:text-white"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * What Drive wants the user to know about their plan, on the Drive page.
 *
 * Scoped to this page on purpose, the way the console scopes it: a Drive
 * problem belongs where the user can act on it and where the rest of the
 * screen gives it context.
 */
const DriveStatusBanner: React.FC<{ className?: string }> = ({ className }) => {
  const { data } = useDriveServiceStatus();
  // The capacity decision comes from Rust; an account with none of it
  // gets the loudest banner here, ahead of any billing state.
  const { data: overview } = useStorageOverview();

  return (
    <StatusBanner
      banner={getDriveStatusBanner(data, overview?.source)}
      className={cn("mx-3 mb-3", className)}
    />
  );
};

export default DriveStatusBanner;
