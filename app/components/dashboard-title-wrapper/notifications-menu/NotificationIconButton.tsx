"use client";

import { Icons } from "@/app/components/ui";
import { Button } from "@/components/ui/button/ButtonV2";
import cn from "@/app/lib/utils/cn";

const NotificationIconButton: React.FC<{
  className?: string;
  count: number;
}> = ({ className, count }) => {
  return (
    <Button
      type="button"
      variant="ghost"
      size="noStyle"
      className={cn(
        "relative inline-flex h-[34px] w-[35px] items-center justify-center rounded-[12px] bg-[rgba(0,0,0,0.08)] p-[10px] text-grey-60 hover:bg-[rgba(0,0,0,0.12)]",
        "dark:bg-white/20 dark:opacity-60 dark:hover:bg-white/30 dark:hover:opacity-100",
        "transition-colors duration-150 active:translate-y-0 active:scale-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50 focus-visible:ring-offset-2",
        className,
      )}
    >
      <Icons.Notification className="size-4 text-grey-10 opacity-40 dark:text-grey-light-100 dark:opacity-100" />
      {count > 0 && (
        <span
          className={cn(
            "absolute top-0.5 right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary-50 px-1.5 py-[1px] text-[0.5625rem] text-white",
            count > 99 && "right-0 h-5 w-5",
          )}
          data-testid="notification-unread-count"
        >
          {count}
        </span>
      )}
    </Button>
  );
};

export default NotificationIconButton;
