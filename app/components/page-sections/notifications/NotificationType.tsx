import React from "react";
import { cn } from "@/app/lib/utils";

interface NotificationTypeProps {
  type: string;
}

const NotificationType: React.FC<NotificationTypeProps> = ({ type }) => (
  <div className="flex items-center justify-start self-start gap-1 px-2 py-1 bg-success-90 rounded mb-1">
    {/* Outer circle ring */}
    <span className={cn("p-1 rounded-full bg-success-70")}>
      {/* Inner dot */}
      <span className={cn("block w-2 h-2 rounded-full bg-success-50")} />
    </span>
    {/* Notification type */}
    <span className="text-xs leading-[18px] font-medium text-grey-10">
      {type}
    </span>
  </div>
);

export default NotificationType;
