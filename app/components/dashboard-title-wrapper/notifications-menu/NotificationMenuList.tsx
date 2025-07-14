import React from "react";
import NotificationMenuItem from "./NotificationMenuItem";
import { UiNotification } from "../../page-sections/notifications/types";

interface NotificationListProps {
  notifications: UiNotification[];
  selectedNotificationId?: number | null;
  onSelectNotification: (id: number) => void;
  onReadStatusChange?: (id: number, isUnread: boolean) => void;
  onClose?: () => void;
}

const NotificationMenuList: React.FC<NotificationListProps> = ({
  notifications,
  selectedNotificationId,
  onSelectNotification,
  onReadStatusChange,
  onClose,
}) => {
  return (
    <div className="flex flex-col gap-2 w-[396px]   pb-4 h-[340px] overflow-y-auto overflow-x-hidden ">
      {notifications.map((notification) => (
        <NotificationMenuItem
          key={notification.id}
          id={notification.id}
          onClose={onClose}
          icon={notification.icon}
          notificationType={notification.type}
          notificationText={notification.title}
          notificationTime={notification.time}
          timestamp={notification.timestamp}
          buttonText={notification.buttonText}
          buttonLink={notification.buttonLink}
          unread={notification.unread}
          selected={notification.id === selectedNotificationId}
          onClick={() => onSelectNotification(notification.id)}
          onReadStatusChange={onReadStatusChange}
        />
      ))}
    </div>
  );
};

export default NotificationMenuList;
