import React from "react";

interface ProgressBarProps {
  totalSteps: number;
  currentStep: number; // 1-based
}

const ProgressBar: React.FC<ProgressBarProps> = ({ totalSteps, currentStep }) => {
  return (
    <div className="flex gap-3">
      {Array.from({ length: totalSteps }).map((_, idx) => {
        const filled = idx < currentStep;
        return (
          <div
            key={idx}
            className="h-[4px] flex-1 rounded-[23px] transition-opacity duration-500 bg-grey-10 dark:bg-[#EBEBEB]"
            style={{ opacity: filled ? 1 : 0.1 }}
          />
        );
      })}
    </div>
  );
};

export default ProgressBar;
