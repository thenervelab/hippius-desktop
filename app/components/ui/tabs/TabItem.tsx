import React from "react";
import { cn } from "@/lib/utils";
import { middleTruncate } from "@/lib/utils/middleTruncate";
import * as Tooltip from "@radix-ui/react-tooltip";

export interface TabItemProps {
  label: string;
  /** Value for `data-tab-label`. Falls back to `label`. */
  dataLabel?: string;
  icon?: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
  width?: string;
  /** Fixed height Tailwind class (e.g. `h-[36px]`). Ignored when `paddingY` is set. */
  height?: string;
  /** Horizontal padding Tailwind class. Defaults to `px-3`. */
  paddingX?: string;
  /** Vertical padding Tailwind class (e.g. `py-[3px]`). When set, overrides `height`. */
  paddingY?: string;
  isJustifyStart?: boolean;
  showTooltip?: boolean;
  iconOnly?: boolean;
  tabItemClassName?: string;
}

const TabItem: React.FC<TabItemProps> = ({
  label,
  dataLabel,
  icon,
  isActive,
  onClick,
  width = "min-w-[148px]",
  height = "h-[36px]",
  paddingX = "px-3",
  paddingY,
  isJustifyStart = false,
  showTooltip = true,
  iconOnly = false,
  tabItemClassName,
}) => {
  const TAB_MAX_CHARS = 24;
  const displayLabel = middleTruncate(label, TAB_MAX_CHARS);
  const isTruncated = displayLabel !== label;

  const content = (
    <div
      data-tab-label={dataLabel ?? label}
      className={cn(
        "flex shrink-0 cursor-pointer items-center justify-center rounded-[3px] transition-opacity duration-200",
        paddingX,
        paddingY ? paddingY : height,
        iconOnly ? "w-[2.5rem]" : width,
        isActive
          ? "bg-[#f8f8f8] border border-[#e3e3e3] text-[#000000] shadow-[0px_12.26px_3.831px_0px_rgba(0,0,0,0.00),0px_8.429px_3.065px_0px_rgba(0,0,0,0.01),0px_4.597px_3.065px_0px_rgba(0,0,0,0.04),0px_2.299px_2.299px_0px_rgba(0,0,0,0.08),0px_0.766px_0.766px_0px_rgba(0,0,0,0.09)] dark:bg-[#161616] dark:border-[#313131] dark:text-[#ffffff] dark:shadow-[0px_0px_0px_1px_black]"
          : "opacity-50 text-[#000000] hover:opacity-75 dark:text-[#ffffff]",
        tabItemClassName,
      )}
      onClick={onClick}
    >
      <div
        className={cn(
          "flex items-center gap-[6px] text-current",
          !iconOnly && isJustifyStart && "justify-start w-full",
        )}
      >
        {icon ? (
          <span
            className={cn(
              "flex shrink-0 items-center justify-center text-current",
              isActive && "text-[#3167dd]",
            )}
          >
            {icon}
          </span>
        ) : null}
        {!iconOnly && (
          <span className="font-medium text-[13px] tracking-[-0.26px] leading-[1.1] whitespace-nowrap">
            {displayLabel}
          </span>
        )}
      </div>
    </div>
  );

  if (iconOnly) {
    return (
      <Tooltip.Provider delayDuration={200}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>{content}</Tooltip.Trigger>
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
        <Tooltip.Trigger asChild>{content}</Tooltip.Trigger>
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
