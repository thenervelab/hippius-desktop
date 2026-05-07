"use client";

import React, { useState, useEffect } from "react";
import { IconComponent } from "@/app/lib/types";
import { Icons } from "@/components/ui";
import { cn } from "@/app/lib/utils";
import { handleButtonLink } from "@/app/lib/utils/links";
import TimeAgo from "react-timeago";
import NotificationContextMenu from "@/components/page-sections/notifications/NotificationContextMenu";
import { useRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import { deleteNotification } from "@/app/lib/helpers/notificationsDb";
import { refreshUnreadCountAtom } from "@/components/page-sections/notifications/notificationStore";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { getVersion } from "@tauri-apps/api/app";
import { isVersionGreaterOrEqual } from "@/lib/utils/versionCompare";

// Per-type color dot for the status indicator
const TYPE_COLORS: Record<string, string> = {
  Subscription: "bg-error-50",
  Files: "bg-primary-50",
  Balance: "bg-warning-50",
  Credits: "bg-warning-50",
  Blockchain: "bg-success-50",
  Storage: "bg-primary-50",
  Hippius: "bg-primary-50",
};

interface NotificationItemProps {
  id?: number;
  icon: IconComponent;
  notificationType: string;
  notificationSubType?: string;
  notificationText: string;
  notificationTime: string | number;
  timestamp?: number;
  buttonText?: string;
  buttonLink?: string;
  unread?: boolean;
  selected?: boolean;
  onClick?: () => void;
  onReadStatusChange?: (id: number, isUnread: boolean) => void;
  onClose?: () => void;
}

const NotificationMenuItem: React.FC<NotificationItemProps> = ({
  id,
  notificationType,
  notificationSubType,
  notificationText,
  notificationTime,
  timestamp,
  buttonText,
  buttonLink,
  unread = false,
  onClick,
  onReadStatusChange,
  onClose,
}) => {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const router = useRouter();
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  const { refresh } = useNotifications();

  useEffect(() => {
    getVersion()
      .then(setCurrentVersion)
      .catch((err: unknown) =>
        console.warn("[NotificationMenuItem] Failed to get app version:", err)
      );
  }, []);

  const isUpdateNotification =
    notificationType === "Hippius" &&
    notificationSubType &&
    notificationSubType.match(/^\d+\.\d+/);
  const isUpdateAlreadyInstalled =
    isUpdateNotification &&
    currentVersion &&
    isVersionGreaterOrEqual(currentVersion, notificationSubType);
  const shouldShowButton = buttonText && buttonLink && !isUpdateAlreadyInstalled;

  const handleLinkClick = (e: React.MouseEvent) => {
    handleButtonLink(e, buttonLink, router);
    onClose?.();
  };

  const handleReadStatusToggle = () => {
    if (id && onReadStatusChange) {
      onReadStatusChange(id, !unread);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!id) return;
    try {
      setIsArchiving(true);
      await new Promise((r) => setTimeout(r, 160));
      await deleteNotification(id);
      await refresh();
      await refreshUnread();
    } catch (error) {
      console.error("Failed to delete notification:", error);
    }
  };

  const dotColor = TYPE_COLORS[notificationType] ?? "bg-grey-60";

  return (
    <>
      <div
        className={cn(
          "flex items-start gap-3 px-4 py-3 hover:bg-grey-light-300 dark:hover:bg-[#252525] cursor-pointer transition-colors group relative",
          isArchiving && "opacity-0 scale-[0.98] transition-all duration-150"
        )}
        onClick={onClick}
        onContextMenu={handleContextMenu}
      >
        {/* Unread dot */}
        <div className={cn("mt-[5px] size-2 rounded-full flex-shrink-0", unread ? "bg-primary-50" : "bg-transparent")} />

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-[#0a0a0a] dark:text-white leading-[1.25rem] truncate">
            {notificationType}
          </p>
          <p className="text-[12px] text-grey-dark-800 dark:text-grey-dark-600 leading-[1.125rem] truncate mt-0.5">
            {notificationText}
          </p>
          <span className="text-[11px] text-grey-dark-600 dark:text-grey-dark-700 mt-1 block">
            {timestamp ? <TimeAgo date={timestamp} /> : notificationTime}
          </span>
        </div>

        {/* View → always visible */}
        <button
          onClick={(e) => { e.stopPropagation(); onClick?.(); }}
          className="flex-shrink-0 mt-0.5 text-[12px] font-medium text-primary-50 hover:text-primary-40 flex items-center gap-0.5 transition-colors"
        >
          View
          <Icons.ArrowRight className="size-3" />
        </button>
      </div>

      {contextMenu && (
        <NotificationContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          isUnread={unread}
          onClose={() => setContextMenu(null)}
          onToggleReadStatus={handleReadStatusToggle}
          notificationId={id}
          onArchived={() => setContextMenu(null)}
          onArchiveStart={() => setIsArchiving(true)}
        />
      )}
    </>
  );
};

export default NotificationMenuItem;
