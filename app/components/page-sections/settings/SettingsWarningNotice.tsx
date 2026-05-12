import React from "react";

interface SettingsWarningNoticeProps {
  title: string;
  description: React.ReactNode;
}

/**
 * Yellow warning callout used across settings sections (API Token,
 * Security, etc.). Content-hugging width, 8px padding, no corner dots
 * — matches Figma 4045:136039.
 */
export function SettingsWarningNotice({ title, description }: SettingsWarningNoticeProps) {
  return (
    <div className="w-fit rounded-[6px] border border-[#feb101] bg-[rgba(254,177,1,0.16)] dark:bg-[rgba(254,177,1,0.10)] p-[8px] flex flex-col gap-[8px]">
      <p className="font-geist text-[14px] leading-[1.109] tracking-[-0.28px] font-medium text-black dark:text-white">
        {title}
      </p>
      <p className="font-geist text-[14px] leading-[1.109] tracking-[-0.28px] font-medium text-[#7d7d7d] dark:text-grey-dark-600">
        {description}
      </p>
    </div>
  );
}
