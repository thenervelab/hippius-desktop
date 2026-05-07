import Link from "next/link";
import { LayoutGrid, ArrowRight } from "lucide-react";
import { isViewingRecentFilesAtom } from "@/components/sidebar/sideBarAtoms";
import { useSetAtom } from "jotai";

interface NotificationMenuHeaderProps {
  count: number;
  onClose?: () => void;
}

const NotificationMenuHeader: React.FC<NotificationMenuHeaderProps> = ({
  count,
  onClose,
}) => {
  const setIsViewingRecentFiles = useSetAtom(isViewingRecentFilesAtom);

  const handleViewAll = () => {
    setIsViewingRecentFiles(false);
    onClose?.();
  };

  return (
    <div className="flex items-center justify-between px-4 py-3.5 border-b border-grey-dark-100 dark:border-black-300">
      <div className="flex items-center gap-2">
        <LayoutGrid className="size-[15px] text-primary-50 flex-shrink-0" />
        <span className="font-bold text-[15px] leading-none text-[#0a0a0a] dark:text-white tracking-[-0.3px]">
          Notifications
        </span>
        {count > 0 && (
          <span className="inline-flex items-center justify-center rounded-full bg-primary-50 text-white text-[10px] font-semibold min-w-[18px] h-[18px] px-1">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </div>

      <Link
        href="/notifications"
        onClick={handleViewAll}
        className="flex items-center gap-1 text-[11px] font-semibold text-primary-50 hover:text-primary-40 transition-colors uppercase tracking-wide"
      >
        View All
        <ArrowRight className="size-3" />
      </Link>
    </div>
  );
};

export default NotificationMenuHeader;
