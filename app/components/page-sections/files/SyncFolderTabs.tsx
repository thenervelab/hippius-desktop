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

  const baseStyles = cn(
    "px-3 py-2 rounded border text-sm font-medium leading-5 transition-colors",
    "focus:outline-none focus:ring-2 focus:ring-primary-50"
  );

  const activeStyles = "bg-primary-50 text-white border-primary-50";
  const inactiveStyles =
    "bg-grey-100 text-grey-40 border-grey-80 hover:bg-grey-80";

  return (
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      <button
        onClick={() => onTabChange(null)}
        className={cn(
          baseStyles,
          selectedTab === null ? activeStyles : inactiveStyles
        )}
      >
        All
      </button>
      {labels.map((label) => (
        <button
          key={label}
          onClick={() => onTabChange(label)}
          className={cn(
            baseStyles,
            selectedTab === label ? activeStyles : inactiveStyles
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
};

export default SyncFolderTabs;
