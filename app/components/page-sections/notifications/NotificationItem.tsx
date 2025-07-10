import React from "react";
import { IconComponent } from "@/app/lib/types";
import { AbstractIconWrapper, Icons } from "../../ui";
import { cn } from "@/app/lib/utils";
import { openLinkByKey } from "@/app/lib/utils/links";
import NotificationType from "./NotificationType";

interface NotificationItemProps {
  icon: IconComponent;
  notificationType: string;
  notificationText: string;
  notificationTime: string;
  buttonText?: string;
  buttonLink?: string;
  unread?: boolean;
  selected?: boolean;
  onClick?: () => void;
}

const NotificationItem: React.FC<NotificationItemProps> = ({
  icon: Icon,
  notificationType,
  notificationText,
  notificationTime,
  buttonText,
  buttonLink,
  unread = false,
  selected = false,
  onClick,
}) => {
  const handleLinkClick = (e: React.MouseEvent) => {
    if (buttonLink) {
      e.preventDefault();
      e.stopPropagation();
      openLinkByKey(buttonLink);
    }
  };

  return (
    <div
      className={cn(
        "flex items-start gap-3 p-3 hover:bg-grey-90 hover:rounded rounded-lg mb-3 bg-white group cursor-pointer",
        selected && "border border-primary-70 bg-primary-100"
      )}
      onClick={onClick}
    >
      <AbstractIconWrapper className="min-w-[32px] size-8 text-primary-40">
        <Icon className="absolute text-primary-40 size-5" />
      </AbstractIconWrapper>

      <div className="flex justify-between gap-4 w-full">
        <div className="flex flex-col">
          {/* Type badge  */}
          <NotificationType type={notificationType} />

          {/* Notification text */}
          <p className="text-sm text-grey-30 leading-5 mb-1">
            {notificationText}
          </p>

          {/* Time */}

          <span className="text-xs text-grey-60 leading-[18px]">
            {notificationTime}
          </span>
        </div>

        {/* Button & unread symbol */}
        <div className="flex gap-3">
          {buttonText && buttonLink && (
            <button
              onClick={handleLinkClick}
              className="text-sm font-medium rounded py-2 self-start px-3 text-grey-10 flex items-center justify-center bg-grey-90 group-hover:bg-grey-100 whitespace-nowrap"
            >
              {buttonText}
              <Icons.ArrowRight className="size-[14px] text-grey-10 ml-1" />
            </button>
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
  );
};

export default NotificationItem;
