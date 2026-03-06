import { FC } from "react";
import { cn } from "@/lib/utils";

interface SyncFolderTabsProps {
  labels: string[];
  selectedTab: string | null;
  onTabChange: (tab: string | null) => void;
}

const SyncFolderTabs: FC<SyncFolderTabsProps> = ({
  labels,
  selectedTab,
  onTabChange,
}) => {
  if (labels.length < 2) return null;

  return (
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      <button
        onClick={() => onTabChange(null)}
        className={cn(
          "px-3 py-1.5 rounded-full text-sm font-medium transition-colors",
          "border focus:outline-none focus:ring-2 focus:ring-primary-50",
          selectedTab === null
            ? "bg-primary-50 text-white border-primary-50"
            : "bg-grey-100 text-grey-30 border-grey-80 hover:border-primary-60 hover:text-primary-40"
        )}
      >
        All
      </button>
      {labels.map((label) => (
        <button
          key={label}
          onClick={() => onTabChange(label)}
          className={cn(
            "px-3 py-1.5 rounded-full text-sm font-medium transition-colors",
            "border focus:outline-none focus:ring-2 focus:ring-primary-50",
            selectedTab === label
              ? "bg-primary-50 text-white border-primary-50"
              : "bg-grey-100 text-grey-30 border-grey-80 hover:border-primary-60 hover:text-primary-40"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
};

export default SyncFolderTabs;
