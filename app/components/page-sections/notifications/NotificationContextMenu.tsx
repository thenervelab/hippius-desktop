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

  const MENU_WIDTH = 220;
  const MENU_HEIGHT = 80;
  const GAP = 4;

  // Flip left if menu would overflow right edge; flip up if it would overflow bottom
  const left = x + MENU_WIDTH > window.innerWidth
    ? Math.max(0, x - MENU_WIDTH)
    : x;
  const top = y + MENU_HEIGHT > window.innerHeight
    ? Math.max(0, y - MENU_HEIGHT - GAP)
    : y + GAP;

  return createPortal(
    <div
      className="fixed z-50"
      style={{ top, left }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="bg-white dark:bg-[#1e1e1e] border border-[#e3e3e3] dark:border-[#313131] shadow-[0px_8px_24px_0px_rgba(0,0,0,0.12)] dark:shadow-[0px_8px_24px_0px_rgba(0,0,0,0.4)] rounded-lg overflow-hidden min-w-[13.75rem]">
        <div className="flex flex-col p-1">
          <button
            className="flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-medium text-[#0a0a0a] dark:text-[#f8f8f8] hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a] transition-colors"
            onClick={() => {
              onToggleReadStatus();
              onClose();
            }}
          >
            {isUnread ? (
              <>
                <Icons.Eye className="size-[15px] opacity-60" />
                <span>Mark as read</span>
              </>
            ) : (
              <>
                <Icons.EyeOff className="size-[15px] opacity-60" />
                <span>Mark as unread</span>
              </>
            )}
          </button>

          {typeof notificationId === "number" && (
            <button
              className="flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-medium text-[#ff6d61] hover:bg-[#ff6d61]/10 dark:hover:bg-[#ff6d61]/10 transition-colors"
              onClick={async () => {
                try {
                  onArchiveStart?.();
                  await new Promise((r) => setTimeout(r, 160));
                  await deleteNotification(notificationId);
                  await refresh();
                  await refreshUnread();
                  onArchived?.();
                } finally {
                  onClose();
                }
              }}
            >
              <Icons.Trash className="size-[15px] opacity-80" />
              <span>Delete this notification</span>
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default NotificationContextMenu;
