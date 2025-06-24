import { cn } from "@/app/lib/utils";
import React, { useEffect, useState } from "react";

type AnimatedProgressIconProps = {
  icon: React.ReactNode;
  status: string;
  step: number;
};

export default function AnimatedProgressIcon({
  icon,
  status,
  step,
}: AnimatedProgressIconProps) {
  const [spinning, setSpinning] = useState(false);

  useEffect(() => {
    setSpinning(false);
    const timeout = setTimeout(() => setSpinning(true), 1000);
    return () => clearTimeout(timeout);
  }, [status, icon]);

  const shouldSpin = spinning && (step === 1);

  return (
    <div className="flex items-center justify-center absolute z-20 overflow-hidden">
      <div
        className={cn(
          "h-[250px] w-[250px] flex items-center justify-center overflow-hidden",
          shouldSpin && "animate-spin-slow"
        )}
      >
        <div
          key={status}
          className="h-full w-full flex items-center justify-center animate-fadePop"
        >
          {icon}
        </div>
      </div>
    </div>
  );
}
