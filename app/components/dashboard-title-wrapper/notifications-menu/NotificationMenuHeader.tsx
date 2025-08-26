import { cn } from "@/app/lib/utils";
import { X } from "lucide-react";

interface NotificationMenuHeaderProps {
  count: number;
  onClose?: () => void;
}

const NotificationMenuHeader: React.FC<NotificationMenuHeaderProps> = ({
  count,
  onClose,
}) => (
  <div className="flex items-center justify-between p-4 border-b border-grey-80 ">
    <div className="flex items-center gap-3">
      <span className="font-medium text-2xl">Notifications</span>
      {count > 0 && (
        <span
          className={cn(
            "inline-flex items-center justify-center rounded-full bg-primary-50 text-white text-[11px] px-1 font-semibold min-w-4 min-h-4",
            count > 99 && "w-6 h-6"
          )}
        >
          {count}
        </span>
      )}
    </div>
    <button
      className="p-1 text-grey-10 hover:bg-grey-90 rounded"
      onClick={onClose}
    >
      <X size={16} />
    </button>
  </div>
);

export default NotificationMenuHeader;
