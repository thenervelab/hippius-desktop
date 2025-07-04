"use client";

import Link from "next/link";
import { InView } from "react-intersection-observer";
import { Icons, Graphsheet, P, H4, RevealTextLine } from "@/components/ui";
import { useBreakpoint } from "@/app/lib/hooks";
import { cn } from "./lib/utils";
import { Suspense } from "react";

const NotFoundContent = () => {
  const { isTablet, isLaptop, isDesktop, isLargeDesktop } = useBreakpoint();

  return (
    <InView triggerOnce threshold={0.4}>
      {({ ref, inView }) => (
        <div ref={ref} className="relative bg-grey-100 px-4">
          {/* subtle grid background */}

          <div className="flex flex-col items-center justify-center">
            <Graphsheet
              majorCell={{
                lineColor: [152, 174, 225, 1],
                lineWidth: 2,
                cellDim: 178,
              }}
              minorCell={{
                lineColor: [49, 103, 211, 0.05],
                lineWidth: 0,
                cellDim: 0,
              }}
              className="hidden sm:block absolute w-full h-full"
            />
            <Graphsheet
              majorCell={{
                lineColor: [152, 174, 225, 1],
                lineWidth: 2,
                cellDim: 80,
              }}
              minorCell={{
                lineColor: [49, 103, 211, 0.05],
                lineWidth: 0,
                cellDim: 0,
              }}
              className="sm:hidden absolute w-full h-full"
            />
            <div className="bg-white-cloud-gradient absolute w-full h-full" />

            <div className="flex flex-col items-center justify-center relative">
              {/* 404 with outlined stroke */}
              <RevealTextLine rotate reveal={inView}>
                <h1
                  className="text-[8rem] lg:text-[12rem] leading-none font-extrabold text-primary-90 overflow-hidden"
                  style={{
                    WebkitTextStrokeWidth:
                      isTablet || isLaptop || isDesktop || isLargeDesktop
                        ? "6px"
                        : "3px",
                    WebkitTextStrokeColor: "#1F51BE",
                  }}
                >
                  404
                </h1>
              </RevealTextLine>

              {/* main title */}
              <RevealTextLine rotate reveal={inView}>
                <H4 size="sm" className="mt-4 text-grey-10">
                  Oh Snap! This Page Does Not Exist
                </H4>
              </RevealTextLine>

              <div className="w-full flex flex-col items-center">
                <div className="max-w-md">
                  {/* little description */}
                  <RevealTextLine rotate reveal={inView}>
                    <P className="mt-2 text-grey-60 text-center">
                      Hm, that URL doesn’t seem to exist. Try going back home or
                      using the nav to find what you need.
                    </P>
                  </RevealTextLine>

                  <div className="mt-6 flex items-center justify-center ">
                    {/* back home button */}
                    <div
                      className={cn(
                        "bg-primary-50 p-1 border border-primary-40 rounded max-w-[166px] hover:bg-primary-40 opacity-0 translate-y-7 duration-300 delay-300",
                        inView && "opacity-100 translate-y-0"
                      )}
                    >
                      <Link
                        href="/"
                        passHref
                        className="flex justify-center items-center w-full px-4 py-2 bg-primary-50 gap-2 border border-primary-40 text-sm font-medium rounded text-white hover:bg-primary-40"
                      >
                        Go Back Home
                        <Icons.ArrowRight className="size-4" />
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </InView>
  );
};

export default function NotFound() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <NotFoundContent />
    </Suspense>
  );
}
