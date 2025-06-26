"use client";
import { useState, useEffect, useMemo } from "react";
import SplashScreen from "./splash-screen";
import { AppSetupPhases } from "@/app/lib/types";
import { listen } from "@tauri-apps/api/event";
import { APP_SETUP_EVENT, APP_SETUP_PHASES } from "@/app/lib/constants";
import { remap } from "@/app/lib/utils";
import { invoke } from "@tauri-apps/api/core";

export default function SplashWrapper({
  children,
}: {
  children: React.ReactNode;
  skipSplash?: boolean;
}) {
  const [phaseProgressionClock, setPhaseProgressionClock] = useState(0);

  const [phase, setPhase] = useState<AppSetupPhases | null>(null);

  const step = useMemo(() => {
    if (phase) {
      return APP_SETUP_PHASES.findIndex((v) => v === phase);
    }
    return 0;
  }, [phase]);

  const progress = useMemo(() => {
    const total = step + phaseProgressionClock;
    return remap(total, 0, APP_SETUP_PHASES.length, 0, 100);
  }, [phaseProgressionClock, step]);

  useEffect(() => {
    if (!phase) {
      invoke("get_current_setup_phase").then((p) => {
        if (p) {
          // console.log("INIT PHASE ", p);
          const parsedPhase = JSON.parse(p as string);
          setPhase(parsedPhase as AppSetupPhases);
        }
      });
    }
  }, [phase]);

  useEffect(() => {
    if (phase && phase !== "ready") {
      const unlisten = listen(APP_SETUP_EVENT, (event) => {
        console.log("Received IPFS progress:", event.payload);
        setPhase(event.payload as AppSetupPhases);
      });

      return () => {
        unlisten.then((fn) => fn());
      };
    }
  }, [phase]);

  useEffect(() => {
    if (phase && phase !== "ready") {
      const interval = setInterval(() => {
        setPhaseProgressionClock((v) => Math.min(v + 0.2, 1));
      }, 300);

      return () => {
        clearInterval(interval);
        setPhaseProgressionClock(0);
      };
    }
  }, [phase]);

  if (phase !== "ready") {
    return (
      <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center w-full h-full">
        <SplashScreen step={step} progress={progress} />
      </div>
    );
  }

  return <>{children}</>;
}
