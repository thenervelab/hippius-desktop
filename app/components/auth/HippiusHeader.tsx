"use client";

import React from "react";
import { InView } from "react-intersection-observer";
import { cn } from "@/app/lib/utils";
import { HippiusLogo } from "@/components/ui/icons";

interface HippiusHeaderProps {
  isVerify?: boolean;
  isOnboarding?: boolean;
}

const HippiusHeader = ({
  isVerify = false,
  isOnboarding = false
}: HippiusHeaderProps) => {
  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className={cn(
            "text-[min(1.25rem,20px)] font-medium text-grey-10 flex gap-[min(0.5rem,8px)] items-center",
            inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8",
            {
              "mb-[min(1.625rem,26px)]": isVerify,
              "mb-[min(1.5rem,24px)]": !isVerify,
              "mb-0": isOnboarding
            }
          )}
        >
          <HippiusLogo className="size-[min(2.25rem,36px)] bg-primary-50 rounded text-white" />
          Hippius
        </div>
      )}
    </InView>
  );
};

export default HippiusHeader;
