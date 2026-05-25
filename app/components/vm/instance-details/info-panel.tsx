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
 * Header is a top-rounded shell with `border-b-0`; the body is a fully
 * rounded sibling pulled up by `-mt-2` so the two borders visually merge
 * into one rounded outline instead of doubling up at the corners. Same
 * pattern as the VM list / Create VM toolbars.
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
    <div className={cn("flex flex-col", className)}>
      <div className="flex h-[54px] items-center justify-between gap-2 rounded-t-[8px] border border-b-0 border-grey-dark-100 bg-grey-light-300 pl-[14px] pr-[10px] pt-[8px] pb-[16px] dark:border-black-300 dark:bg-black-primary-bg">
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
          "-mt-2 rounded-[8px] border border-grey-dark-100 bg-grey-light-100 px-[16px] py-[12px] dark:border-black-300 dark:bg-black-600",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
};

export default InfoPanel;
