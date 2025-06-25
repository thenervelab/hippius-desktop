import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { InView } from "react-intersection-observer";
import { RevealTextLine } from "../ui";

type AnimatedProgressIconProps = {
  icon: React.ReactNode;
  status: string;
  step: number;
};

export default function AnimatedProgressIcon({
  icon,
  status,
  step,
}: AnimatedProgressIconProps) {
  const presenceKey = `${step}-${status}`;

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
              className="h-[250px] w-[250px] flex items-center justify-center overflow-hidden"
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
