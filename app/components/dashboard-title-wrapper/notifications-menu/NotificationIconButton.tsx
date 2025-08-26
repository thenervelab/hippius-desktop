"use client";

import { Icons } from "@/app/components/ui";

import { InView } from "react-intersection-observer";
import { RevealTextLine } from "@/app/components/ui";
import cn from "@/app/lib/utils/cn";
const NotificationIconButton: React.FC<{
  className?: string;
  count: number;
}> = ({ className, count }) => {
  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="flex items-center justify-center h-full">
          <RevealTextLine reveal={inView} className={className}>
            <span className="text-grey-60 bg-grey-90 p-2.5 rounded relative">
              <Icons.Notification className="text-grey-70 size-4" />
              {count > 0 && (
                <span
                  className={cn(
                    "absolute top-0.5 right-0.5 bg-primary-50 text-white text-[9px] rounded-full px-1.5 w-3.5 h-3.5 py-[1px] flex items-center justify-center",
                    count > 99 && "right-0 w-5 h-5"
                  )}
                  data-testid="notification-unread-count"
                >
                  {count}
                </span>
              )}
            </span>
          </RevealTextLine>
        </div>
      )}
    </InView>
  );
};

export default NotificationIconButton;
