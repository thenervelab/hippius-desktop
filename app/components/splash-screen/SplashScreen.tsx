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
import { UPDATE_CHECK_CONTENT, PHASE_CONTENT } from "./SplashContent";
import AnimatedProgressIcon from "./AnimatedIcons";
import { AnimatePresence, motion } from "framer-motion";
import ProgressDisplay from "./ProgressDisplay";
import ProgressBarDisplay from "./ProgressBarDisplay";
import { useAtomValue } from "jotai";
import { stepAtom, isUpdateCheckPhaseAtom, phaseAtom } from "./atoms";
import {
  updateDialogOpenAtom,
  updateStore,
} from "@/app/components/updater/updateStore";

const SplashScreen = () => {
  const step = useAtomValue(stepAtom);
  const phase = useAtomValue(phaseAtom);
  const isUpdateCheckPhase = useAtomValue(isUpdateCheckPhaseAtom);
  const updateDialogOpen = useAtomValue(updateDialogOpenAtom, {
    store: updateStore,
  });

  // Progress bar shows once we've left the update-check phase and a real
  // phase is active. There is no installer probe to gate on, so this is
  // simply `phase !== null`.
  const showProgressBar = phase !== null;

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
            <div ref={ref}>
              {inView && <AnimatedRings showProgressBar={showProgressBar} />}
            </div>
          )}
        </InView>
        {/* No other UI elements when update dialog is open */}
      </div>
    );
  }

  // Normal splash screen logic when update dialog is not open
  const showProgress = phase !== null;

  // Get progress data - use UPDATE_CHECK_CONTENT during update phase, otherwise use PHASE_CONTENT
  const progressData = isUpdateCheckPhase
    ? UPDATE_CHECK_CONTENT
    : contentArr[step];

  // Key for AnimatePresence - use "update-check" during that phase, otherwise step number
  const animationKey = isUpdateCheckPhase ? "update-check" : step;

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
          <div ref={ref}>
            {inView && <AnimatedRings showProgressBar={showProgressBar} />}
          </div>
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
                <Icons.HippiusLogoLoader className="h-[min(100px,14vh)] w-[min(100px,14vh)]" />
              </RevealTextLine>
              <RevealTextLine reveal={inView} className="delay-300">
                <span className="text-[2rem] font-medium leading-[2.5rem]">
                  Hippius
                </span>
              </RevealTextLine>
            </Link>
          )}
        </InView>
      )}
      {showProgress && showProgressBar && (
        <AnimatedProgressIcon
          status={progressData?.status}
          icon={progressData?.icon}
          step={isUpdateCheckPhase ? -1 : step}
          showProgressBar={showProgressBar}
        />
      )}
      {showProgress && !showProgressBar && (
        <AnimatedProgressIcon
          status={progressData?.status}
          icon={<Icons.SplashHippiusLogo className="h-[min(73px,11vh)] w-[min(74px,11vh)]" />}
          step={isUpdateCheckPhase ? -1 : step}
          showProgressBar={showProgressBar}
        />
      )}

      {showProgress && (
        <InView triggerOnce>
          {({ inView, ref }) => (
            <div
              ref={ref}
              className="flex flex-col text-lg items-center absolute z-20
            justify-center gap-y-1 duration-300"
              style={{ bottom: showProgressBar ? "12%" : "30%" }}
            >
              {showProgressBar && (
                <RevealTextLine rotate reveal={inView}>
                  <ProgressDisplay />
                </RevealTextLine>
              )}
              <RevealTextLine reveal={inView} className="delay-300">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={animationKey}
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -30 }}
                    transition={{ duration: 0.3 }}
                  >
                    <span className="text-white text-[1.375rem] font-medium">
                      {progressData?.status}
                    </span>
                  </motion.div>
                </AnimatePresence>
              </RevealTextLine>
              <RevealTextLine reveal={inView} className="delay-400">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={animationKey}
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -30 }}
                    transition={{ duration: 0.3 }}
                  >
                    <span className="text-[0.875rem] font-medium text-white">
                      {progressData?.subStatus}
                    </span>
                  </motion.div>
                </AnimatePresence>
              </RevealTextLine>
            </div>
          )}
        </InView>
      )}

      {/* Progress bar pinned to the bottom rail. */}
      {showProgress && showProgressBar && (
        <InView triggerOnce>
          {({ inView, ref }) => (
            <div
              ref={ref}
              className="absolute z-20 bottom-[8%] left-1/2 -translate-x-1/2"
            >
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
