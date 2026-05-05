"use client";

import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import { HippiusLogo } from "@/components/ui/icons";
import { ONBOARDING_SCREENS } from "./onboardingData";
import { setOnboardingDone } from "@/app/lib/helpers/onboardingDb";
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

        {/* Title bar — drag region, no separate dark bg needed (inherits parent) */}
        <div
          data-tauri-drag-region
          className="flex items-center justify-between pl-20 pr-5 h-11 shrink-0
                     border-b border-grey-80 dark:border-black-300"
        >
          <div className="flex items-center gap-2 select-none pointer-events-none">
            <HippiusLogo className="size-7 bg-primary-50 rounded-[5px] text-white shrink-0" />
            <span className="text-[18px] font-medium leading-[23px]
                             text-grey-10 dark:text-grey-primary-bg">
              Hippius
            </span>
            <ChevronDown className="size-3.5 text-grey-50 dark:text-grey-dark-700" />
          </div>

          {!isFirstPanel && (
            <button
              onClick={handleOnBoardingDone}
              className="text-[14px] font-medium text-grey-50 dark:text-grey-dark-700
                         hover:text-grey-10 dark:hover:text-grey-primary-bg
                         transition-colors pointer-events-auto"
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
