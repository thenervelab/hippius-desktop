import React from "react";
import { Icons } from "@/components/ui";
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
      <div className="size-14 rounded-full bg-grey-95 flex items-center justify-center mb-4">
        <Icons.Notification className="size-7 text-grey-60" />
      </div>
      <h3 className="text-grey-10 font-semibold text-base">Nothing here</h3>
      <p className="text-sm text-grey-50 mt-1.5 max-w-[16rem] leading-5">
        This is the notifications center. Any update will be present here.
      </p>
    </div>
  );
};

export default NoNotificationsFound;
