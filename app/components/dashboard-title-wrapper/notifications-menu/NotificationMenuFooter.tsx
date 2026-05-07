"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
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
    <div className="flex items-center justify-between px-4 py-3 border-t border-grey-dark-100 dark:border-black-300">
      <Link
        href="/notifications"
        onClick={handleClick}
        className="text-[13px] font-medium text-grey-dark-800 dark:text-grey-dark-600 hover:text-[#0a0a0a] dark:hover:text-white transition-colors"
      >
        View More
      </Link>
      <ArrowRight className="size-3.5 text-grey-dark-800 dark:text-grey-dark-600" />
    </div>
  );
};

export default NotificationMenuFooter;
