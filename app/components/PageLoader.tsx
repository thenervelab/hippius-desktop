"use client";
import React from "react";
import DecryptingAnimation from "@/app/components/DecryptingAnimation";

export default function PageLoader({
  ringFill = "loop",
}: {
  // `"once"` makes the progress ring fill a single quick revolution and hold
  // full — used by the splash outro so it reads as "complete" instead of
  // looping. Defaults to the continuous loop used for ordinary page loads.
  ringFill?: "loop" | "once";
} = {}) {
  return (
    <div className="flex items-center justify-center min-h-screen h-screen w-screen bg-grey-100 dark:bg-black-primary-bg">
      <div role="status" aria-live="polite" className="flex flex-col items-center">
        <DecryptingAnimation ringFill={ringFill} />
      </div>
    </div>
  );
}
