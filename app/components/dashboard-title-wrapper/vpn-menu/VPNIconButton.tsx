"use client";

import { InView } from "react-intersection-observer";
import { RevealTextLine } from "@/app/components/ui";
import cn from "@/app/lib/utils/cn";

const VPNIconButton: React.FC<{
  className?: string;
  isConnected?: boolean;
}> = ({ className, isConnected = false }) => {
  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="flex items-center justify-center h-full mr-4">
          <RevealTextLine reveal={inView} className={className}>
            <span
              className={cn(
                "border rounded-[4px] relative flex items-center justify-center h-[36px] min-w-[36px] px-2 transition-colors duration-200",
                isConnected
                  ? "bg-primary-50 border-primary-50"
                  : "bg-white border-grey-80"
              )}
            >
              <span
                className={cn(
                  "font-medium text-[10px] leading-4 tracking-[-0.2px]",
                  isConnected ? "text-white" : "text-grey-10"
                )}
              >
                VPN
              </span>
            </span>
          </RevealTextLine>
        </div>
      )}
    </InView>
  );
};

export default VPNIconButton;
