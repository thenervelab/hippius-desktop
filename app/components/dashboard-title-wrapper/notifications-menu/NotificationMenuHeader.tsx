"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Icons } from "@/components/ui";
import { isViewingRecentFilesAtom } from "@/components/sidebar/sideBarAtoms";
import { useSetAtom } from "jotai";

interface NotificationMenuHeaderProps {
  count?: number;
  onClose?: () => void;
}

const NotificationMenuHeader: React.FC<NotificationMenuHeaderProps> = ({
  onClose,
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
  );
};

export default NotificationMenuHeader;
