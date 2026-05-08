"use client";

import { Icons } from "@/components/ui";
import { Select } from "@/components/ui/select/Select";

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
}

const NotificationMenuHeader: React.FC<NotificationMenuHeaderProps> = ({
  activeCategory,
  onCategoryChange,
  categoryOptions,
}) => {
  return (
    <div className="flex items-center justify-between p-3 border-b border-grey-dark-100 dark:border-black-300">
      <div className="flex items-center gap-[4px]">
        <Icons.GridDots className="size-[18px] text-primary-50 flex-shrink-0" />
        <span className="font-mono font-medium text-[12px] leading-[18px] text-primary-50 tracking-[-0.24px] whitespace-nowrap">
          Notifications
        </span>
      </div>

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
  );
};

export default NotificationMenuHeader;
