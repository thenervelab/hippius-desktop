"use client";

import Link from "next/link";
import { useSetAtom } from "jotai";
import {
  activeSubMenuItemAtom,
  isViewingRecentFilesAtom,
} from "@/components/sidebar/sideBarAtoms";

interface NotificationMenuFooterProps {
  onClose?: () => void;
}

const NotificationMenuFooter: React.FC<NotificationMenuFooterProps> = ({
  onClose,
}) => {
  const setActiveSubMenuItem = useSetAtom(activeSubMenuItemAtom);
  const setIsViewingRecentFiles = useSetAtom(isViewingRecentFilesAtom);

  const handleClick = () => {
    setActiveSubMenuItem("");
    setIsViewingRecentFiles(false);
    onClose?.();
  };

  return (
    <div className="flex items-center justify-end p-4 border-t border-grey-80">
      <Link
        href="/notifications"
        onClick={handleClick}
        className="text-grey-10 font-medium text-sm hover:underline"
      >
        View all notifications
      </Link>
    </div>
  );
};

export default NotificationMenuFooter;
