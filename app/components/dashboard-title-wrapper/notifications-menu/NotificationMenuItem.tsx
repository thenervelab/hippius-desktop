"use client";

import React, { useState, useEffect } from "react";
import { cn } from "@/app/lib/utils";
import { Icons } from "@/components/ui";
import NotificationContextMenu from "@/components/page-sections/notifications/NotificationContextMenu";
import { useSetAtom } from "jotai";
import { refreshUnreadCountAtom } from "@/components/page-sections/notifications/notificationStore";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { getVersion } from "@tauri-apps/api/app";
import { isVersionGreaterOrEqual } from "@/lib/utils/versionCompare";
import { IconComponent } from "@/app/lib/types";
import { deleteNotification } from "@/app/lib/helpers/notificationsDb";

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
  buttonText,
  buttonLink,
  unread = false,
  onClick,
  onReadStatusChange,
}) => {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string>("");
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

  const handleReadStatusToggle = () => {
    if (id && onReadStatusChange) {
      onReadStatusChange(id, !unread);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleArchive = async () => {
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

  const typeColor = TYPE_COLORS[notificationType] ?? "bg-grey-dark-200";
  const showRightColumn = unread || !!shouldShowButton;

  return (
    <>
      <div
        className={cn(
          "flex gap-[10px] items-start px-[10px] py-[12px] rounded-[8px] cursor-pointer transition-colors relative",
          "hover:bg-grey-light-300 dark:hover:bg-[#252525]",
          unread && "bg-grey-light-300 dark:bg-[#1e1e1e]",
          isArchiving && "opacity-0 scale-[0.98] transition-all duration-150"
        )}
        onClick={onClick}
        onContextMenu={handleContextMenu}
      >
        {/* Left colored indicator line */}
        <div
          className={cn(
            "w-[2px] self-stretch rounded-full flex-shrink-0 mt-[2px]",
            unread ? typeColor : "bg-grey-dark-100 dark:bg-[#3a3a3a]"
          )}
        />

        {/* Content */}
        <div className="flex-1 min-w-0 flex flex-col gap-[2px]">
          <p className="text-[14px] font-medium text-[#0a0a0a] dark:text-white leading-normal truncate">
            {notificationType}
          </p>
          <p className="text-[13px] font-medium text-[#0a0a0a] dark:text-white opacity-40 leading-normal line-clamp-2">
            {notificationText}
          </p>
        </div>

        {/* Right: badge dot (top) + view button (bottom) */}
        {showRightColumn && (
          <div className="flex flex-col items-end justify-between self-stretch flex-shrink-0 gap-2">
            {unread ? (
              <div className={cn("size-[13px] rounded-full flex-shrink-0", typeColor)} />
            ) : (
              <div />
            )}
            {shouldShowButton ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClick?.();
                }}
                className="px-[9px] py-[5px] rounded-[21px] bg-white dark:bg-[#222] border border-grey-dark-100 dark:border-[#313131] text-[10px] font-medium text-[#111] dark:text-white tracking-[-0.2px] whitespace-nowrap shadow-[0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)] dark:shadow-[0_0_0_1px_#000] hover:opacity-80 transition-opacity"
              >
                <span className="flex items-center gap-[3px]">
                  View
                  <Icons.ArrowRightFill className="size-[9px]" />
                </span>
              </button>
            ) : null}
          </div>
        )}
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
          onArchiveStart={() => {
            setIsArchiving(true);
            handleArchive();
          }}
        />
      )}
    </>
  );
};

export default NotificationMenuItem;
