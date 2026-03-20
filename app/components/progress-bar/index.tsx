import { cn } from "@/app/lib/utils";
import React, { useEffect, useRef, useState } from "react";

export const ProgressBar = ({
  value = 0,
  segments = 5,
  stuckTimeout = 1000,
  fillClass = "bg-primary-50",
  pulseClass = "pulse-blue",
}: {
  value?: number;
  segments?: number;
  stuckTimeout?: number;
  fillClass?: string;
  pulseClass?: string;
}) => {
  const segPercent = 100 / segments;
  const [isStuck, setIsStuck] = useState(false);
  const lastValueRef = useRef(value);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (value !== lastValueRef.current) {
      setIsStuck(false);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setIsStuck(true), stuckTimeout);
      lastValueRef.current = value;
    }
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [value, stuckTimeout]);

  return (
    <div className="relative flex gap-[2px] w-[580px] h-3 bg-transparent overflow-hidden">
      {Array.from({ length: segments }).map((_, idx) => {
        const start = idx * segPercent;
        const end = (idx + 1) * segPercent;
        let fill = 0;
        if (value >= end) {
          fill = 1;
        } else if (value > start) {
          fill = (value - start) / segPercent;
        }
        return (
          <div
            key={idx}
            className="flex-1 border border-grey-80 bg-grey-90 h-full relative overflow-hidden"
          >
            <div
              className={cn(
                "absolute left-0 top-0 h-full w-full origin-right transition-transform duration-300 ease-out",
                fillClass,
                isStuck && pulseClass
              )}
              style={{
                transform: `translateX(${fill * 100 - 100}%)`,
              }}
            />
          </div>
        );
      })}
    </div>
  );
};
