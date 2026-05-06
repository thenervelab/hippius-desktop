"use client";

import React from "react";
import Image from "next/image";
import { OnboardingScreen } from "./onboardingData";

interface OnboardingRightPanelProps {
  screen: OnboardingScreen;
}

const OnboardingRightPanel = ({ screen }: OnboardingRightPanelProps) => {
  return (
    // Fill the motion.div (absolute inset-0) from the parent
    <div className="w-full h-full relative overflow-hidden">

      {/*
        Preview card:
        - Starts at 30% from the top → occupies the bottom 70% of the panel
        - 10% left margin so the background image is visible on the left
        - Extends 6% past the right edge (clipped by overflow-hidden above)
          giving the "slides off-screen to the right" effect from Figma
        - Bottom flush with the panel edge (no bottom gap)
        - Only top corners are rounded; bottom edges reach the panel boundary
      */}
      <div
        className="absolute top-[16%] right-[0] bottom-0 rounded-tl-[14px] rounded-tr-[14px] overflow-hidden"
        style={{ left: screen.previewLeft ?? "10%" }}
      >

        {screen.previewImageDark ? (
          <>
            <Image
              src={screen.previewImage}
              alt={`Preview for ${screen.heading}`}
              fill
              unoptimized
              className="object-cover object-left-top dark:opacity-0 transition-opacity duration-300"
            />
            <Image
              src={screen.previewImageDark}
              alt={`Preview for ${screen.heading}`}
              fill
              unoptimized
              className="object-cover object-left-top opacity-0 dark:opacity-100 transition-opacity duration-300"
            />
          </>
        ) : (
          <Image
            src={screen.previewImage}
            alt={`Preview for ${screen.heading}`}
            fill
            unoptimized
            className="object-cover object-left-top"
          />
        )}
      </div>
    </div>
  );
};

export default OnboardingRightPanel;
