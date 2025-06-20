"use client";

import { cn } from "@/app/lib/utils";
import { useAbstractCity } from "@/app/lib/hooks";

const AbstractCity: React.FC<
  ReturnType<typeof useAbstractCity> & { animate: boolean }
> = ({ canvasRef, loaded, animate, performanceState }) => {
  return (
    <div className="w-full h-full">
      <canvas
        ref={canvasRef}
        className={cn(
          "w-full h-full opacity-0 duration-1000",
          loaded &&
            cn(
              "opacity-100",
              (!animate || (animate && performanceState === "unperformant")) &&
                "canvas-scaleIn"
            )
        )}
      ></canvas>
    </div>
  );
};

export default AbstractCity;
