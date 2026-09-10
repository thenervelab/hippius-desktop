import React from "react";
import { cn } from "@/lib/utils";
import { OctagonAlert } from "@/components/ui/icons";

interface SettingsWarningNoticeProps {
  title: string;
  description: React.ReactNode;
  /** Optional icon rendered in the leading chip. Defaults to OctagonAlert. */
  icon?: React.ReactNode;
  /** Override outer classes — e.g. extra margin at a call site. */
  className?: string;
}

/**
 * Standing security notice on settings pages (API Token, Security).
 * Same chrome as SecurityRow, with an amber chip so it still reads as a warning.
 */
export function SettingsWarningNotice({
  title,
  description,
  icon,
  className,
}: SettingsWarningNoticeProps) {
  return (
    <div
      role="note"
      className={cn(
        "w-full rounded-[8px] border border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300 px-4 py-3 flex items-start gap-3",
        className
      )}
    >
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning-50/15"
        aria-hidden="true"
      >
        {icon ?? (
          <OctagonAlert className="size-4 text-warning-40 dark:text-warning-50" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-grey-10 dark:text-white">
          {title}
        </p>
        <p className="text-sm text-[#7D7D7D] dark:text-grey-dark-600 mt-1">
          {description}
        </p>
      </div>
    </div>
  );
}
