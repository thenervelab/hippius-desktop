import React from "react";

interface SettingsCardProps {
  label: string;
  children: React.ReactNode;
}

export function SettingsCard({ label, children }: SettingsCardProps) {
  return (
    <div className="rounded-[8px] border overflow-hidden bg-grey-light-300 border-grey-dark-100 dark:bg-black-primary-bg dark:border-black-300 shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]">
      <div className="flex h-[46px] w-full items-center pl-[14px] pr-[10px]">
        <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
          {label}
        </p>
      </div>
      <div className="rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300">
        {children}
      </div>
    </div>
  );
}
