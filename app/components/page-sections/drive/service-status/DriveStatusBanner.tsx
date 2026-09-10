"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/app/lib/utils";
import { useDriveServiceStatus } from "@/app/lib/hooks/useDriveServiceStatus";

import { getDriveStatusBanner } from "./driveStatusBannerState";

/**
 * What Drive wants the user to know about their plan, on the Drive page.
 *
 * Scoped to this page on purpose, the way the console scopes it: a Drive
 * problem belongs where the user can act on it and where the rest of the
 * screen gives it context.
 *
 * Renders nothing when there is nothing to say, so it can be mounted
 * unconditionally.
 */
const DriveStatusBanner: React.FC<{ className?: string }> = ({ className }) => {
  const { data } = useDriveServiceStatus();
  const banner = getDriveStatusBanner(data);
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

  const warning = banner.tone === "warning";

  return (
    <div
      role="status"
      className={cn(
        "mx-3 mb-3 flex items-start gap-2.5 rounded-[8px] border px-3.5 py-3",
        warning
          ? "border-warning-50/40 bg-warning-50/10"
          : "border-primary-50/30 bg-primary-50/5",
        className,
      )}
    >
      {warning ? (
        <AlertTriangle
          className="mt-[2px] size-[18px] shrink-0 text-warning-40 dark:text-warning-50"
          aria-hidden="true"
        />
      ) : (
        <Loader2
          className="mt-[2px] size-[18px] shrink-0 animate-spin text-primary-50 dark:text-primary-brand-dark"
          aria-hidden="true"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-[14px] font-medium leading-[20px] text-grey-10 dark:text-white">
          {banner.title}
        </p>
        <p className="text-[13px] font-medium leading-[19px] text-grey-50 dark:text-grey-dark-500">
          {banner.description}
        </p>
      </div>

      {banner.action && (
        <Button
          asLink
          href={banner.action.href}
          variant="defaultStable"
          size="auto"
          className="mt-[1px] h-[30px] shrink-0 rounded-[6px] px-3 text-[13px] font-medium"
        >
          {banner.action.label}
        </Button>
      )}

      {banner.dismissKey && (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="mt-[1px] shrink-0 rounded p-0.5 text-grey-60 opacity-70 transition-opacity hover:opacity-100 dark:text-grey-dark-600"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
};

export default DriveStatusBanner;
