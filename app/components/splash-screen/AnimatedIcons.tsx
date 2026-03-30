import React, { useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { InView } from "react-intersection-observer";
import { RevealTextLine } from "@/components/ui";

type AnimatedProgressIconProps = {
  icon: React.ReactNode;
  status: string;
  step: number;
  showProgressBar?: boolean;
};

export default function AnimatedProgressIcon({
  icon,
  status,
  step,
  showProgressBar = true,
}: AnimatedProgressIconProps) {
  const hasAnimatedRef = useRef(false);

  // If showProgressBar is false and we've already animated, use a static key to prevent re-animation
  const presenceKey =
    !showProgressBar && hasAnimatedRef.current
      ? "static-icon"
      : `${step}-${status}`;

  // Mark as animated on first render when showProgressBar is false
  if (!showProgressBar && !hasAnimatedRef.current) {
    hasAnimatedRef.current = true;
  }

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="flex items-center justify-center absolute z-20 overflow-hidden"
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={presenceKey}
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -30 }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
              className="h-[15.625rem] w-[15.625rem] flex items-center justify-center overflow-hidden"
            >
              <RevealTextLine reveal={inView}>
                <div className="h-full w-full flex items-center justify-center overflow-hidden">
                  {icon}
                </div>
              </RevealTextLine>
            </motion.div>
          </AnimatePresence>
        </div>
      )}
    </InView>
  );
}
