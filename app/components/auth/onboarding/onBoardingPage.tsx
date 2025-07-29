"use client";

import BaseAuthLayout from "../BaseAuthLayout";
import Onboarding from ".";

const OnboardingPage: React.FC<{
  onboardingCompleted: boolean | null;
  setOnboardingCompleted: (completed: boolean) => void;
}> = ({ onboardingCompleted, setOnboardingCompleted }) => {
  if (!onboardingCompleted) {
    return (
      <BaseAuthLayout onboardingCompleted={onboardingCompleted}>
        <Onboarding setOnboardingCompleted={setOnboardingCompleted} />
      </BaseAuthLayout>
    );
  }

  return null;
};

export default OnboardingPage;
