"use client";

import Link from "next/link";
import { useSetAtom } from "jotai";
import { isViewingRecentFilesAtom } from "@/components/sidebar/sideBarAtoms";

interface NotificationMenuFooterProps {
  onClose?: () => void;
}

const NotificationMenuFooter: React.FC<NotificationMenuFooterProps> = ({
  onClose,
}) => {
  const setIsViewingRecentFiles = useSetAtom(isViewingRecentFilesAtom);

  const handleClick = () => {
    setIsViewingRecentFiles(false);
    onClose?.();
  };

  return (
    <Link
      href="/notifications"
      onClick={handleClick}
      className="flex items-center gap-[4px] h-[32px] px-[16px] border-t border-grey-dark-100 dark:border-black-300 bg-grey-light-400 dark:bg-[#111111] shadow-[inset_0px_2px_0px_0px_white] dark:shadow-none hover:brightness-95 dark:hover:bg-[#1a1a1a] transition-all overflow-hidden w-full shrink-0"
    >
      <span className="flex-1 min-w-0 font-medium text-[12px] leading-[18px] text-grey-dark-800 dark:text-grey-dark-600 tracking-[-0.24px] truncate">
        View More
      </span>
      <span className="font-medium text-[12px] leading-[18px] text-grey-dark-800 dark:text-grey-dark-600 tracking-[-0.24px] shrink-0">
        →
      </span>
    </Link>
  );
};

export default NotificationMenuFooter;
