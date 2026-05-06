"use client";

import React, { useState, useEffect } from "react";
import { IconComponent } from "@/app/lib/types";
import { cn } from "@/app/lib/utils";
import NotificationContextMenu from "./NotificationContextMenu";
import { useSetAtom } from "jotai";
import { deleteNotification } from "@/app/lib/helpers/notificationsDb";
import { refreshUnreadCountAtom } from "@/components/page-sections/notifications/notificationStore";
import { getVersion } from "@tauri-apps/api/app";
import { isVersionGreaterOrEqual } from "@/lib/utils/versionCompare";
import { Trash2 } from "lucide-react";

// Unread accent color per notification type (Figma: subscription/money=red, others=blue)
const TYPE_ACCENT: Record<string, string> = {
  Subscription: "#ff6d61",
  Balance:      "#ff6d61",
  Credits:      "#ff6d61",
  Files:        "#3067dd",
  Hippius:      "#3067dd",
  Blockchain:   "#3067dd",
  Storage:      "#3067dd",
};
const READ_ACCENT = "#b6b6b6";

interface NotificationItemProps {
  id?: number;
  icon: IconComponent;
  notificationType: string;
  notificationSubType?: string;
  notificationText: string;
  notificationDescription?: string;
  notificationTime: string | number;
  timestamp?: number;
  buttonText?: string;
  buttonLink?: string;
  unread?: boolean;
  selected?: boolean;
  onClick?: () => void;
  onReadStatusChange?: (id: number, isUnread: boolean) => void;
  onRefresh?: () => void;
}

const NotificationItem: React.FC<NotificationItemProps> = ({
  id,
  notificationType,
  notificationSubType,
  notificationText,
  unread = false,
  selected = false,
  onClick,
  onReadStatusChange,
  onRefresh,
}) => {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);

  useEffect(() => {
    getVersion()
      .then(setCurrentVersion)
      .catch((err: unknown) =>
        console.warn("[NotificationItem] Failed to get app version:", err)
      );
  }, []);

  const accentColor = unread
    ? (TYPE_ACCENT[notificationType] ?? "#3067dd")
    : READ_ACCENT;

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
      await refreshUnread();
      if (onRefresh) onRefresh();
    } catch (error) {
      console.error("Failed to delete notification:", error);
    }
  };

  return (
    <>
      <div
        className={cn(
          "flex items-start gap-2.5 px-2.5 py-3 rounded-lg cursor-pointer transition-colors group relative",
          selected
            ? "bg-[#dfe5f7] ring-1 ring-[#618ce8]"
            : unread
            ? "bg-[#f8f8f8] hover:bg-[#f0f0f0]"
            : "bg-[#f5f5f5] hover:bg-[#eeeeee]",
          isArchiving && "opacity-0 scale-[0.98] transition-all duration-150"
        )}
        onClick={onClick}
        onContextMenu={handleContextMenu}
      >
        {/* Left accent line — Figma: Vector w=2px, color varies by type/read state */}
        <div
          className="w-0.5 self-stretch rounded-full flex-shrink-0 min-h-[1.125rem]"
          style={{ backgroundColor: accentColor }}
        />

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p
            className="text-[14px] font-medium leading-[18.2px] truncate"
            style={{ color: "#0a0a0a" }}
          >
            {notificationType}
          </p>
          <p
            className="text-[13px] font-medium leading-[16.9px] truncate mt-0.5"
            style={{ color: "#0a0a0a" }}
          >
            {notificationText}
          </p>
        </div>

        {/* Unread indicator dot */}
        {unread && (
          <div className="size-2 rounded-full bg-[#3067dd] flex-shrink-0 mt-1" />
        )}

        {/* Delete on hover */}
        <button
          className="absolute top-2.5 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-[#b6b6b6] hover:text-[#ff6d61]"
          onClick={handleDelete}
          title="Delete notification"
        >
          <Trash2 className="size-3.5" />
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
          onArchived={() => {
            setContextMenu(null);
            if (onRefresh) onRefresh();
          }}
          onArchiveStart={() => setIsArchiving(true)}
        />
      )}
    </>
  );
};

export default NotificationItem;
