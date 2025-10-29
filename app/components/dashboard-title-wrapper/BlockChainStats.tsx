"use client";

import { RevealTextLine } from "@/components/ui";
import { InView } from "react-intersection-observer";
import NotificationMenu from "./notifications-menu";

const BlockchainStats: React.FC = () => {

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="flex items-center justify-center h-full text-sm"
        >
          <NotificationMenu />
          <RevealTextLine reveal={inView} className="delay-400">
            <div className="w-0.5 h-8 bg-grey-80 ml-4"></div>
          </RevealTextLine>
        </div>
      )}
    </InView>
  );
};

export default BlockchainStats;
