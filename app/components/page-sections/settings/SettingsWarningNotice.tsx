import React from "react";
import { cn } from "@/lib/utils";

interface SettingsWarningNoticeProps {
  title: string;
  description: React.ReactNode;
  /** Optional icon rendered before the title (e.g. OctagonAlert). */
  icon?: React.ReactNode;
  /** Override outer classes — e.g. swap the default w-fit for w-full inside dialogs. */
  className?: string;
}

/**
 * Yellow warning callout used across settings sections (API Token,
 * Security, Set Unlock Password dialog, etc.). Content-hugging by
 * default; pass `className="w-full"` when used inside a container that
 * should stretch it. Matches Figma 4045:136039.
 */
export function SettingsWarningNotice({
  title,
  description,
  icon,
  className,
}: SettingsWarningNoticeProps) {
  return (
    <div
      className={cn(
        "w-fit rounded-[6px] border border-[#feb101] bg-[rgba(254,177,1,0.16)] dark:bg-[rgba(254,177,1,0.10)] p-[8px] flex flex-col gap-[8px]",
        className
      )}
    >
      <div className="flex items-center gap-[6px]">
        {icon && <span className="flex-shrink-0">{icon}</span>}
        <p className="font-geist text-[14px] leading-[1.109] tracking-[-0.28px] font-medium text-black dark:text-white">
          {title}
        </p>
      </div>
      <p className="font-geist text-[14px] leading-[1.109] tracking-[-0.28px] font-medium text-[#7d7d7d] dark:text-grey-dark-600">
        {description}
      </p>
    </div>
  );
}
