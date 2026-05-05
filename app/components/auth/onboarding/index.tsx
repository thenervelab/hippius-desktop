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
    // Same outer wrapper as login/page.tsx — background image fills the whole screen
    <div className="fixed inset-0 bg-cover bg-center bg-no-repeat
                    bg-[url('/logged-out-app-background.png')]
                    dark:bg-[url('/logged-out-app-background-dark.png')]">

      {/* Same inner layout as AuthLayout — 4px padding, left 42% / right fills */}
      <main className="relative h-full w-full flex items-stretch p-[min(0.25rem,4px)] overflow-y-auto no-scrollbar">

        {/* ── Left column — rounded to match LeftCarouselPanel ── */}
        <div className="w-[42%] shrink-0 h-full flex flex-col
                        bg-grey-light-200 dark:bg-black-500 rounded-[11px] overflow-hidden">

          {/* Titlebar — no border-b, same as LeftCarouselPanel */}
          <div className="relative">
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

        {/* ── Right panel — transparent so background image shows through ── */}
        <div className="flex-1 h-full">
          <OnboardingRightPanel
            key={`preview-${currentPanelIndex}`}
            screen={currentScreen}
          />
        </div>

      </main>
    </div>
  );
};

export default Onboarding;
