import React from "react";
import { Icons, AbstractIconWrapper, RevealTextLine } from "@/components/ui";
import { InView } from "react-intersection-observer";
import { cn } from "@/lib/utils";

interface NoNotificationsFoundProps {
  heightClassName?: string;
}

const NoNotificationsFound: React.FC<NoNotificationsFoundProps> = ({
  heightClassName = "h-[80.9vh]",
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
            <Icons.Notification className="relative size-6 text-primary-50" />
          </AbstractIconWrapper>
          <h3 className="text-grey-10 font-medium text-base block">
            <RevealTextLine reveal={!!inView}>No Notifications</RevealTextLine>
          </h3>
          <p className="text-xs text-grey-60 mt-1">
            <RevealTextLine reveal={!!inView}>
              Try adjusting the options to see more results.
            </RevealTextLine>
          </p>
        </div>
      )}
    </InView>
  );
};

export default NoNotificationsFound;
