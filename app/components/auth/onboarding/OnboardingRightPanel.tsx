"use client";

import React from "react";
import Image from "next/image";
import { OnboardingScreen } from "./onboardingData";

interface OnboardingRightPanelProps {
  screen: OnboardingScreen;
}

const OnboardingRightPanel = ({ screen }: OnboardingRightPanelProps) => {
  return (
    // Transparent — background image from the outer login-page wrapper shows through
    <div className="w-full h-full flex items-center justify-center">

      {/* App preview card — floats in center like the sign-in card on the login page */}
      <div className="relative w-[82%] h-[76%] rounded-[12px] overflow-hidden
                      shadow-2xl
                      border border-black/[0.06] dark:border-white/[0.05]">

        {screen.previewImageDark ? (
          <>
            <Image
              src={screen.previewImage}
              alt={`Preview for ${screen.heading}`}
              fill
              unoptimized
              className="object-cover object-top dark:opacity-0 transition-opacity duration-300"
            />
            <Image
              src={screen.previewImageDark}
              alt={`Preview for ${screen.heading}`}
              fill
              unoptimized
              className="object-cover object-top opacity-0 dark:opacity-100 transition-opacity duration-300"
            />
          </>
        ) : (
          <Image
            src={screen.previewImage}
            alt={`Preview for ${screen.heading}`}
            fill
            unoptimized
            className="object-cover object-top"
          />
        )}
      </div>
    </div>
  );
};

export default OnboardingRightPanel;
