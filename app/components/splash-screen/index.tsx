"use client";
import { useState, useEffect, useRef } from "react";
import SplashScreen from "./splash-screen";
import { PROGRESS_CONTENT } from "./splash-content";

export default function SplashWrapper({
  children,
  skipSplash = false,
}: {
  children: React.ReactNode;
  skipSplash?: boolean;
}) {
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState(-1);
  const [phase, setPhase] = useState<"logo" | "idle" | "animating" | "done">(
    skipSplash ? "done" : "logo"
  );
  const [isLoading, setIsLoading] = useState(true);

  // TEST: set loading false after 25s
  useEffect(() => {
    const timer = setTimeout(() => setIsLoading(false), 25000);
    return () => clearTimeout(timer);
  }, []);

  const duration = 15000;
  const totalSteps = PROGRESS_CONTENT.length;
  const progressRef = useRef(0);

  useEffect(() => {
    if (phase !== "logo" || skipSplash) return;
    const timer = setTimeout(() => {
      setStep(0);
      setProgress(0);
      setPhase("idle");
    }, 3000);
    return () => clearTimeout(timer);
  }, [phase, skipSplash]);

  useEffect(() => {
    if (phase !== "idle") return;
    const delay = 1500;
    const timer = setTimeout(() => {
      setPhase("animating");
    }, delay);
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "animating") return;
    setProgress(0);
    progressRef.current = 0;
    let current = 0;
    const intervalMs = duration / 100;
    const interval = setInterval(() => {
      if (current < 99) {
        current += 1;
        progressRef.current = current;
        setProgress(current);
      } else {
        clearInterval(interval);
      }
    }, intervalMs);
    return () => clearInterval(interval);
  }, [phase, duration]);

  useEffect(() => {
    if (phase === "animating" && progress >= 99 && !isLoading) {
      setProgress(100);
      setTimeout(() => setPhase("done"), 300);
    }
  }, [isLoading, phase, progress]);

  useEffect(() => {
    if (phase !== "animating") return;
    const currentStep = Math.min(
      Math.floor((progress / 100) * totalSteps),
      totalSteps - 1
    );
    if (currentStep !== step) setStep(currentStep);
  }, [progress, totalSteps, step, phase]);

  if (phase !== "done") {
    return (
      <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center w-full h-full">
        <SplashScreen step={step} progress={progress} />
      </div>
    );
  }

  return <>{children}</>;
}
