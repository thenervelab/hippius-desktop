"use client";

import { InView } from "react-intersection-observer";
import { RevealTextLine } from "@/app/components/ui";

const VPNIconButton: React.FC<{
  className?: string;
}> = ({ className }) => {
  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="flex items-center justify-center h-full mr-4">
          <RevealTextLine reveal={inView} className={className}>
            <span className="bg-white border border-grey-80 rounded-[4px] relative flex items-center justify-center h-[36px] w-[36px]">
              <span className="text-grey-10 font-medium text-[10px] leading-4 tracking-[-0.2px]">
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
