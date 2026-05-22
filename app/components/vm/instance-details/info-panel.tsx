import React from "react";
import { cn } from "@/lib/utils";

interface InfoPanelProps {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}

/**
 * Two-layer card used across the Dashboard tab.
 *
 * Outer shell holds the uppercase mono label + optional action; the inner
 * panel (same `rounded-[8px]` radius) overlays the bottom of the shell so the
 * outer border only shows as a thin strip behind the header.
 */
const InfoPanel: React.FC<InfoPanelProps> = ({
  label,
  icon,
  children,
  action,
  className,
  bodyClassName,
}) => {
  return (
    <div
      className={cn(
        "flex flex-col rounded-[8px] border border-grey-dark-100 bg-grey-light-300 dark:border-black-300 dark:bg-black-primary-bg",
        className,
      )}
    >
      <div className="flex h-[46px] items-center justify-between gap-2 pl-[14px] pr-[10px] py-[8px]">
        <div className="flex min-w-0 items-center gap-[6px]">
          <span className="shrink-0 text-primary-40 dark:text-primary-65">
            {icon}
          </span>
          <span className="truncate font-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-65">
            {label}
          </span>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div
        className={cn(
          "rounded-[8px] border border-grey-dark-100 bg-grey-light-100 px-[16px] py-[12px] dark:border-black-300 dark:bg-black-600",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
};

export default InfoPanel;
