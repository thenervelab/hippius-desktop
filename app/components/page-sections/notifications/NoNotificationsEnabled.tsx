import React from "react";
import { Icons, AbstractIconWrapper, RevealTextLine } from "@/components/ui";
import { InView } from "react-intersection-observer";
import { cn } from "@/lib/utils";

interface NoNotificationsEnabledProps {
  heightClassName?: string;
  onOpenSettings: () => void;
}

const NoNotificationsEnabled: React.FC<NoNotificationsEnabledProps> = ({
  heightClassName = "h-[80.9vh]",
  onOpenSettings
}) => {
  return (
    <InView triggerOnce>
      {({ ref, inView }) => (
        <div
          ref={ref}
          className={cn(
            "p-6 flex flex-col items-center justify-center text-center w-full",
            heightClassName
          )}
        >
          <AbstractIconWrapper className="size-12 mb-3 bg-gray-100">
            <Icons.Setting className="relative size-6 text-primary-50" />
          </AbstractIconWrapper>
          <h3 className="text-grey-10 font-medium text-base block">
            <RevealTextLine reveal={!!inView}>
              Notifications Disabled
            </RevealTextLine>
          </h3>
          <p className="text-xs text-grey-60 mt-1 mb-4">
            <RevealTextLine reveal={!!inView}>
              You have not enabled any notification preferences. Enable
              notifications to stay updated.
            </RevealTextLine>
          </p>
          <button
            className="px-4 py-2.5 bg-grey-90 rounded text-grey-10 leading-5 text-[14px] font-medium flex items-center gap-2 transition-colors hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white focus:outline-none focus:ring-2 focus:ring-primary-50"
            onClick={onOpenSettings}
          >
            <Icons.Setting className="size-4" />
            Notification Settings
          </button>
        </div>
      )}
    </InView>
  );
};

export default NoNotificationsEnabled;
