import React from "react";
import { cn } from "@/lib/utils";

interface NoNotificationsFoundProps {
  heightClassName?: string;
}

const NoNotificationsFound: React.FC<NoNotificationsFoundProps> = ({
  heightClassName = "h-[80.9vh]",
}) => {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center w-full px-6",
        heightClassName
      )}
    >
      <div className="mb-4">
        <img
          src="/assets/notifications/notification-center.png"
          alt="No notifications"
          className="size-[96px] object-contain dark:hidden"
        />
        <img
          src="/assets/notifications/notification-center-dark.png"
          alt="No notifications"
          className="size-[96px] object-contain hidden dark:block"
        />
      </div>
      <h3 className="text-[#0a0a0a] dark:text-white font-bold text-[16px] tracking-[-0.32px]">Nothing here</h3>
      <p className="text-[13px] text-grey-dark-800 dark:text-grey-dark-600 mt-2 max-w-[15rem] leading-5">
        This is the notifications center. Any update will be present here.
      </p>
    </div>
  );
};

export default NoNotificationsFound;
