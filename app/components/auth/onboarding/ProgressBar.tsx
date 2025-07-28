// components/ProgressBar.tsx
import React from "react";
import { cn } from "@/app/lib/utils";

interface ProgressBarProps {
  totalSteps: number;
  currentStep: number; // 1‑based
}

const ProgressBar: React.FC<ProgressBarProps> = ({
  totalSteps,
  currentStep
}) => {
  return (
    <div className="flex gap-2">
      {Array.from({ length: totalSteps }).map((_, idx) => {
        const filled = idx < currentStep;
        return (
          <div
            key={idx}
            className="flex-1 h-1 bg-grey-80 rounded overflow-hidden"
          >
            <div
              className={cn(
                "h-1 bg-primary-50 transition-all duration-500",
                filled ? "w-full" : "w-0"
              )}
            />
          </div>
        );
      })}
    </div>
  );
};

export default ProgressBar;
