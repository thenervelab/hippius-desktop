/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import { cn } from "@/lib/utils";
import { middleTruncate } from "@/lib/utils/middleTruncate";
import ActiveTabBg from "./ActiveTabBg";
import * as Tooltip from "@radix-ui/react-tooltip";

export interface TabItemProps {
  label: string;
  /** Value for `data-tab-label`. Falls back to `label`. */
  dataLabel?: string;
  icon?: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
  width?: string;
  height?: string;
  isJustifyStart?: boolean;
  showTooltip?: boolean;
  iconOnly?: boolean;
}

const TabItem: React.FC<TabItemProps> = ({
  label,
  dataLabel,
  icon,
  isActive,
  onClick,
  width = "min-w-[9.25rem]",
  height = "h-[2.25rem]",
  isJustifyStart = false,
  showTooltip = true,
  iconOnly = false,
}) => {
  /** At text-[0.875rem] with px-4 inside max-w-[15rem], ~24 chars fit. */
  const TAB_MAX_CHARS = 24;
  const displayLabel = middleTruncate(label, TAB_MAX_CHARS);
  const isTruncated = displayLabel !== label;

  const content = (
    <div
      data-tab-label={dataLabel ?? label}
      className={cn(
        "flex items-center gap-2 relative transition-all duration-300 cursor-pointer",
        iconOnly ? "w-[2.5rem] justify-center" : width,
        height,
        isActive ? "text-primary-50" : "text-grey-70",
        !iconOnly && (isJustifyStart ? "px-2" : "px-4")
      )}
      onClick={onClick}
    >
      {isActive && <ActiveTabBg mainGroup={true} />}
      <div
        className={cn(
          "relative z-10 flex items-center justify-center gap-2 w-full min-w-0",
          isActive ? "text-primary-50" : "text-grey-70 hover:text-primary-50",
          !iconOnly && (isJustifyStart ? "justify-start" : "justify-center")
        )}
      >
        <span className="flex-shrink-0">
          {icon &&
            React.cloneElement(icon as React.ReactElement<any>, {
              className: "size-[1.125rem]",
            })}
        </span>
        {!iconOnly && (
          <span className="font-medium text-[0.875rem] whitespace-nowrap">{displayLabel}</span>
        )}
      </div>
    </div>
  );

  // In iconOnly mode, always show tooltip with label
  if (iconOnly) {
    return (
      <Tooltip.Provider delayDuration={200}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            {content}
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="right"
              align="center"
              sideOffset={6}
              className="z-[9999] max-w-[18.75rem] bg-white border border-grey-80 rounded-lg px-3 py-1.5 text-xs font-medium text-grey-40 shadow-lg break-all animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
            >
              {label}
              <Tooltip.Arrow className="fill-white" width={10} height={5} />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    );
  }

  if (!showTooltip || !isTruncated) return content;

  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          {content}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            align="center"
            sideOffset={6}
            className="z-[9999] max-w-[18.75rem] bg-white border border-grey-80 rounded-lg px-3 py-1.5 text-xs font-medium text-grey-40 shadow-lg break-all animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            {label}
            <Tooltip.Arrow className="fill-white" width={10} height={5} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
};

export default TabItem;
