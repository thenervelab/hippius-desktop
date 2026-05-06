"use client";

import React, { useState, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ONBOARDING_SCREENS } from "./onboardingData";
import { setOnboardingDone } from "@/app/lib/helpers/onboardingDb";
import AuthTitleBar from "@/components/auth/AuthTitleBar";
import OnboardingLeftPanel from "./OnboardingLeftPanel";
import OnboardingRightPanel from "./OnboardingRightPanel";

// Slide variants — direction: +1 = forward (next), -1 = backward (previous)
const slideVariants = {
  enter: (dir: number) => ({
    x: dir >= 0 ? 48 : -48,
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
  },
  exit: (dir: number) => ({
    x: dir >= 0 ? -48 : 48,
    opacity: 0,
  }),
};

const slideTransition = {
  duration: 0.28,
  ease: [0.4, 0, 0.2, 1],
};

const fadeVariants = {
  enter: { opacity: 0 },
  center: { opacity: 1 },
  exit: { opacity: 0 },
};

const fadeTransition = { duration: 0.3, ease: "easeInOut" };

const Onboarding: React.FC<{
  setOnboardingCompleted: (completed: boolean) => void;
}> = ({ setOnboardingCompleted }) => {
  const [currentPanelIndex, setCurrentPanelIndex] = useState(0);
  const directionRef = useRef(1); // tracks last navigation direction for animation

  const isFirstPanel = currentPanelIndex === 0;
  const isLastPanel = currentPanelIndex === ONBOARDING_SCREENS.length - 1;
  const currentScreen = ONBOARDING_SCREENS[currentPanelIndex];

  const handlePrevious = () => {
    if (currentPanelIndex > 0) {
      directionRef.current = -1;
      setCurrentPanelIndex((i) => i - 1);
    }
  };

  const handleNext = async () => {
    if (!isLastPanel) {
      directionRef.current = 1;
      setCurrentPanelIndex((i) => i + 1);
    } else {
      await handleOnBoardingDone();
    }
  };

  const handleOnBoardingDone = async () => {
    await setOnboardingDone(true);
    setOnboardingCompleted(true);
  };

  return (
    // Same outer wrapper as login/page.tsx — background image fills the whole screen
    <div className="fixed inset-0 bg-cover bg-center bg-no-repeat
                    bg-[url('/logged-out-app-background.png')]
                    dark:bg-[url('/logged-out-app-background-dark.png')]">

      {/* Left panel has 4px inset on all sides; right panel is flush on right + bottom */}
      <main className="relative h-full w-full flex items-stretch pt-[min(0.25rem,4px)] pl-[min(0.25rem,4px)] overflow-y-auto no-scrollbar">

        {/* ── Left column — rounded to match LeftCarouselPanel ── */}
        <div className="w-[42%] shrink-0 flex flex-col
                        mb-[min(0.25rem,4px)]
                        bg-grey-light-200 dark:bg-black-500 rounded-[11px] overflow-hidden">

          {/* Titlebar stays fixed — only the content below it animates */}
          <div className="relative shrink-0">
            <AuthTitleBar />

            {!isFirstPanel && (
              <button
                onClick={handleOnBoardingDone}
                className="absolute top-0 right-5 h-full flex items-center
                           z-[20] pointer-events-auto
                           text-[14px] font-medium text-grey-50 dark:text-grey-dark-700
                           hover:text-grey-10 dark:hover:text-grey-primary-bg
                           transition-colors"
              >
                Skip
              </button>
            )}
          </div>

          {/* Animated slide content */}
          <div className="flex-1 min-h-0 overflow-hidden relative">
            <AnimatePresence custom={directionRef.current} mode="wait">
              <motion.div
                key={currentPanelIndex}
                custom={directionRef.current}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={slideTransition}
                className="absolute inset-0 flex flex-col"
              >
                <OnboardingLeftPanel
                  screen={currentScreen}
                  currentPanelIndex={currentPanelIndex}
                  totalScreens={ONBOARDING_SCREENS.length}
                  isFirstPanel={isFirstPanel}
                  handlePrevious={handlePrevious}
                  handleNext={handleNext}
                  handleOnBoardingDone={handleOnBoardingDone}
                />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* ── Right panel — crossfades between slides ── */}
        <div className="flex-1 relative">
          <AnimatePresence mode="wait">
            <motion.div
              key={`preview-${currentPanelIndex}`}
              variants={fadeVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={fadeTransition}
              className="absolute inset-0"
            >
              <OnboardingRightPanel screen={currentScreen} />
            </motion.div>
          </AnimatePresence>
        </div>

      </main>
    </div>
  );
};

export default Onboarding;
