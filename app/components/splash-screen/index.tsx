"use client";

import { useState, useEffect } from "react";
import SplashScreen from "./splash-screen";
import { PROGRESS_CONTENT } from "./splash-content";

export default function SplashWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
   const [step, setStep] = useState(-1); 
  const totalSteps = PROGRESS_CONTENT.length;
  const splashDuration = 3000; 

  useEffect(() => {
    if (step < totalSteps) {
      const timer = setTimeout(() => setStep(step + 1), splashDuration);
      return () => clearTimeout(timer);
    }
  }, [step, totalSteps]);

  if (step < totalSteps) {
    return (
      <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center w-full h-full">
        <SplashScreen step={step} />
      </div>
    );
  }

  return <>{children}</>;
}
