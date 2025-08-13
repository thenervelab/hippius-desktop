import React from "react";
import { cn } from "@/lib/utils";
import TabItem from "./TabItem";

export interface TabOption {
  tabName: string;
  icon: React.ReactNode;
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
}

const TabList: React.FC<TabListProps> = ({
  tabs,
  activeTab,
  onTabChange,
  className,
  width = "min-w-[148px]",
  height = "h-[36px]",
  gap = "gap-4",
  isJustifyStart = false
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
        />
      ))}
    </div>
  );
};

export default TabList;
