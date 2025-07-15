import React from 'react';
import { Icons } from '@/components/ui';
import { cn } from '@/lib/utils';

type FilterType = 'fileType' | 'date' | 'fileSize';

export interface ActiveFilter {
    type: FilterType;
    value: string;
    label: string;
    displayValue: string;
}

interface FilterChipsProps {
    filters: ActiveFilter[];
    onRemoveFilter: (filter: ActiveFilter) => void;
    onOpenFilterDialog: () => void;
    className?: string;
    maxVisible?: number;
}

const FilterChips: React.FC<FilterChipsProps> = ({
    filters,
    onRemoveFilter,
    onOpenFilterDialog,
    className,
    maxVisible = 5,
}) => {
    if (filters.length === 0) return null;

    const visibleFilters = filters.slice(0, maxVisible);
    const hiddenCount = Math.max(0, filters.length - maxVisible);

    return (
        <div className={cn('flex flex-wrap gap-2 items-center', className)}>
            {visibleFilters.map((filter, index) => (
                <div
                    key={`${filter.type}-${filter.value}-${index}`}
                    className="flex items-center gap-1 px-2 py-1 bg-grey-90 border border-grey-80 rounded text-sm"
                >
                    <span className="text-grey-60">{filter.label}</span>
                    <span className="text-grey-30 font-medium">{filter.displayValue}</span>
                    <button
                        onClick={() => onRemoveFilter(filter)}
                        className="hover:bg-grey-80 rounded-full p-0.5 text-grey-30 ml-1"
                    >
                        <Icons.Close className="size-4 text-grey-60" />
                    </button>
                </div>
            ))}

            {hiddenCount > 0 && (
                <div
                    className="flex items-center gap-1 px-2 py-1 bg-grey-90 border border-grey-80 rounded text-sm text-primary-50 cursor-pointer hover:bg-grey-80"
                    onClick={onOpenFilterDialog}
                >
                    <span>+{hiddenCount} more</span>
                </div>
            )}
        </div>
    );
};

export default FilterChips;
