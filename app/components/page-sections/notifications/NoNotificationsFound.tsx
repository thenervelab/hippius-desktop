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
      <div className="size-[72px] rounded-2xl bg-grey-light-400 dark:bg-black-400 border border-grey-dark-100 dark:border-black-300 flex items-center justify-center mb-4 shadow-sm">
        <Icons.Notification className="size-8 text-primary-50" />
      </div>
      <h3 className="text-[#0a0a0a] dark:text-white font-bold text-[16px] tracking-[-0.32px]">Nothing here</h3>
      <p className="text-[13px] text-grey-dark-800 dark:text-grey-dark-600 mt-2 max-w-[15rem] leading-5">
        This is the notifications center. Any update will be present here.
      </p>
    </div>
  );
};

export default NoNotificationsFound;
