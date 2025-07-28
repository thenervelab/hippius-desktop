"use client";

import React, { ReactNode } from "react";
import { InView } from "react-intersection-observer";
import { cn } from "@/app/lib/utils";
import { Graphsheet } from "../ui";

interface BaseAuthLayoutProps {
  children: ReactNode;
  onboardingCompleted?: boolean | null;
}

const BaseAuthLayout = ({
  children,
  onboardingCompleted
}: BaseAuthLayoutProps) => {
  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="flex grow flex-col items-center w-full justify-center relative overflow-hidden h-full"
        >
          <div
            className={cn(
              "absolute w-full top-0 h-full opacity-5 ",
              !onboardingCompleted && "z-1"
            )}
          >
            <Graphsheet
              majorCell={{
                lineColor: [31, 80, 189, 1.0],
                lineWidth: 2,
                cellDim: 150
              }}
              minorCell={{
                lineColor: [49, 103, 211, 1.0],
                lineWidth: 1,
                cellDim: 15
              }}
              className="absolute w-full left-0 h-full duration-500"
            />
          </div>

          <div className="w-full h-full flex flex-col items-center justify-center">
            <div
              className={cn(
                "absolute top-5 lg:top-8 right-5 lg:right-8 border-r border-t border-primary-40  w-[23px] h-[23px]",
                inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
              )}
            ></div>

            <div
              className={cn(
                "absolute top-5 lg:top-8 left-5 lg:left-8 border-l border-t border-primary-40 w-[23px] h-[23px]",
                inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
              )}
            ></div>

            <main
              className="p-[72px] lg:p-[88px] items-center justify-between 
            relative h-full w-full grid grid-cols-2 gap-12 2xl:gap-[120px]"
            >
              {children}
            </main>

            <div
              className={cn(
                "absolute bottom-5 lg:bottom-8 left-5 lg:left-8 border-l border-b border-primary-40 w-[23px] h-[23px]",
                inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
              )}
            ></div>
            <div
              className={cn(
                "absolute bottom-5 lg:bottom-8 right-6 lg:right-8 border-r border-b border-primary-40 w-[23px] h-[23px]",
                inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
              )}
            ></div>
          </div>
        </div>
      )}
    </InView>
  );
};

export default BaseAuthLayout;
