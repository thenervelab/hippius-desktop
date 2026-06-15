"use client";

import React from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import ProgressBar from "./ProgressBar";
import { OnboardingScreen } from "./onboardingData";

interface OnboardingLeftPanelProps {
  screen: OnboardingScreen;
  currentPanelIndex: number;
  totalScreens: number;
  isFirstPanel: boolean;
  handlePrevious: () => void;
  handleNext: () => void;
  handleOnBoardingDone: () => void;
}

const OnboardingLeftPanel = ({
  screen,
  currentPanelIndex,
  totalScreens,
  isFirstPanel,
  handlePrevious,
  handleNext,
  handleOnBoardingDone,
}: OnboardingLeftPanelProps) => {
  return (
    // No background or width here — the parent column in index.tsx owns those
    <div className="flex-1 overflow-y-auto no-scrollbar">
      <div className="flex flex-col h-full px-20 pt-14 pb-20 min-h-0">
        {/* ── Top content ── */}
        <div className="flex flex-col gap-8">
          {/* Badges */}
          <div className="flex items-center gap-2 flex-wrap">
            {screen.badges.map((badge) => (
              <span
                key={badge.text}
                className="inline-flex items-center rounded-[40px] px-[7px] py-[3px] text-[10px] font-medium leading-[12.4px] bg-primary-50 text-grey-primary-bg"
              >
                {badge.text}
              </span>
            ))}
          </div>

          {/* Heading + subtitle */}
          <div className="flex flex-col gap-1">
            <h1
              className="text-[28px] leading-[36px] font-medium text-grey-10 dark:text-grey-primary-bg"
              style={{ letterSpacing: "-0.84px" }}
            >
              {screen.heading}
            </h1>
            <p
              className="text-[16px] leading-[22px] font-medium text-grey-50 dark:text-[#B6B6B6]"
              style={{ letterSpacing: "-0.32px" }}
            >
              {screen.subtitle}
            </p>
          </div>

          {/* Progress bar */}
          <ProgressBar
            totalSteps={totalScreens}
            currentStep={currentPanelIndex + 1}
          />

          {/* Feature link + body */}
          <div className="flex flex-col gap-3">
            <p
              className="text-[16px] leading-[20px] font-medium text-primary-50 dark:text-[#618CE8]"
              style={{ letterSpacing: "-0.32px" }}
            >
              {screen.featureLink}
            </p>
            <p
              className="text-[16px] leading-[22px] font-medium text-grey-50 dark:text-[#979797]"
              style={{ letterSpacing: "-0.32px" }}
            >
              {screen.body}
            </p>
          </div>

          {/* Feature chips */}
          {screen.pills.length > 0 && (
            <div className="flex flex-col gap-3">
              <p
                className="text-[16px] leading-[20px] font-medium text-grey-10 dark:text-[#EBEBEB]"
                style={{ letterSpacing: "-0.32px" }}
              >
                What makes us stand out?
              </p>
              <div className="flex flex-wrap gap-2">
                {screen.pills.map((pill) => (
                  <span
                    key={pill}
                    className="inline-flex items-center rounded-[8px] px-[17px] py-[6px]
                               text-[14px] leading-[20px] font-medium
                               bg-white border border-grey-80 text-grey-50
                               dark:bg-black-400 dark:border-transparent dark:text-grey-dark-600"
                  >
                    {pill}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Spacer pushes buttons to bottom */}
        <div className="flex-1 min-h-8" />

        {/* ── Bottom navigation ── */}
        <div className="flex flex-col gap-[18px]">
          <Button
            variant="primary"
            onClick={handleNext}
            className="w-full h-[52px] rounded-[6px] text-[18px] font-normal"
            style={{ letterSpacing: "-0.36px" }}
          >
            {screen.nextLabel}
            <ArrowRight className="size-4 ml-2" />
          </Button>

          {isFirstPanel ? (
            <Button
              variant="defaultStable"
              onClick={handleOnBoardingDone}
              className="w-full h-[52px] rounded-[6px] text-[18px] font-normal
                         border border-grey-80
                         dark:bg-white/[0.03] dark:hover:bg-[#0000000F]
                         dark:border-[#313131] dark:text-[#EBEBEB]"
              style={{ letterSpacing: "-0.36px" }}
            >
              Skip
            </Button>
          ) : (
            <Button
              variant="defaultStable"
              onClick={handlePrevious}
              className="w-full h-[52px] rounded-[6px] text-[18px] font-normal
                         border border-grey-80
                         dark:bg-white/[0.03] dark:hover:bg-[#0000000F]
                         dark:border-[#313131] dark:text-[#EBEBEB]"
              style={{ letterSpacing: "-0.36px" }}
            >
              Back
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default OnboardingLeftPanel;
