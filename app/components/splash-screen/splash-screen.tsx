import React from "react";
import { AbstractCity, Graphsheet, RevealTextLine, Icons } from "../ui";
import { InView } from "react-intersection-observer";
import Link from "next/link";
import AnimatedRings from "./animated-rings";
import { PHASE_CONTENT } from "./splash-content";
import AnimatedProgressIcon from "./animated-icons";
import { AnimatePresence, motion } from "framer-motion";
import ProgressDisplay from "./progress-display";
import ProgressBarDisplay from "./progress-bar-display";
import { useAtomValue } from "jotai";
import { stepAtom } from "./atoms";

const SplashScreen = () => {
  const step = useAtomValue(stepAtom);
  const contentArr = Object.values(PHASE_CONTENT);
  const showProgress = step >= 0 && step < contentArr.length;
  const progressData = contentArr[step];

  return (
    <div className="flex grow flex-col items-center w-full h-full justify-center bg-primary-10 relative overflow-hidden">
      <div className="absolute block w-full top-0 h-full">
        <AbstractCity animate />
        <div
          className="absolute top-0 w-full h-full"
          style={{
            background:
              "radial-gradient(57.78% 57.78% at 50% 90%, rgba(3, 7, 18, 0) 0%, rgba(5, 12, 32, 0.839) 71.2%, #071336 100%)",
          }}
        />
      </div>
      <div className="absolute w-full top-0 h-[100%] opacity-5">
        <Graphsheet
          majorCell={{
            lineColor: [255, 255, 255, 0.1],
            lineWidth: 2,
            cellDim: 200,
          }}
          minorCell={{
            lineColor: [255, 255, 255, 1.0],
            lineWidth: 1,
            cellDim: 20,
          }}
        />
      </div>
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div ref={ref}>{inView && <AnimatedRings />}</div>
        )}
      </InView>
      {!showProgress && (
        <InView triggerOnce>
          {({ inView, ref }) => (
            <Link
              ref={ref}
              className="flex flex-col text-lg items-center absolute z-20
            justify-center gap-y-6 hover:opacity-70 duration-300 text-white"
              href="/"
            >
              <RevealTextLine rotate reveal={inView}>
                <Icons.HippiusLogoLoader className="h-[100px] w-[100px]" />
              </RevealTextLine>
              <RevealTextLine reveal={inView} className="delay-300">
                <span className="text-[32px] font-medium leading-[40px]">
                  Hippius
                </span>
              </RevealTextLine>
            </Link>
          )}
        </InView>
      )}
      {showProgress && (
        <AnimatedProgressIcon
          status={progressData?.status}
          icon={progressData?.icon}
          step={step}
        />
      )}

      {showProgress && (
        <InView triggerOnce>
          {({ inView, ref }) => (
            <div
              ref={ref}
              className="flex flex-col text-lg items-center absolute z-20
            justify-center gap-y-2 duration-300"
              style={{ top: "72%" }}
            >
              <RevealTextLine rotate reveal={inView}>
                <ProgressDisplay />
              </RevealTextLine>
              <RevealTextLine reveal={inView} className="delay-300">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={step}
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -30 }}
                    transition={{ duration: 0.3 }}
                  >
                    <span className="text-white text-[22px] font-medium">
                      {progressData?.status}
                    </span>
                  </motion.div>
                </AnimatePresence>
              </RevealTextLine>
              <RevealTextLine
                reveal={inView}
                className="delay-400 lg:mb-16 mb-6"
              >
                <AnimatePresence mode="wait">
                  <motion.div
                    key={step}
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -30 }}
                    transition={{ duration: 0.3 }}
                  >
                    <span className="text-sm font-medium text-white">
                      {progressData?.subStatus}
                    </span>
                  </motion.div>
                </AnimatePresence>
              </RevealTextLine>
              <RevealTextLine reveal={inView} className="delay-500">
                <ProgressBarDisplay />
              </RevealTextLine>
            </div>
          )}
        </InView>
      )}
    </div>
  );
};

export default SplashScreen;
