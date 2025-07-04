"use client";

import React, { ReactNode, Suspense } from "react";
import { InView } from "react-intersection-observer";
import { cn } from "@/app/lib/utils";
import { RevealTextLine } from "../ui";
import LeftCarouselPanel from "./LeftCarouselPanel";
import { HippiusLogo } from "../ui/icons";
import { LucideLoader2 } from "lucide-react";

interface AuthLayoutProps {
  children: ReactNode;
}

const AuthLayout = ({ children }: AuthLayoutProps) => {
  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="w-full h-full flex flex-col items-center justify-center"
        >
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
            <RevealTextLine
              rotate
              reveal={true}
              parentClassName="w-full h-full min-h-full max-h-full"
              className="w-full h-full min-h-full max-h-full"
            >
              <LeftCarouselPanel />
            </RevealTextLine>
            <div className="flex flex-col items-start justify-center h-full ">
              <div
                className={cn(
                  "text-xl  font-medium text-grey-10  mb-[38px] flex gap-2 items-center",
                  inView
                    ? "opacity-100 translate-y-0"
                    : "opacity-0 translate-y-8"
                )}
              >
                <HippiusLogo className="size-9 bg-primary-50 rounded text-white" />
                Hippius
              </div>
              <Suspense
                fallback={
                  <div className="flex h-full w-full items-center justify-center opacity-0 grow animate-fade-in-0.5">
                    <LucideLoader2 className="animate-spin text-primary-50" />
                  </div>
                }
              >
                {children}
              </Suspense>
            </div>
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
      )}
    </InView>
  );
};

export default AuthLayout;
