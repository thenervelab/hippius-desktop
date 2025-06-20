"use client";

import * as React from "react";
import * as Progress from "@radix-ui/react-progress";
import { cn } from "@/lib/utils";

const ProgressBar = React.forwardRef<
  React.ElementRef<typeof Progress.Root>,
  React.ComponentPropsWithoutRef<typeof Progress.Root>
>(({ className, value, ...props }, ref) => (
  <Progress.Root
    ref={ref}
    className={cn(
      "relative h-2 w-full overflow-hidden rounded-full bg-blue-500/10",
      className
    )}
    {...props}
  >
    <Progress.Indicator
      className="h-full w-full flex-1 bg-gradient-to-r from-blue-500 to-blue-600 transition-all"
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    />
  </Progress.Root>
));

ProgressBar.displayName = "ProgressBar";

export default ProgressBar;
