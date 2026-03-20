import React from "react";
import { cn } from "@/app/lib/utils";
import { RevealTextLine, Skeleton } from "@/components/ui";
import { InView } from "react-intersection-observer";

export interface StatItem {
  value: React.ReactNode;
  label: string;
  className?: string;
}

interface StatsBoxProps {
  items: StatItem[];
  loading?: boolean;
}

const StatsBox: React.FC<StatsBoxProps> = ({ items, loading = false }) => {
  return (
    <InView triggerOnce threshold={0.2}>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="inline-flex items-center bg-white border-2 border-gray-200 rounded-md px-2 sm:px-4 sm:py-3 py-2 gap-2
     shadow-tooltip"
        >
          {loading
            ? Array(items.length || 3)
                .fill(0)
                .map((_, idx) => (
                  <div
                    className={cn(
                      "flex items-baseline gap-2",
                      idx !== (items?.length || 3) - 1 &&
                        "border-r-[1.4px] border-grey pr-2"
                    )}
                    key={idx}
                  >
                    <Skeleton
                      variant="text"
                      width="4rem"
                      height="2.5rem"
                      animated
                      className="my-1"
                    />
                  </div>
                ))
            : items.map((item, idx) => (
                <div
                  className={cn(
                    "flex items-baseline gap-2 font-medium text-xs sm:text-sm lg:text-base",
                    item.className || "text-gray-900",
                    idx !== items?.length - 1 &&
                      "border-r-[1.4px] border-grey pr-2"
                  )}
                  key={idx}
                >
                  <RevealTextLine reveal={inView}>
                    {item.value} {item.label}
                  </RevealTextLine>
                </div>
              ))}
        </div>
      )}
    </InView>
  );
};

export default StatsBox;
