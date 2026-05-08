"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Icons } from "@/components/ui";
import { isViewingRecentFilesAtom } from "@/components/sidebar/sideBarAtoms";
import { useSetAtom } from "jotai";
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
  onClose,
  activeCategory,
  onCategoryChange,
  categoryOptions,
}) => {
  const setIsViewingRecentFiles = useSetAtom(isViewingRecentFilesAtom);

  const handleViewAll = () => {
    setIsViewingRecentFiles(false);
    onClose?.();
  };

  return (
    <div className="flex items-center justify-between p-3 border-b border-grey-dark-100 dark:border-black-300">
      <div className="flex items-center gap-[4px]">
        <Icons.GridDots className="size-[18px] text-primary-50 flex-shrink-0" />
        <span className="font-mono font-medium text-[12px] leading-[18px] text-primary-50 tracking-[-0.24px] whitespace-nowrap">
          Notifications
        </span>
      </div>

      <div className="flex items-center gap-2">
        {/* Category filter dropdown */}
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

        {/* View All link */}
        <Link
          href="/notifications"
          onClick={handleViewAll}
          className="flex items-center gap-[4px] px-[8px] py-[6px] rounded-[7px] bg-white dark:bg-[#1e1e1e] border border-[#e0e0e0] dark:border-[#333] shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)] hover:opacity-80 transition-opacity"
        >
          <span className="font-mono font-medium text-[12px] text-[#0a0a0a] dark:text-white tracking-[-0.24px] uppercase whitespace-nowrap">
            VIEW ALL
          </span>
          <ArrowRight className="size-3.5 text-[#0a0a0a] dark:text-white" />
        </Link>
      </div>
    </div>
  );
};

export default NotificationMenuHeader;
