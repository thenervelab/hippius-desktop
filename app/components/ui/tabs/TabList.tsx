import React from "react";
import { cn } from "@/lib/utils";
import TabItem from "./TabItem";

export interface TabOption {
  tabName: string;
  icon?: React.ReactNode;
}

interface TabListProps {
  tabs: TabOption[];
  activeTab: string;
  onTabChange: (tabName: string) => void;
  className?: string;
  width?: string;
  height?: string;
  gap?: string;
  isJustifyStart?: boolean;
  showTooltip?: boolean;
}

const TabList: React.FC<TabListProps> = ({
  tabs,
  activeTab,
  onTabChange,
  className,
  width = "min-w-[9.25rem]",
  height = "h-[2.25rem]",
  gap = "gap-4",
  isJustifyStart = false,
  showTooltip = true,
}) => {
  return (
    <div className={cn("flex ", gap, className)}>
      {tabs.map((tab) => (
        <TabItem
          key={tab.tabName}
          label={tab.tabName}
          icon={tab.icon}
          isActive={activeTab === tab.tabName}
          onClick={() => onTabChange(tab.tabName)}
          width={width}
          height={height}
          isJustifyStart={isJustifyStart}
          showTooltip={showTooltip}
        />
      ))}
    </div>
  );
};

export default TabList;
