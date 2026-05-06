import React from "react";
import NotificationItem from "./NotificationItem";
import { UiNotification } from "./types";

interface NotificationListProps {
  notifications: UiNotification[];
  selectedNotificationId: number | null;
  onSelectNotification: (id: number) => void;
  onReadStatusChange: (id: number, isUnread: boolean) => void;
  onRefresh?: () => void;
}

const NotificationList: React.FC<NotificationListProps> = ({
  notifications,
  selectedNotificationId,
  onSelectNotification,
  onReadStatusChange,
  onRefresh,
}) => {
  return (
    <div
      className="flex flex-col w-full border border-grey-80 rounded-lg overflow-y-auto overflow-x-hidden divide-y divide-grey-90 bg-white"
      style={{ maxHeight: "calc(100vh - 12rem)" }}
    >
      {notifications.map((notification) => (
        <NotificationItem
          key={notification.id}
          id={notification.id}
          icon={notification.icon}
          notificationType={notification.type}
          notificationSubType={notification.subType}
          notificationText={notification.title}
          notificationDescription={notification.description}
          notificationTime={notification.time}
          timestamp={notification.timestamp}
          buttonText={notification.buttonText}
          buttonLink={notification.buttonLink}
          unread={notification.unread}
          selected={notification.id === selectedNotificationId}
          onClick={() => onSelectNotification(notification.id)}
          onReadStatusChange={onReadStatusChange}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  );
};

export default NotificationList;
