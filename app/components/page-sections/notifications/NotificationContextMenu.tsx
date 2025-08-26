import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { Icons } from "@/components/ui";
import { deleteNotification } from "@/app/lib/helpers/notificationsDb";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { useSetAtom } from "jotai";
import { refreshUnreadCountAtom } from "@/components/page-sections/notifications/notificationStore";

interface NotificationContextMenuProps {
  x: number;
  y: number;
  isUnread: boolean;
  onClose: () => void;
  onToggleReadStatus: () => void;
  notificationId?: number;
  onArchived?: () => void;
  onArchiveStart?: () => void;
}

const NotificationContextMenu: React.FC<NotificationContextMenuProps> = ({
  x,
  y,
  isUnread,
  onClose,
  onToggleReadStatus,
  notificationId,
  onArchived,
  onArchiveStart,
}) => {
  const { refresh } = useNotifications();
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);

  useEffect(() => {
    // Close menu on any click outside
    const handleClickOutside = () => onClose();
    document.addEventListener("click", handleClickOutside);

    // Close menu on escape key
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("click", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // Calculate position to ensure menu stays within viewport
  const menuStyle = {
    top: `${Math.min(y, window.innerHeight - 100)}px`,
    left: `${Math.min(x, window.innerWidth - 200)}px`,
  };

  return createPortal(
    <div
      className="fixed z-50"
      style={menuStyle}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="bg-white border border-grey-80 shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] rounded-md overflow-hidden p-0 min-w-[220px]">
        <div className="flex flex-col">
          <button
            className="flex items-center gap-2 p-2 text-xs font-medium text-grey-30 hover:text-primary-60 hover:bg-primary-100 active:bg-primary-70 active:text-primary-80 transition-colors"
            onClick={() => {
              onToggleReadStatus();
              onClose();
            }}
          >
            {isUnread ? (
              <>
                <Icons.Eye className="size-4" />
                <span>Mark as read</span>
              </>
            ) : (
              <>
                <Icons.EyeOff className="size-4" />
                <span>Mark as unread</span>
              </>
            )}
          </button>

          {typeof notificationId === "number" && (
            <button
              className="flex items-center gap-2 p-2 text-xs font-medium text-grey-30 hover:text-error-60 hover:bg-error-50/10 active:bg-error-60/20 transition-colors"
              onClick={async () => {
                try {
                  onArchiveStart?.();
                  await new Promise((r) => setTimeout(r, 160));
                  await deleteNotification(notificationId);
                  await refresh();
                  await refreshUnread();
                  onArchived?.(); // Keep this to handle any additional cleanup
                } finally {
                  onClose(); // Close the context menu, but not the notification menu
                }
              }}
            >
              <Icons.Trash className="size-4" />
              <span>Archive this notification</span>
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default NotificationContextMenu;
