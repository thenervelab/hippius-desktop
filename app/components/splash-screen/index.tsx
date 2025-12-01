"use client";
import { useEffect, useState, useRef } from "react";
import SplashScreen from "./SplashScreen";
import { useAtom, useAtomValue } from "jotai";
import { phaseAtom } from "./atoms";
import {
  updateCheckCompleteAtom,
  updateDialogOpenAtom,
  updateStore,
} from "@/app/components/updater/updateStore";
import { cn } from "@/app/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { PHASE_CONTENT, AppSetupPhaseContent } from "./SplashContent";

export default function SplashWrapper({
  children,
  preventClose = false,
}: {
  children: React.ReactNode;
  preventClose?: boolean;
}) {
  const [phase, setPhase] = useAtom(phaseAtom);
  const [keepSplashscreenInDom, setKeepSplacescreenInDom] = useState(true);
  const setupStartedRef = useRef(false);

  // Track update status
  const updateCheckComplete = useAtomValue(updateCheckCompleteAtom);
  const updateDialogOpen = useAtomValue(updateDialogOpenAtom, {
    store: updateStore,
  });
  const canProceedWithSplash = updateCheckComplete && !updateDialogOpen;

  // Reset phase when update dialog is open
  useEffect(() => {
    if (updateDialogOpen && phase) {
      setPhase(null);
    }
  }, [updateDialogOpen, phase, setPhase]);

  // Execute setup phases sequentially
  useEffect(() => {
    if (!canProceedWithSplash) return;
    if (setupStartedRef.current) return;

    setupStartedRef.current = true;

    const runSetupPhases = async () => {
      for (const phaseName of Object.keys(PHASE_CONTENT)) {
        setPhase(phaseName);
        const phaseContent: AppSetupPhaseContent | undefined =
          PHASE_CONTENT[phaseName];

        if (!phaseContent) {
          console.warn(`Unknown phase: ${phaseName}`);
          continue;
        }

        try {
          // Execute the Tauri command for this phase
          await invoke(phaseContent.command);
        } catch (error) {
          console.error(`Error during phase ${phaseName}:`, error);
          // Continue to next phase even on error
        }
      }
    };

    runSetupPhases();
  }, [canProceedWithSplash, setPhase]);

  useEffect(() => {
    if (!canProceedWithSplash) return;
    if (preventClose) return; // Don't close splash screen if preventClose is true

    // Check if we're on the last phase
    const phases = Object.keys(PHASE_CONTENT);
    const lastPhase = phases[phases.length - 1];

    if (phase === lastPhase) {
      const timeout = setTimeout(() => {
        setKeepSplacescreenInDom(false);
      }, 1000);

      return () => {
        clearTimeout(timeout);
      };
    }
  }, [phase, canProceedWithSplash, preventClose]);

  // Only consider ready for fade-out if not preventing close and we're on the last phase
  const phases = Object.keys(PHASE_CONTENT);
  const lastPhase = phases[phases.length - 1];
  const isReady = phase === lastPhase && !preventClose;

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
