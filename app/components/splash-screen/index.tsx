"use client";
import { useEffect, useState, useRef } from "react";
import SplashScreen from "./SplashScreen";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  phaseAtom,
  completedPhasesAtom,
  currentPhaseIndexAtom,
  phaseCommandRunningAtom,
  isUpdateCheckPhaseAtom,
  phaseInternalProgressAtom,
  splashCompleteAtom,
} from "./atoms";
import {
  updateCheckCompleteAtom,
  updateDialogOpenAtom,
  updateStore,
} from "@/app/components/updater/updateStore";
import { cn } from "@/app/lib/utils";
import {
  PHASE_CONTENT,
  AppSetupPhaseContent,
  MIN_PHASE_DURATION,
  PHASE_PROGRESS_EVENT,
} from "./SplashContent";
import { listen } from "@tauri-apps/api/event";

export default function SplashWrapper({
  children,
  preventClose = false,
}: {
  children: React.ReactNode;
  preventClose?: boolean;
}) {
  const [phase, setPhase] = useAtom(phaseAtom);
  const setCompletedPhases = useSetAtom(completedPhasesAtom);
  const setCurrentPhaseIndex = useSetAtom(currentPhaseIndexAtom);
  const setPhaseCommandRunning = useSetAtom(phaseCommandRunningAtom);
  const setIsUpdateCheckPhase = useSetAtom(isUpdateCheckPhaseAtom);
  const setPhaseInternalProgress = useSetAtom(phaseInternalProgressAtom);
  const [keepSplashscreenInDom, setKeepSplacescreenInDom] = useState(true);
  const [isFullyComplete, setIsFullyComplete] = useState(false);
  const setSplashComplete = useSetAtom(splashCompleteAtom);
  const setupStartedRef = useRef(false);

  // Track update status
  const updateCheckComplete = useAtomValue(updateCheckCompleteAtom);
  const updateDialogOpen = useAtomValue(updateDialogOpenAtom, {
    store: updateStore,
  });

  // Refs to track latest values for async access
  const updateCheckCompleteRef = useRef(updateCheckComplete);
  const updateDialogOpenRef = useRef(updateDialogOpen);
  const currentPhaseRef = useRef<string | null>(null);

  useEffect(() => {
    updateCheckCompleteRef.current = updateCheckComplete;
  }, [updateCheckComplete]);

  useEffect(() => {
    updateDialogOpenRef.current = updateDialogOpen;
  }, [updateDialogOpen]);

  useEffect(() => {
    currentPhaseRef.current = phase;
  }, [phase]);

  // Listen for phase progress events from backend (download/install progress)
  useEffect(() => {
    let mounted = true;
    const setupListener = async () => {
      const unlisten = await listen<{ phase: string; progress: number }>(
        PHASE_PROGRESS_EVENT,
        (event) => {
          if (!mounted) return;

          const { phase: eventPhase, progress } = event.payload;
          console.log(`[Progress Event] Phase: ${eventPhase}, Progress: ${progress}%`);

          // Only update if this event is for the current phase
          if (currentPhaseRef.current === eventPhase) {
            const clampedProgress = Math.max(0, Math.min(100, progress));
            setPhaseInternalProgress(clampedProgress);
          } else {
            console.log(`[Progress Event] Ignoring - current phase is ${currentPhaseRef.current}`);
          }
        }
      );

      return unlisten;
    };

    const unlistenPromise = setupListener();

    return () => {
      mounted = false;
      unlistenPromise.then((fn) => fn());
    };
  }, [setPhaseInternalProgress]);

  // Reset phase and completed phases when update dialog is open
  useEffect(() => {
    if (updateDialogOpen && phase) {
      setPhase(null);
      setCompletedPhases(new Set());
      setCurrentPhaseIndex(0);
      setPhaseCommandRunning(false);
      setIsUpdateCheckPhase(true);
      setIsFullyComplete(false);
      setPhaseInternalProgress(0);
    }
  }, [
    updateDialogOpen,
    phase,
    setPhase,
    setCompletedPhases,
    setCurrentPhaseIndex,
    setPhaseCommandRunning,
    setIsUpdateCheckPhase,
    setPhaseInternalProgress,
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
      // ========== UPDATE CHECK PHASE (at 0% - before main phases) ==========
      setIsUpdateCheckPhase(true);
      setPhase("checking_updates");

      const updateCheckPromise = new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (updateCheckCompleteRef.current || updateDialogOpenRef.current) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 50);

        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 10000);
      });

      // Held to MIN_PHASE_DURATION so the splash never flickers off in <1.5s
      // when the updater resolves immediately (cached / offline).
      await runWithMinDuration(updateCheckPromise, MIN_PHASE_DURATION);

      if (updateDialogOpenRef.current) {
        return;
      }

      setIsUpdateCheckPhase(false);

      // ========== MAIN PHASES (quick animation, no blocking) ==========
      const phaseNames = Object.keys(PHASE_CONTENT);

      for (let i = 0; i < phaseNames.length; i++) {
        const phaseName = phaseNames[i];
        console.log(`[Setup] Starting phase ${i + 1}/${phaseNames.length}: ${phaseName}`);

        setPhase(phaseName);
        setCurrentPhaseIndex(i);
        setPhaseInternalProgress(0);
        setPhaseCommandRunning(true);

        const phaseContent: AppSetupPhaseContent | undefined =
          PHASE_CONTENT[phaseName];

        if (!phaseContent) {
          console.warn(`Unknown phase: ${phaseName}`);
          setPhaseCommandRunning(false);
          continue;
        }

        let progressIntervalId: NodeJS.Timeout | null = null;

        try {
          // Smooth fake progress for all phases — no blocking backend calls
          let currentProgress = 0;

          progressIntervalId = setInterval(() => {
            currentProgress += 3;
            if (currentProgress <= 100) {
              setPhaseInternalProgress(currentProgress);
            } else {
              if (progressIntervalId) {
                clearInterval(progressIntervalId);
                progressIntervalId = null;
              }
            }
          }, 80);

          await new Promise<void>((resolve) => {
            const checkInterval = setInterval(() => {
              if (currentProgress >= 100) {
                clearInterval(checkInterval);
                if (progressIntervalId) {
                  clearInterval(progressIntervalId);
                  progressIntervalId = null;
                }
                resolve();
              }
            }, 50);
          });

          setPhaseInternalProgress(100);
          await wait(150);

          console.log(`[Setup] Completed phase: ${phaseName}`);
        } catch (error) {
          console.error(`[Setup] Error during phase ${phaseName}:`, error);

          if (progressIntervalId) {
            clearInterval(progressIntervalId);
          }

          setPhaseInternalProgress(100);
        } finally {
          if (progressIntervalId) {
            clearInterval(progressIntervalId);
          }

          setPhaseCommandRunning(false);
        }

        setCompletedPhases((prev: Set<string>) => {
          const newSet = new Set(prev);
          newSet.add(phaseName);
          return newSet;
        });
      }

      setIsFullyComplete(true);
      setSplashComplete(true);
    };

    runSetupPhases();
  }, [
    setPhase,
    setCompletedPhases,
    setCurrentPhaseIndex,
    setPhaseCommandRunning,
    setIsUpdateCheckPhase,
    setPhaseInternalProgress,
    setSplashComplete,
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
