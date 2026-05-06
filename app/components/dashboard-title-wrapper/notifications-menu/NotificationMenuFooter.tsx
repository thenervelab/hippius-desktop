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
    <div className="flex items-center justify-center px-4 py-3 border-t border-grey-80">
      <Link
        href="/notifications"
        onClick={handleClick}
        className="text-primary-50 hover:text-primary-40 font-medium text-sm transition-colors flex items-center gap-1"
      >
        View More
      </Link>
    </div>
  );
};

export default NotificationMenuFooter;
