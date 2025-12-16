import React, { useState } from "react";
import { IconComponent } from "@/app/lib/types";
import { AbstractIconWrapper, Icons } from "@/components/ui";
import { cn } from "@/app/lib/utils";
import { handleButtonLink } from "@/app/lib/utils/links";
import NotificationType from "./NotificationType";
import { InView } from "react-intersection-observer";
import RevealTextLine from "@/components/ui/reveal-text-line";
import TimeAgo from "react-timeago";
import NotificationContextMenu from "./NotificationContextMenu";
import { useRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import { activeSubMenuItemAtom } from "@/components/sidebar/sideBarAtoms";
import { deleteNotification } from "@/app/lib/helpers/notificationsDb";
import { refreshUnreadCountAtom } from "@/components/page-sections/notifications/notificationStore";

interface NotificationItemProps {
  id?: number;
  icon: IconComponent;
  notificationType: string;
  notificationText: string;
  notificationTime: string | number;
  timestamp?: number;
  buttonText?: string;
  buttonLink?: string;
  unread?: boolean;
  selected?: boolean;
  onClick?: () => void;
  onReadStatusChange?: (id: number, isUnread: boolean) => void;
  onRefresh?: () => void; // Added for refreshing notification list
}

const NotificationItem: React.FC<NotificationItemProps> = ({
  id,
  icon: Icon,
  notificationType,
  notificationText,
  notificationTime,
  timestamp,
  buttonText,
  buttonLink,
  unread = false,
  selected = false,
  onClick,
  onReadStatusChange,
  onRefresh
}) => {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const router = useRouter();
  const setActiveSubMenuItem = useSetAtom(activeSubMenuItemAtom);
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);

  const handleLinkClick = (e: React.MouseEvent) => {
    handleButtonLink(e, buttonLink, router, setActiveSubMenuItem);
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
    e.stopPropagation(); // Prevent triggering onClick

    if (!id) return;

    try {
      setIsArchiving(true);
      await new Promise(r => setTimeout(r, 160)); // Animation delay
      await deleteNotification(id);
      await refreshUnread();
      if (onRefresh) {
        onRefresh();
      }
    } catch (error) {
      console.error('Failed to delete notification:', error);
    }
  };

  return (
    <>
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div
            ref={ref}
            className={cn(
              "flex items-start gap-3 p-3 hover:bg-grey-90 hover:rounded rounded-lg mb-3 bg-white group cursor-pointer transition duration-200 relative",
              selected && "border border-primary-70 bg-primary-100",
              isArchiving && "opacity-0 translate-y-1 scale-[0.98]"
            )}
            onClick={onClick}
            onContextMenu={handleContextMenu}
          >
            <AbstractIconWrapper className="min-w-[32px] size-8 text-primary-40">
              <Icon className="absolute text-primary-40 size-5" />
            </AbstractIconWrapper>

            <div className="flex justify-between gap-4 w-full">
              <div className="flex flex-col">
                {/* Type badge  */}
                <RevealTextLine rotate reveal={inView} className="delay-200">
                  <NotificationType type={notificationType} />
                </RevealTextLine>

                {/* Notification text */}
                <RevealTextLine rotate reveal={inView} className="delay-300">
                  <p
                    className="text-sm text-grey-30 leading-5 mb-1 truncate max-w-[300px]"
                    title={notificationText}
                  >
                    {notificationText}
                  </p>
                </RevealTextLine>

                {/* Time */}
                <RevealTextLine rotate reveal={inView} className="delay-400">
                  <span className="text-xs text-grey-60 leading-[18px]">
                    {timestamp ? (
                      <TimeAgo date={timestamp} />
                    ) : (
                      notificationTime
                    )}
                  </span>
                </RevealTextLine>
              </div>

              {/* Button & unread symbol */}
              <div className="flex gap-3">
                {buttonText && buttonLink && (
                  <RevealTextLine rotate reveal={inView} className="delay-500">
                    <button
                      onClick={handleLinkClick}
                      className="text-sm font-medium rounded py-2 self-start px-3 text-grey-10 flex items-center justify-center bg-grey-90 group-hover:bg-grey-100 whitespace-nowrap"
                    >
                      {buttonText}
                      <Icons.ArrowRight className="size-[14px] text-grey-10 ml-1" />
                    </button>
                  </RevealTextLine>
                )}

                <div
                  className={cn("flex size-2 bg-primary-50 rounded-full", {
                    "opacity-0": !unread,
                    "opacity-100": unread
                  })}
                ></div>
              </div>
            </div>

            {/* Delete button - appears on hover */}
            <button
              className={cn("absolute top-6 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-grey-60 hover:text-error-50", !unread && "top-4")}
              onClick={handleDelete}
              title="Delete notification"
            >
              <Icons.Trash className="size-4" />
            </button>
          </div>
        )}
      </InView >

      {/* Context Menu */}
      {
        contextMenu && (
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
        )
      }
    </>
  );
};

export default NotificationItem;
