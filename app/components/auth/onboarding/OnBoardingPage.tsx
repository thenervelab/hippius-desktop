"use client";

import React from "react";
import Onboarding from ".";

const OnBoardingPage: React.FC<{
  onboardingCompleted: boolean | null;
  setOnboardingCompleted: (completed: boolean) => void;
}> = ({ onboardingCompleted, setOnboardingCompleted }) => {
  if (!onboardingCompleted) {
    return <Onboarding setOnboardingCompleted={setOnboardingCompleted} />;
  }
  return null;
};

export default OnBoardingPage;
