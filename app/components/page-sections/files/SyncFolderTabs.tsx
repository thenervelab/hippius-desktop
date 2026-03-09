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
    "px-4 py-2.5 rounded-lg border text-sm font-medium leading-5 transition-all shadow-sm",
    "focus:outline-none focus:ring-2 focus:ring-primary-50 focus:ring-offset-2"
  );

  const activeStyles = "bg-primary-50 text-white border-primary-50 shadow-md";
  const inactiveStyles =
    "bg-white text-grey-40 border-grey-80 hover:bg-grey-95 hover:border-grey-70";

  return (
    <div className="flex items-center gap-2 mt-6 mb-5 flex-wrap">
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
