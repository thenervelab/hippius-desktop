import React from "react";
import NotificationItem from "./NotificationItem";
import { UiNotification } from "./types";

interface NotificationListProps {
  notifications: UiNotification[];
  selectedNotificationId: number | null;
  onSelectNotification: (id: number) => void;
  onReadStatusChange?: (id: number, isUnread: boolean) => void;
}

const NotificationList: React.FC<NotificationListProps> = ({
  notifications,
  selectedNotificationId,
  onSelectNotification,
  onReadStatusChange,
}) => {
  return (
    <div className="flex flex-col gap-4 w-full border border-grey-80 rounded p-4 max-h-[80.9vh] overflow-y-auto overflow-x-hidden pr-2">
      {notifications.map((notification) => (
        <NotificationItem
          key={notification.id}
          id={notification.id}
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

export default NotificationList;
