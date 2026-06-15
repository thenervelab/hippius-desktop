import React from "react";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";

type FilterType = "fileExtension" | "dateRange" | "fileSize";

const CHIP_CLASSES = cn(
  "relative inline-flex items-center gap-[4px] px-[6px] py-[4px]",
  "rounded-[4.364px] border-[0.727px]",
  "bg-grey-light-700 border-grey-dark-100",
  "shadow-[0px_0.727px_0px_0px_rgba(255,255,255,1),inset_0px_1.455px_0px_0px_rgba(255,255,255,1)]",
  "font-mono text-[10px] font-medium uppercase tracking-[-0.2px] leading-none",
  "text-black-700",
  "dark:bg-black-primary-bg dark:border-black-300",
  "dark:shadow-[0px_0px_0px_1px_rgba(0,0,0,1)]",
  "dark:text-grey-light-300",
);

export interface ActiveFilter {
  type: FilterType;
  value: string;
  label: string;
  displayValue: string;
}

interface FilterChipsProps {
  filters: ActiveFilter[];
  onRemoveFilter: (filter: ActiveFilter) => void;
  className?: string;
  maxVisible?: number;
}

const FilterChips: React.FC<FilterChipsProps> = ({
  filters,
  onRemoveFilter,
  className,
  maxVisible = 5,
}) => {
  const [isExpanded, setIsExpanded] = React.useState(false);

  if (filters.length === 0) return null;

  const visibleFilters = isExpanded ? filters : filters.slice(0, maxVisible);
  const hiddenCount = isExpanded ? 0 : Math.max(0, filters.length - maxVisible);

  return (
    <div className={cn("flex flex-wrap gap-2 items-center", className)}>
      {visibleFilters.map((filter, index) => (
        <div
          key={`${filter.type}-${filter.value}-${index}`}
          className={CHIP_CLASSES}
        >
          <span className="flex items-center gap-[3px] whitespace-nowrap translate-y-[0.5px]">
            <span className="opacity-50">{filter.label}</span>
            <span className="opacity-50">|</span>
            <span>{filter.displayValue}</span>
          </span>
          <button
            onClick={() => onRemoveFilter(filter)}
            className={cn(
              "inline-flex size-[12px] shrink-0 items-center justify-center rounded-[3px] p-0 leading-none",
              "bg-grey-dark-100 text-black-900/40",
              "shadow-[inset_0px_0.727px_0px_0px_rgba(255,255,255,0.8)]",
              "transition-opacity hover:opacity-80",
              "dark:bg-black-300 dark:text-grey-light-300/60",
              "dark:shadow-[inset_0px_0.727px_0px_0px_rgba(0,0,0,0.9)]",
            )}
          >
            <Icons.Close className="block size-[8px]" />
          </button>
        </div>
      ))}

      {hiddenCount > 0 && (
        <div
          className={cn(
            CHIP_CLASSES,
            "cursor-pointer hover:bg-grey-light-600 dark:hover:bg-black-500",
          )}
          onClick={() => setIsExpanded(true)}
        >
          <span>+{hiddenCount} more</span>
        </div>
      )}

      {isExpanded && filters.length > maxVisible && (
        <button
          onClick={() => setIsExpanded(false)}
          className={cn(
            CHIP_CLASSES,
            "cursor-pointer hover:bg-grey-light-600 dark:hover:bg-black-500",
          )}
        >
          <span>Show less</span>
        </button>
      )}
    </div>
  );
};

export default FilterChips;
