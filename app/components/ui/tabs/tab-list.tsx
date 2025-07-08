import React from "react";
import { cn } from "@/lib/utils";
import TabItem from "./tab-item";

export interface TabOption {
  tabName: string;
  icon: React.ReactNode;
}

interface TabListProps {
  tabs: TabOption[];
  activeTab: string;
  onTabChange: (tabName: string) => void;
  className?: string;
}

const TabList: React.FC<TabListProps> = ({
  tabs,
  activeTab,
  onTabChange,
  className,
}) => {
  return (
    <div className={cn("flex gap-4", className)}>
      {tabs.map((tab) => (
        <TabItem
          key={tab.tabName}
          label={tab.tabName}
          icon={tab.icon}
          isActive={activeTab === tab.tabName}
          onClick={() => onTabChange(tab.tabName)}
        />
      ))}
    </div>
  );
};

export default TabList;
