"use client";

import { cn } from "@/app/lib/utils";
import { useGraphSheet } from "@/app/lib/hooks";
import { GraphsheetSharedProps } from "./types";

const Graph: React.FC<
  ReturnType<typeof useGraphSheet> & GraphsheetSharedProps
> = ({ canvasRef, loaded, className }) => {
  return (
    <div className={cn("w-full h-full", className)}>
      <canvas
        ref={canvasRef}
        className={cn(
          "w-full h-full opacity-0 duration-1000",
          loaded && "opacity-1"
        )}
      ></canvas>
    </div>
  );
};

export default Graph;
