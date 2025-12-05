"use client";
import { useEffect, useState, useRef } from "react";
import SplashScreen from "./SplashScreen";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  phaseAtom,
  completedPhasesAtom,
  nebulaInstalledAtom,
  currentPhaseIndexAtom,
  phaseCommandRunningAtom,
  isUpdateCheckPhaseAtom,
} from "./atoms";
import {
  updateCheckCompleteAtom,
  updateDialogOpenAtom,
  updateStore,
} from "@/app/components/updater/updateStore";
import { cn } from "@/app/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import {
  PHASE_CONTENT,
  AppSetupPhaseContent,
  MIN_PHASE_DURATION,
} from "./SplashContent";

export default function SplashWrapper({
  children,
  preventClose = false,
}: {
  children: React.ReactNode;
  preventClose?: boolean;
}) {
  const [phase, setPhase] = useAtom(phaseAtom);
  const setCompletedPhases = useSetAtom(completedPhasesAtom);
  const setNebulaInstalled = useSetAtom(nebulaInstalledAtom);
  const setCurrentPhaseIndex = useSetAtom(currentPhaseIndexAtom);
  const setPhaseCommandRunning = useSetAtom(phaseCommandRunningAtom);
  const setIsUpdateCheckPhase = useSetAtom(isUpdateCheckPhaseAtom);
  const [keepSplashscreenInDom, setKeepSplacescreenInDom] = useState(true);
  const [isFullyComplete, setIsFullyComplete] = useState(false);
  const setupStartedRef = useRef(false);

  // Track update status
  const updateCheckComplete = useAtomValue(updateCheckCompleteAtom);
  const updateDialogOpen = useAtomValue(updateDialogOpenAtom, {
    store: updateStore,
  });

  // Refs to track latest values for async access
  const updateCheckCompleteRef = useRef(updateCheckComplete);
  const updateDialogOpenRef = useRef(updateDialogOpen);

  useEffect(() => {
    updateCheckCompleteRef.current = updateCheckComplete;
  }, [updateCheckComplete]);

  useEffect(() => {
    updateDialogOpenRef.current = updateDialogOpen;
  }, [updateDialogOpen]);

  // Reset phase and completed phases when update dialog is open
  useEffect(() => {
    if (updateDialogOpen && phase) {
      setPhase(null);
      setCompletedPhases(new Set());
      setNebulaInstalled(null);
      setCurrentPhaseIndex(0);
      setPhaseCommandRunning(false);
      setIsUpdateCheckPhase(true);
      setIsFullyComplete(false);
    }
  }, [
    updateDialogOpen,
    phase,
    setPhase,
    setCompletedPhases,
    setNebulaInstalled,
    setCurrentPhaseIndex,
    setPhaseCommandRunning,
    setIsUpdateCheckPhase,
  ]);

  // Helper function to ensure minimum phase duration
  const runWithMinDuration = async (
    promise: Promise<unknown>,
    minDuration: number = MIN_PHASE_DURATION
  ) => {
    const startTime = Date.now();
    const result = await promise;
    const elapsed = Date.now() - startTime;
    if (elapsed < minDuration) {
      await new Promise((resolve) =>
        setTimeout(resolve, minDuration - elapsed)
      );
    }
    return result;
  };

  // Helper to wait for a duration
  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // Execute setup phases sequentially
  useEffect(() => {
    if (setupStartedRef.current) return;

    setupStartedRef.current = true;

    const runSetupPhases = async () => {
      // First, check if nebula is already installed
      let isAlreadyInstalled = false;
      try {
        isAlreadyInstalled = await invoke<boolean>(
          "get_nebula_binary_installed_status"
        );
        setNebulaInstalled(isAlreadyInstalled);
      } catch (error) {
        console.error("Error checking nebula installation status:", error);
        setNebulaInstalled(false);
      }

      // ========== UPDATE CHECK PHASE (at 0% - before main phases) ==========
      // This runs separately and doesn't affect progress percentage
      setIsUpdateCheckPhase(true);
      setPhase("checking_updates");

      // Wait for update check to complete using polling with refs
      const updateCheckPromise = new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (updateCheckCompleteRef.current || updateDialogOpenRef.current) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 50);

        // Safety timeout after 10 seconds
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 10000);
      });

      // Only use minimum duration if not already installed
      if (isAlreadyInstalled) {
        await updateCheckPromise;
      } else {
        await runWithMinDuration(updateCheckPromise, MIN_PHASE_DURATION);
      }

      // If update dialog opened, stop the setup
      if (updateDialogOpenRef.current) {
        return;
      }

      // End update check phase
      setIsUpdateCheckPhase(false);

      // ========== MAIN PHASES (contribute to progress) ==========
      const phaseNames = Object.keys(PHASE_CONTENT);

      for (let i = 0; i < phaseNames.length; i++) {
        const phaseName = phaseNames[i];

        // Set the current phase index and mark command as running FIRST
        // This triggers the progress animation to start
        setCurrentPhaseIndex(i);
        setPhaseCommandRunning(true);

        // Set the current phase (this updates the UI to show current phase)
        setPhase(phaseName);

        if (!isAlreadyInstalled) {
          await wait(1000); // Give time for progress animation to start and be visible
        }

        const phaseContent: AppSetupPhaseContent | undefined =
          PHASE_CONTENT[phaseName];

        if (!phaseContent) {
          console.warn(`Unknown phase: ${phaseName}`);
          setPhaseCommandRunning(false);
          continue;
        }

        try {
          // Execute the Tauri command for this phase
          // Only use minimum duration if not already installed
          if (isAlreadyInstalled) {
            await invoke(phaseContent.command);
          } else {
            await runWithMinDuration(invoke(phaseContent.command));
          }

          // Command completed - mark as not running
          setPhaseCommandRunning(false);

          // Mark phase as completed after successful execution
          setCompletedPhases((prev: Set<string>) => {
            const newSet = new Set(prev);
            newSet.add(phaseName);
            return newSet;
          });

          // Wait for the progress animation to complete before moving to next phase
          // Only if not already installed (showing progress)
          if (!isAlreadyInstalled) {
            await wait(100);
          }
        } catch (error) {
          console.error(`Error during phase ${phaseName}:`, error);

          // Command completed (with error) - mark as not running
          setPhaseCommandRunning(false);

          setCompletedPhases((prev: Set<string>) => {
            const newSet = new Set(prev);
            newSet.add(phaseName);
            return newSet;
          });

          // Wait for animation even on error (only if showing progress)
          if (!isAlreadyInstalled) {
            await wait(300);
          }
        }
      }

      // Wait a bit for the final animation to complete before marking fully complete
      // Only if not already installed
      if (!isAlreadyInstalled) {
        await wait(800);
      }
      setIsFullyComplete(true);
    };

    runSetupPhases();
  }, [
    setPhase,
    setCompletedPhases,
    setNebulaInstalled,
    setCurrentPhaseIndex,
    setPhaseCommandRunning,
  ]);

  useEffect(() => {
    if (preventClose) return; // Don't close splash screen if preventClose is true
    if (!isFullyComplete) return; // Wait for full completion

    const timeout = setTimeout(() => {
      setKeepSplacescreenInDom(false);
    }, 500);

    return () => {
      clearTimeout(timeout);
    };
  }, [isFullyComplete, preventClose]);

  // Only consider ready for fade-out if fully complete and not preventing close
  const isReady = isFullyComplete && !preventClose;

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
