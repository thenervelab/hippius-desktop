import React from "react";
import { Graphsheet } from "@/components/ui";

interface DialogIconHeaderProps {
  icon: React.ReactNode;
  bgColor: string;
}

/**
 * Shared icon header used across sync manager dialogs.
 * Renders the graphsheet background with a centered icon badge.
 */
export function DialogIconHeader({ icon, bgColor }: DialogIconHeaderProps) {
  return (
    <div className="size-14 flex justify-center items-center relative">
      <Graphsheet
        majorCell={{
          lineColor: [31, 80, 189, 1.0],
          lineWidth: 2,
          cellDim: 200,
        }}
        minorCell={{
          lineColor: [49, 103, 211, 1.0],
          lineWidth: 1,
          cellDim: 20,
        }}
        className="absolute w-full h-full duration-500 opacity-30 z-0"
      />
      <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
      <div
        className={`h-8 w-8 ${bgColor} rounded-lg flex items-center justify-center z-20`}
      >
        {icon}
      </div>
    </div>
  );
}
