import { cn } from "@/app/lib/utils";
import Link from "next/link";
import { Icons } from "@/components/ui";
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
    <div className="flex items-center justify-between px-4 py-3 border-b border-grey-80">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-base text-grey-10">Notifications</span>
        {count > 0 && (
          <span
            className={cn(
              "inline-flex items-center justify-center rounded-full bg-primary-50 text-white text-[0.625rem] px-1.5 py-0.5 font-semibold min-w-[1.125rem]",
              count > 99 && "px-2"
            )}
          >
            {count}
          </span>
        )}
      </div>
      <Link
        href="/notifications"
        onClick={handleViewAll}
        className="flex items-center gap-1 text-xs font-semibold text-primary-50 hover:text-primary-40 transition-colors uppercase tracking-wide"
      >
        View All
        <Icons.ArrowRight className="size-3" />
      </Link>
    </div>
  );
};

export default NotificationMenuHeader;
