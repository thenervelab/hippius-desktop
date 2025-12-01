import React from "react";
import {
  AbstractCity,
  Graphsheet,
  RevealTextLine,
  Icons,
} from "@/components/ui";
import { InView } from "react-intersection-observer";
import Link from "next/link";
import AnimatedRings from "./AnimatedRings";
import { PHASE_CONTENT } from "./SplashContent";
import AnimatedProgressIcon from "./AnimatedIcons";
import { AnimatePresence, motion } from "framer-motion";
import { useAtomValue } from "jotai";
import { stepAtom } from "./atoms";
import {
  updateCheckCompleteAtom,
  updateDialogOpenAtom,
  updateStore,
} from "@/app/components/updater/updateStore";

const SplashScreen = () => {
  const step = useAtomValue(stepAtom);
  const updateCheckComplete = useAtomValue(updateCheckCompleteAtom);
  const updateDialogOpen = useAtomValue(updateDialogOpenAtom, {
    store: updateStore,
  });

  const contentArr = Object.values(PHASE_CONTENT);

  // When update dialog is open, freeze everything and show no UI elements
  if (updateDialogOpen) {
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
        {/* No other UI elements when update dialog is open */}
      </div>
    );
  }

  // Normal splash screen logic when update dialog is not open
  const showProgress = step >= 0 && step < contentArr.length;

  // During update check, show custom content
  const isUpdateMode = !updateCheckComplete;
  const progressData = isUpdateMode
    ? {
        status: "Checking for Updates",
        subStatus: "Please wait while we check for new version...",
        icon: <Icons.CheckingIPFS className="h-[140px] w-[230px]" />,
      }
    : contentArr[step];

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
                className="delay-400  [@media(max-height:750px)]:mb-[15%] lg:mb-[27%] mb-4"
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
            </div>
          )}
        </InView>
      )}
    </div>
  );
};

export default SplashScreen;
