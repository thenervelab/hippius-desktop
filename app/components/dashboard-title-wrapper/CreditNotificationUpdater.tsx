"use client";

import { InView } from "react-intersection-observer";
import { RevealTextLine } from "@/app/components/ui";
import { Icons } from "@/app/components/ui";
import { useCreditsNotification } from "@/app/lib/hooks/useCreditsNotification";

interface CreditNotificationUpdaterProps {
  className?: string;
}
const CreditNotificationUpdater: React.FC<CreditNotificationUpdaterProps> = ({
  className = "delay-500",
}) => {
  useCreditsNotification();

  // Otherwise use InView to manage the reveal state
  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref}>
          <RevealTextLine reveal={inView} className={className}>
            <span className="text-grey-60 bg-grey-90 p-2.5 rounded">
              <Icons.Notification className="text-grey-70 size-4" />
            </span>
          </RevealTextLine>
        </div>
      )}
    </InView>
  );
};

export default CreditNotificationUpdater;
