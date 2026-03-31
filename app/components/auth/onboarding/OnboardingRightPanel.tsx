import React, { useEffect, useState } from "react";
import { CardButton, Icons, RevealTextLine } from "@/components/ui";
import { ONBOARDING_SCREENS } from "./onboardingData";

import HippiusHeader from "@/components/auth/HippiusHeader";
import { InView } from "react-intersection-observer";
import ProgressBar from "./ProgressBar";

interface OnboardingRightPanelProps {
  currentPanelIndex: number;
  isFirstPanel: boolean;
  isLastPanel: boolean;
  handlePrevious: () => void;
  handleNext: () => void;
  handleOnBoardingDone: () => void;
}

const OnboardingRightPanel = ({
  currentPanelIndex,
  isFirstPanel,
  isLastPanel,
  handlePrevious,
  handleNext,
  handleOnBoardingDone
}: OnboardingRightPanelProps) => {
  const currentPanel = ONBOARDING_SCREENS[currentPanelIndex];
  const total = ONBOARDING_SCREENS.length;
  const step = currentPanelIndex + 1;

  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    setAnimate(false);
    const t = setTimeout(() => setAnimate(true), 20);
    return () => clearTimeout(t);
  }, [currentPanelIndex]);
  return (
    <InView>
      {({ inView, ref }) => (
        <div ref={ref} className="relative h-full w-full">
            <div className="absolute z-3 inset-0 flex flex-col justify-between h-full w-full overflow-y-auto no-scrollbar">
            <div className="flex flex-col w-full">
                <div className="flex justify-between gap-[min(1rem,16px)] items-center mb-[min(2.5rem,40px)]">
                <HippiusHeader isOnboarding />
                {(!isFirstPanel || !isLastPanel) && (
                    <div className="text-grey-60 text-[min(1rem,16px)] font-medium cursor-pointer"
                    onClick={handleOnBoardingDone}
                  >
                    <RevealTextLine
                      rotate
                      reveal={inView}
                      className="delay-300 hover:underline"
                    >
                      Skip
                    </RevealTextLine>
                  </div>
                )}
              </div>

              <div className="flex flex-col ">
                <RevealTextLine
                  rotate
                  reveal={inView && animate}
                  key={`title-${currentPanelIndex}`}
                  parentClassName="mb-[min(1.5rem,24px)] w-full"
                  className="delay-300 w-full"
                >
                    <div className="flex justify-between text-[min(1.5rem,24px)] font-medium text-grey-10 w-full">
                    <div>{currentPanel.screentTitleText}</div>
                    <div>
                      {currentPanel.id} / {ONBOARDING_SCREENS.length}
                    </div>
                  </div>
                </RevealTextLine>

                <ProgressBar totalSteps={total} currentStep={step} />
                {/* Bullet points */}
                {currentPanel.bulletPoints &&
                  currentPanel.bulletPoints.length > 0 && (
                    <>
                      <div className="mt-[min(2.5rem,40px)]">
                        <RevealTextLine
                          rotate
                          reveal={inView && animate}
                          className="delay-300"
                          key={`head-${currentPanelIndex}`}
                        >
                          <h2 className="text-[min(1.5rem,24px)] text-primary-50">
                            What Makes Us Stand Out
                          </h2>
                        </RevealTextLine>

                        <div className="flex flex-col gap-[min(1rem,16px)] mt-[min(1rem,16px)]">
                          {currentPanel.bulletPoints.map((point, index) => (
                            <RevealTextLine
                              rotate
                              reveal={inView && animate}
                              className={`delay-${400 + index * 100}`}
                              key={`pt-${currentPanelIndex}-${index}`}
                            >
                              <div className="flex items-center gap-2">
                                <Icons.ArrowRight className="text-primary-90 size-5" />

                                <span className="text-grey-50 font-medium text-[min(1rem,16px)] leadin-[1.375rem]">
                                  {point}
                                </span>
                              </div>
                            </RevealTextLine>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
              </div>
            </div>

            <div className="flex gap-[min(5rem,80px)] self-end h-[min(3.125rem,50px)] w-full">
              {!isFirstPanel && (
                <CardButton
                  className="w-full"
                  variant="secondary"
                  onClick={handlePrevious}
                >
                  <div className="flex items-center gap-2 text-[min(1.125rem,18px)] font-medium text-grey-10">
                    Previous
                  </div>
                </CardButton>
              )}

              <CardButton className="w-full" onClick={handleNext}>
                <div className="flex items-center gap-2">
                  {isFirstPanel ? (
                    <span className="flex items-center text-[min(1.125rem,18px)] font-medium">
                      Get Started
                    </span>
                  ) : isLastPanel ? (
                    <>
                      <span className="flex items-center text-[min(1.125rem,18px)] font-medium">
                        Continue
                      </span>
                      <Icons.ArrowRight className="size-4" />
                    </>
                  ) : (
                    <>
                      <span className="flex items-center text-[min(1.125rem,18px)] font-medium">
                        Next
                      </span>
                    </>
                  )}
                </div>
              </CardButton>
            </div>
          </div>
        </div>
      )}
    </InView>
  );
};

export default OnboardingRightPanel;
