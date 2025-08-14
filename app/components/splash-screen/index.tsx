"use client";
import { useEffect, useState } from "react";
import SplashScreen from "./SplashScreen";
import { AppSetupPhases } from "@/app/lib/types";
import { listen } from "@tauri-apps/api/event";
import { APP_SETUP_EVENT } from "@/app/lib/constants";
import { invoke } from "@tauri-apps/api/core";
import { useAtom, useSetAtom } from "jotai";
import { phaseAtom, phaseProgressionClockAtom } from "./atoms";
import { cn } from "@/app/lib/utils";

export default function SplashWrapper({
  children,
}: {
  children: React.ReactNode;
  skipSplash?: boolean;
}) {
  const [phase, setPhase] = useAtom(phaseAtom);
  const setPhaseProgressionClock = useSetAtom(phaseProgressionClockAtom);
  const [keepSplashscreenInDom, setKeepSplacescreenInDom] = useState(true);

  useEffect(() => {
    if (!phase) {
      invoke("get_current_setup_phase").then((p) => {
        try {
          const parsedPhase = JSON.parse(p as string);
          if (parsedPhase) {
            setPhase(parsedPhase as AppSetupPhases);
          }
        } catch { }
      });
    }
  }, [phase, setPhase]);

  useEffect(() => {
    if (phase !== "ready") {
      const unlisten = listen(APP_SETUP_EVENT, (event) => {
        setPhase(event.payload as AppSetupPhases);
      });

      return () => {
        unlisten.then((fn) => fn());
      };
    }
  }, [phase, setPhase]);

  useEffect(() => {
    if (!phase || phase === "ready") return;

    const duration = 4000;
    const start = performance.now();

    const update = () => {
      const now = performance.now();
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      setPhaseProgressionClock(progress);
    };

    // Immediately reset progress
    setPhaseProgressionClock(0);

    const interval = setInterval(update, 16);

    return () => {
      clearInterval(interval);
      setPhaseProgressionClock(0); // Reset again on cleanup
    };
  }, [phase, setPhaseProgressionClock]);

  useEffect(() => {
    if (phase === "ready") {
      const timeout = setTimeout(() => {
        setKeepSplacescreenInDom(false);
      }, 1000);

      return () => {
        clearTimeout(timeout);
      };
    }
  }, [phase]);

  const isReady = phase === "ready";

  return (
    <>
      {keepSplashscreenInDom && (
        <div
          className={cn(
            "fixed inset-0 z-[9999] flex flex-col items-center justify-center w-full h-full duration-300",
            isReady && "pointer-events-none opacity-0 scale-90"
          )}
        >
          <SplashScreen />
        </div>
      )}
      {isReady && children}
    </>
  );
}
