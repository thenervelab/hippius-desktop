import React, { useState } from "react";
import { IconComponent } from "@/app/lib/types";
import { AbstractIconWrapper, Icons } from "../../ui";
import { cn } from "@/app/lib/utils";
import { openLinkByKey } from "@/app/lib/utils/links";
import { InView } from "react-intersection-observer";
import RevealTextLine from "../../ui/reveal-text-line";
import TimeAgo from "react-timeago";
import { useRouter } from "next/navigation";
import NotificationType from "../../page-sections/notifications/NotificationType";
import NotificationContextMenu from "../../page-sections/notifications/NotificationContextMenu";

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
  onClose?: () => void;
}

const NotificationMenuItem: React.FC<NotificationItemProps> = ({
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
  onClose,
}) => {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const router = useRouter();

  const handleLinkClick = (e: React.MouseEvent) => {
    if (buttonLink) {
      e.preventDefault();
      e.stopPropagation();
      if (buttonLink.includes("BILLING")) {
        openLinkByKey(buttonLink);
      } else {
        router.push(buttonLink);
      }
      onClose?.();
    }
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

  return (
    <>
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div
            ref={ref}
            className={cn(
              "flex items-start gap-2 p-3 hover:bg-grey-90 hover:rounded rounded-lg mb-3 bg-white group cursor-pointer w-full",
              selected && "border border-primary-70 bg-primary-100"
            )}
            onClick={onClick}
            onContextMenu={handleContextMenu}
          >
            <AbstractIconWrapper className="min-w-[32px] size-8 text-primary-40">
              <Icon className="absolute text-primary-40 size-5" />
            </AbstractIconWrapper>

            <div className="flex justify-between gap-1 w-full">
              <div className="flex flex-col">
                {/* Type badge  */}
                <RevealTextLine rotate reveal={inView} className="delay-200">
                  <NotificationType type={notificationType} />
                </RevealTextLine>

                {/* Notification text */}
                <RevealTextLine rotate reveal={inView} className="delay-300">
                  <p
                    className="text-sm text-grey-30 leading-5 mb-1 truncate max-w-[200px]"
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
                    "opacity-100": unread,
                  })}
                ></div>
              </div>
            </div>
          </div>
        )}
      </InView>

      {/* Context Menu */}
      {contextMenu && (
        <NotificationContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          isUnread={unread}
          onClose={() => setContextMenu(null)}
          onToggleReadStatus={handleReadStatusToggle}
        />
      )}
    </>
  );
};

export default NotificationMenuItem;
