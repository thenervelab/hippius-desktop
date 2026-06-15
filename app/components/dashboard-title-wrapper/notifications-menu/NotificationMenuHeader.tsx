"use client";

import { CheckCheck, Trash2 } from "lucide-react";

import { Icons } from "@/components/ui";
import { Select } from "@/components/ui/select/Select";
import CustomTooltip2 from "@/components/ui/CustomTooltip2";
import { cn } from "@/lib/utils";

interface CategoryOption {
  value: string;
  label: string;
}

interface NotificationMenuHeaderProps {
  count?: number;
  onClose?: () => void;
  activeCategory: string;
  onCategoryChange: (cat: string) => void;
  categoryOptions: CategoryOption[];
  /** Marks every notification read in place; the menu stays open. */
  onMarkAllRead?: () => void;
  /** Requests the delete-all flow — the confirmation dialog is owned by
   *  the menu root (outside the dropdown) so it survives the menu closing. */
  onClearAll?: () => void;
  /** Disables both bulk actions when there's nothing to act on. */
  bulkActionsDisabled?: boolean;
}

// Same chrome as the category select trigger so the three controls read as
// one toolbar group.
const BULK_BUTTON_CLASS = cn(
  "inline-flex size-[32px] shrink-0 items-center justify-center rounded-[7px] border transition-colors",
  "bg-[#fefefe] border-[#e0e0e0] text-[#0a0a0a] hover:bg-[#f5f5f5]",
  "shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)]",
  "dark:bg-[#1e1e1e] dark:border-[#494949] dark:text-white dark:hover:bg-[#252525]",
  "dark:shadow-[0px_5px_2.3px_0px_rgba(255,255,255,0.02),0px_1px_1.9px_0px_rgba(255,255,255,0.08),0px_0px_1px_0px_rgba(255,255,255,0.1)]",
  "disabled:opacity-40 disabled:cursor-not-allowed",
);

const NotificationMenuHeader: React.FC<NotificationMenuHeaderProps> = ({
  activeCategory,
  onCategoryChange,
  categoryOptions,
  onMarkAllRead,
  onClearAll,
  bulkActionsDisabled = false,
}) => {
  return (
    <div className="flex items-center justify-between gap-2 p-3 border-b border-grey-dark-100 dark:border-black-300">
      <div className="flex items-center gap-[4px] min-w-0">
        <Icons.GridDots className="size-[18px] text-primary-50 flex-shrink-0" />
        <span className="font-mono font-medium text-[12px] leading-[18px] text-primary-50 tracking-[-0.24px] whitespace-nowrap">
          Notifications
        </span>
      </div>

      <div className="flex items-center gap-2">
        {/* Compact bulk actions — the full-text buttons live on the
            notifications page; the popover gets icon equivalents so a long
            backlog can be handled without leaving the menu. */}
        {onMarkAllRead && (
          <CustomTooltip2 side="bottom" tooltipContent="Mark all as read">
            <button
              type="button"
              aria-label="Mark all notifications as read"
              className={BULK_BUTTON_CLASS}
              onClick={onMarkAllRead}
              disabled={bulkActionsDisabled}
            >
              <CheckCheck className="size-[14px]" />
            </button>
          </CustomTooltip2>
        )}
        {onClearAll && (
          <CustomTooltip2 side="bottom" tooltipContent="Clear all">
            <button
              type="button"
              aria-label="Clear all notifications"
              className={BULK_BUTTON_CLASS}
              onClick={onClearAll}
              disabled={bulkActionsDisabled}
            >
              <Trash2 className="size-[14px]" />
            </button>
          </CustomTooltip2>
        )}

        <Select
          options={categoryOptions}
          value={activeCategory}
          onValueChange={onCategoryChange}
          minimal
          className="w-auto"
          triggerClassName="min-h-0 sm:min-h-0 h-auto px-[8px] py-[6px] rounded-[7px] text-[12px] font-medium font-mono tracking-[-0.24px] uppercase leading-[20px] bg-[#fefefe] border-[#e0e0e0] shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)] text-[#0a0a0a] dark:text-white dark:border-[#494949] dark:bg-[#1e1e1e] dark:shadow-[0px_5px_2.3px_0px_rgba(255,255,255,0.02),0px_1px_1.9px_0px_rgba(255,255,255,0.08),0px_0px_1px_0px_rgba(255,255,255,0.1)] [&_svg]:text-[#0a0a0a] dark:[&_svg]:text-white [&_svg]:size-[12px]"
          contentClassName="min-w-[140px] z-[200]"
          itemClassName="text-[12px] font-medium font-mono py-2 uppercase tracking-[-0.24px]"
          valueClassName="text-[12px] sm:text-[12px]"
        />
      </div>
    </div>
  );
};

export default NotificationMenuHeader;
