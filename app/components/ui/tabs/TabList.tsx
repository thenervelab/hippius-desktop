import React from "react";
import { cn } from "@/lib/utils";
import TabItem from "./TabItem";

export interface TabOption {
  tabName: string;
  /** Stable identifier used for matching; falls back to `tabName`. */
  tabKey?: string;
  /** Display label shown in the tab; falls back to `tabName`. */
  displayName?: string;
  icon?: React.ReactNode;
}

interface TabListProps {
  tabs: TabOption[];
  activeTab: string;
  onTabChange: (value: string) => void;
  width?: string;
  height?: string;
  /** Horizontal padding Tailwind class for each tab item. Defaults to `px-3`. */
  tabItemPaddingX?: string;
  /** Vertical padding Tailwind class for each tab item (e.g. `py-[3px]`). When set, overrides `height`. */
  tabItemPaddingY?: string;
  /** Gap between tab items (Tailwind class). Defaults to `gap-1`. */
  gap?: string;
  className?: string;
  tabItemClassName?: string;
  isJustifyStart?: boolean;
  showTooltip?: boolean;
  iconOnly?: boolean;
}

const TabList: React.FC<TabListProps> = ({
  tabs,
  activeTab,
  onTabChange,
  width = "min-w-[148px]",
  height = "h-[36px]",
  tabItemPaddingX,
  tabItemPaddingY,
  gap = "gap-1",
  className,
  tabItemClassName,
  isJustifyStart = false,
  showTooltip = true,
  iconOnly = false,
}) => {
  return (
    <div
      className={cn(
        "inline-flex rounded-[6px] bg-[#ebebeb] p-1 dark:bg-[#1e1e1e]",
        gap,
        className,
      )}
    >
      {tabs.map((tab) => {
        const tabIdentifier = tab.tabKey ?? tab.tabName;
        return (
          <TabItem
            key={tabIdentifier}
            label={tab.displayName ?? tab.tabName}
            dataLabel={tabIdentifier}
            icon={tab.icon}
            isActive={activeTab === tabIdentifier}
            onClick={() => onTabChange(tabIdentifier)}
            width={width}
            height={height}
            paddingX={tabItemPaddingX}
            paddingY={tabItemPaddingY}
            isJustifyStart={isJustifyStart}
            showTooltip={showTooltip}
            iconOnly={iconOnly}
            tabItemClassName={tabItemClassName}
          />
        );
      })}
    </div>
  );
};

export default TabList;
