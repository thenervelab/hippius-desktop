import React from "react";

interface SettingsCardProps {
  label: string;
  icon?: React.ReactNode;
  /**
   * Optional element rendered to the right of the header label (e.g. an
   * Edit Name or + Add Folder button). Sits vertically centered in the
   * 38px header strip.
   */
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}

export function SettingsCard({
  label,
  icon,
  headerAction,
  children,
}: SettingsCardProps) {
  return (
    <div className="rounded-[8px] border overflow-hidden bg-grey-light-300 border-grey-dark-100 dark:bg-black-primary-bg dark:border-black-300 shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]">
      <div className="flex h-[38px] w-full items-center justify-between gap-2 pl-[14px] pr-[10px]">
        <div className="flex items-center gap-2 min-w-0">
          {icon && (
            <span className="text-primary-40 dark:text-primary-brand-dark flex-shrink-0 inline-flex">
              {icon}
            </span>
          )}
          <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase truncate">
            {label}
          </p>
        </div>
        {headerAction && (
          <div className="flex-shrink-0 inline-flex items-center">
            {headerAction}
          </div>
        )}
      </div>
      <div className="rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300">
        {children}
      </div>
    </div>
  );
}
