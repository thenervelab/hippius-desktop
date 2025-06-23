import React from "react";
import { AbstractCity, Graphsheet, RevealTextLine, Icons } from "../ui";
import { InView } from "react-intersection-observer";
import Link from "next/link";
import AnimatedRings from "./animated-rings";
import { ProgressBar } from "../progress-bar";
import { PROGRESS_CONTENT } from "./splash-content";

const splashScreen = ({ step }: { step: number }) => {
  const showProgress = step >= 0 && step < PROGRESS_CONTENT.length;
  const progressData = PROGRESS_CONTENT[step];
  return (
    <div
      className="flex grow flex-col items-center w-full h-full justify-center
     bg-primary-10 relative overflow-hidden"
    >
      <div className="absolute block w-full top-0 h-full">
        <AbstractCity animate />
        <div
          className="absolute top-0 w-full h-full"
          style={{
            background:
              "radial-gradient(57.78% 57.78% at 50% 90%, rgba(3, 7, 18, 0) 0%, rgba(5, 12, 32, 0.839) 71.2%, #071336 100%)",
          }}
        />
      </div>
      <div className="absolute w-full top-0 h-[100%] opacity-5">
        <Graphsheet
          majorCell={{
            lineColor: [255, 255, 255, 0.1],
            lineWidth: 2,
            cellDim: 200,
          }}
          minorCell={{
            lineColor: [255, 255, 255, 1.0],
            lineWidth: 1,
            cellDim: 20,
          }}
        />
      </div>
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div ref={ref}>{inView && <AnimatedRings />}</div>
        )}
      </InView>
      {!showProgress && (
        <InView triggerOnce>
          {({ inView, ref }) => (
            <Link
              ref={ref}
              className="flex flex-col text-lg items-center absolute z-20
            justify-center gap-y-6 hover:opacity-70 duration-300 text-white"
              href="/"
            >
              <RevealTextLine rotate reveal={inView}>
                <Icons.HippiusLogo className="size-14" />
              </RevealTextLine>
              <RevealTextLine reveal={inView} className="delay-300">
                <span className="text-[32px] font-medium">Hippius</span>
              </RevealTextLine>
            </Link>
          )}
        </InView>
      )}
      {showProgress && (
        <InView triggerOnce>
          {({ inView, ref }) => (
            <div
              ref={ref}
              className="flex flex-col text-lg items-center absolute z-20
            justify-center duration-300"
            >
              <RevealTextLine rotate reveal={inView}>
                {progressData.icon}
              </RevealTextLine>
            </div>
          )}
        </InView>
      )}

      {showProgress && (
        <InView triggerOnce>
          {({ inView, ref }) => (
            <div
              ref={ref}
              className="flex flex-col text-lg items-center absolute z-20
            justify-center gap-y-2 duration-300"
              style={{ top: "72%" }}
            >
              <RevealTextLine rotate reveal={inView}>
                <span className="font-digital font-normal text-[#3167DD] text-[34px] leading-[34px]">
                  {progressData?.progress}%
                </span>
              </RevealTextLine>
              <RevealTextLine reveal={inView} className="delay-300">
                <span className="text-white text-[22px] font-medium">
                  {progressData?.status}
                </span>
              </RevealTextLine>
              <RevealTextLine reveal={inView} className="delay-400 mb-20">
                <span className="text-sm font-medium text-white">
                  {progressData?.subStatus}
                </span>
              </RevealTextLine>
              <RevealTextLine reveal={inView} className="delay-500">
                <ProgressBar value={progressData.progress} />
              </RevealTextLine>
            </div>
          )}
        </InView>
      )}
    </div>
  );
};

export default splashScreen;
