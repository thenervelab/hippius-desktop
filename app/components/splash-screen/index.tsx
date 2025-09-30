"use client";
import { useEffect, useState } from "react";
import SplashScreen from "./SplashScreen";
import { AppSetupPhases } from "@/app/lib/types";
import { listen } from "@tauri-apps/api/event";
import { APP_SETUP_EVENT } from "@/app/lib/constants";
import { invoke } from "@tauri-apps/api/core";
import { useAtom, useSetAtom, useAtomValue } from "jotai";
import { phaseAtom, phaseProgressionClockAtom } from "./atoms";
import { updateCheckCompleteAtom, updateDialogOpenAtom, updateStore } from "@/app/components/updater/updateStore";
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

  // Track update status
  const updateCheckComplete = useAtomValue(updateCheckCompleteAtom);
  const updateDialogOpen = useAtomValue(updateDialogOpenAtom, { store: updateStore });
  const canProceedWithSplash = updateCheckComplete && !updateDialogOpen;

  // Reset phase progression clock and phase when update check is not complete or dialog is open
  useEffect(() => {
    if (!updateCheckComplete || updateDialogOpen) {
      setPhaseProgressionClock(0);
      // Reset phase to prevent any content changes
      if (updateDialogOpen && phase) {
        setPhase(null);
      }
    }
  }, [updateCheckComplete, updateDialogOpen, setPhaseProgressionClock, phase, setPhase]);

  // Start IPFS daemon setup only after update check is complete and dialog is closed
  useEffect(() => {
    if (!updateCheckComplete || updateDialogOpen) return;

    // Start IPFS setup when update check is done and dialog is closed
    invoke("start_ipfs_setup_when_ready").catch(console.error);
  }, [updateCheckComplete, updateDialogOpen]);

  useEffect(() => {
    if (!canProceedWithSplash) return;

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
  }, [phase, setPhase, canProceedWithSplash]);

  useEffect(() => {
    if (!canProceedWithSplash) return;

    if (phase !== "ready") {
      const unlisten = listen(APP_SETUP_EVENT, (event) => {
        setPhase(event.payload as AppSetupPhases);
      });

      return () => {
        unlisten.then((fn) => fn());
      };
    }
  }, [phase, setPhase, canProceedWithSplash]);

  useEffect(() => {
    if (!canProceedWithSplash) return;
    if (!phase || phase === "ready") return;

    const duration = 4000;
    const start = performance.now();

    const update = () => {
      const now = performance.now();
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      setPhaseProgressionClock(progress);
    };

    setPhaseProgressionClock(0);

    const interval = setInterval(update, 16);

    return () => {
      clearInterval(interval);
      setPhaseProgressionClock(0);
    };
  }, [phase, setPhaseProgressionClock, canProceedWithSplash]);

  useEffect(() => {
    if (!canProceedWithSplash) return;

    if (phase === "ready") {
      const timeout = setTimeout(() => {
        setKeepSplacescreenInDom(false);
      }, 1000);

      return () => {
        clearTimeout(timeout);
      };
    }
  }, [phase, canProceedWithSplash]);

  const isReady = phase === "ready";

  return (
    <>
      {keepSplashscreenInDom && (
        <div
          className={cn(
            "fixed inset-0 z-40 flex flex-col items-center justify-center w-full h-full duration-300",
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
