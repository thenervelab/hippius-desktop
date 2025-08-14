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
            "text-xl  font-medium text-grey-10   flex gap-2 items-center",
            inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8",
            {
              "mb-[26px]": isVerify,
              "mb-[38px]": !isVerify,
              "mb-0": isOnboarding
            }
          )}
        >
          <HippiusLogo className="size-9 bg-primary-50 rounded text-white" />
          Hippius
        </div>
      )}
    </InView>
  );
};

export default HippiusHeader;
