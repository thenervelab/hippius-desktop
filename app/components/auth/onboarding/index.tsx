import React, { useState } from "react";
import OnboardingLeftPanel from "./OnboardingLeftPanel";
import OnboardingRightPanel from "./OnboardingRightPanel";
import { ONBOARDING_SCREENS } from "./onboardingData";
import { setOnboardingDone } from "@/app/lib/helpers/onboardingDb";

const Onboarding: React.FC<{
  setOnboardingCompleted: (completed: boolean) => void;
}> = ({ setOnboardingCompleted }) => {
  const [currentPanelIndex, setCurrentPanelIndex] = useState(0);
  const isFirstPanel = currentPanelIndex === 0;
  const isLastPanel = currentPanelIndex === ONBOARDING_SCREENS.length - 1;

  const handlePrevious = () => {
    if (currentPanelIndex > 0) {
      setCurrentPanelIndex(currentPanelIndex - 1);
    }
  };

  const handleNext = async () => {
    if (currentPanelIndex < ONBOARDING_SCREENS.length - 1) {
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
    <>
      {/* Left Panel */}
      <OnboardingLeftPanel currentPanelIndex={currentPanelIndex} />

      {/* Right Panel  */}

      <OnboardingRightPanel
        currentPanelIndex={currentPanelIndex}
        isFirstPanel={isFirstPanel}
        isLastPanel={isLastPanel}
        handlePrevious={handlePrevious}
        handleNext={handleNext}
        handleOnBoardingDone={handleOnBoardingDone}
      />
    </>
  );
};

export default Onboarding;
