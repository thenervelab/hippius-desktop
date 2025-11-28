import React from "react";
import { InView } from "react-intersection-observer";
import { RevealTextLine } from "@/app/components/ui";
import Lock from "../../ui/icons/Lock";

const VPNStatusIndicator = () => {
  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="flex items-center justify-center gap-3">
          {/* Connected Part */}
          <RevealTextLine reveal={inView} delay={100}>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-2  rounded-lg ">
                <span className="p-1 rounded-full bg-success-70">
                  <span className="block w-1.5 h-1.5 rounded-full bg-success-50"></span>
                </span>
              </span>
              <span className="font-medium text-[15px] leading-5 text-grey-10">
                Connected
              </span>
            </div>
          </RevealTextLine>

          {/* Divider */}
          <RevealTextLine reveal={inView} delay={200}>
            <div className="w-[1px] h-5 bg-grey-70" />
          </RevealTextLine>

          {/* Encrypted Part */}
          <RevealTextLine reveal={inView} delay={300}>
            <div className="flex items-center gap-2">
              <Lock className="w-3.5 h-3.5 text-grey-10" />
              <span className="font-medium text-[15px] leading-5 text-grey-10">
                Encrypted
              </span>
            </div>
          </RevealTextLine>
        </div>
      )}
    </InView>
  );
};

export default VPNStatusIndicator;
