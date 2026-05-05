"use client";

import React, { useState } from "react";
import { ONBOARDING_SCREENS } from "./onboardingData";
import { setOnboardingDone } from "@/app/lib/helpers/onboardingDb";
import AuthTitleBar from "@/components/auth/AuthTitleBar";
import OnboardingLeftPanel from "./OnboardingLeftPanel";
import OnboardingRightPanel from "./OnboardingRightPanel";

const Onboarding: React.FC<{
  setOnboardingCompleted: (completed: boolean) => void;
}> = ({ setOnboardingCompleted }) => {
  const [currentPanelIndex, setCurrentPanelIndex] = useState(0);
  const isFirstPanel = currentPanelIndex === 0;
  const isLastPanel = currentPanelIndex === ONBOARDING_SCREENS.length - 1;
  const currentScreen = ONBOARDING_SCREENS[currentPanelIndex];

  const handlePrevious = () => {
    if (currentPanelIndex > 0) setCurrentPanelIndex(currentPanelIndex - 1);
  };

  const handleNext = async () => {
    if (!isLastPanel) {
      setCurrentPanelIndex(currentPanelIndex + 1);
    } else {
      await handleOnBoardingDone();
    }
  };

  const handleOnBoardingDone = async () => {
    await setOnboardingDone(true);
    setOnboardingCompleted(true);
  };

  return (
    <div className="flex w-full h-full">

      {/* ── Left column — header + content share same background ── */}
      <div className="w-[42%] shrink-0 h-full flex flex-col bg-white dark:bg-black-500">

        {/* Title bar — reuse AuthTitleBar (handles Mac/Win traffic-light padding).
            Wrap in a relative row so we can overlay the Skip button on the right. */}
        <div
          className="relative flex items-center shrink-0
                     border-b border-grey-80 dark:border-black-300"
        >
          <AuthTitleBar />

          {!isFirstPanel && (
            <button
              onClick={handleOnBoardingDone}
              className="absolute right-5 pointer-events-auto
                         text-[14px] font-medium text-grey-50 dark:text-grey-dark-700
                         hover:text-grey-10 dark:hover:text-grey-primary-bg
                         transition-colors"
            >
              Skip
            </button>
          )}
        </div>

        {/* Left panel fills the remaining height */}
        <OnboardingLeftPanel
          key={currentPanelIndex}
          screen={currentScreen}
          currentPanelIndex={currentPanelIndex}
          totalScreens={ONBOARDING_SCREENS.length}
          isFirstPanel={isFirstPanel}
          handlePrevious={handlePrevious}
          handleNext={handleNext}
          handleOnBoardingDone={handleOnBoardingDone}
        />
      </div>

      {/* ── Right panel ── */}
      <OnboardingRightPanel
        key={`preview-${currentPanelIndex}`}
        screen={currentScreen}
      />
    </div>
  );
};

export default Onboarding;
