import React from "react";
import NotificationItem from "./NotificationItem";
import { IconComponent } from "@/app/lib/types";

interface NotificationData {
  id: number;
  icon: IconComponent;
  type: string;
  text: string;
  time: string;
  buttonText?: string;
  buttonLink?: string;
  unread?: boolean;
  description?: string;
  title?: string;
}

interface NotificationListProps {
  notifications: NotificationData[];
  selectedNotificationId: number | null;
  onSelectNotification: (id: number) => void;
}

const NotificationList: React.FC<NotificationListProps> = ({
  notifications,
  selectedNotificationId,
  onSelectNotification,
}) => {
  return (
    <div className="flex flex-col gap-4 w-full border border-grey-80 rounded p-4 max-h-[80.9vh] overflow-y-auto pr-2">
      {notifications.map((notification) => (
        <NotificationItem
          key={notification.id}
          icon={notification.icon}
          notificationType={notification.type}
          notificationText={notification.text}
          notificationTime={notification.time}
          buttonText={notification.buttonText}
          buttonLink={notification.buttonLink}
          unread={notification.unread}
          selected={notification.id === selectedNotificationId}
          onClick={() => onSelectNotification(notification.id)}
        />
      ))}
    </div>
  );
};

export default NotificationList;
