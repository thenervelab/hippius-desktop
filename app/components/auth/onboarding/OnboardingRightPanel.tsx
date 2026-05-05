"use client";

import React from "react";
import Image from "next/image";
import { OnboardingScreen } from "./onboardingData";

interface OnboardingRightPanelProps {
  screen: OnboardingScreen;
}

const OnboardingRightPanel = ({ screen }: OnboardingRightPanelProps) => {
  return (
    // Figma: light outer bg #EBEBEB, dark outer bg #1C1C1C
    <div className="flex-1 relative overflow-hidden flex items-center justify-center
                    bg-[#EBEBEB] dark:bg-[#1C1C1C]">

      {/* Dot pattern — light mode */}
      <div
        className="absolute inset-0 dark:hidden"
        style={{
          backgroundImage: "radial-gradient(circle, #C8C8C8 1px, transparent 1px)",
          backgroundSize: "28px 28px",
        }}
      />
      {/* Dot pattern — dark mode (very subtle) */}
      <div
        className="absolute inset-0 hidden dark:block"
        style={{
          backgroundImage: "radial-gradient(circle, #EBEBEB 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          opacity: 0.06,
        }}
      />

      {/* Radial vignette to add depth around the card */}
      <div
        className="absolute inset-0 dark:hidden pointer-events-none"
        style={{
          background: "radial-gradient(ellipse 70% 70% at 50% 50%, transparent 40%, rgba(0,0,0,0.06) 100%)",
        }}
      />
      <div
        className="absolute inset-0 hidden dark:block pointer-events-none"
        style={{
          background: "radial-gradient(ellipse 70% 70% at 50% 50%, transparent 40%, rgba(0,0,0,0.4) 100%)",
        }}
      />

      {/* App preview card */}
      <div className="relative w-[82%] h-[76%] rounded-[12px] overflow-hidden
                      shadow-2xl
                      border border-black/[0.08] dark:border-white/[0.06]">

        {screen.previewImageDark ? (
          <>
            {/* Light image — hidden in dark mode when dark variant exists */}
            <Image
              src={screen.previewImage}
              alt={`Preview for ${screen.heading}`}
              fill
              unoptimized
              className="object-cover object-top dark:opacity-0 transition-opacity duration-300"
            />
            {/* Dark image — overlaid on top */}
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
