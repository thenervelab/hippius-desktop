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
  phaseInternalProgressAtom,
  splashCompleteAtom,
} from "./atoms";
import {
  updateCheckCompleteAtom,
  updateDialogOpenAtom,
  updateStore,
} from "@/app/components/updater/updateStore";
import { cn } from "@/app/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import {
  getPhaseContent,
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
  const setNebulaInstalled = useSetAtom(nebulaInstalledAtom);
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
      setNebulaInstalled(null);
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
    setNebulaInstalled,
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
      // Get the dynamic phase content based on installation state
      const dynamicPhaseContent = getPhaseContent();
      const phaseNames = Object.keys(dynamicPhaseContent);

      for (let i = 0; i < phaseNames.length; i++) {
        const phaseName = phaseNames[i];
        console.log(`[Setup] Starting phase ${i + 1}/${phaseNames.length}: ${phaseName}`);

        // STEP 1: Set up the phase
        setPhase(phaseName);
        setCurrentPhaseIndex(i);
        setPhaseInternalProgress(0);
        setPhaseCommandRunning(true);

        const phaseContent: AppSetupPhaseContent | undefined =
          dynamicPhaseContent[phaseName];

        if (!phaseContent) {
          console.warn(`Unknown phase: ${phaseName}`);
          setPhaseCommandRunning(false);
          continue;
        }

        // STEP 2: Animate to command trigger point, execute, then continue
        let progressIntervalId: NodeJS.Timeout | null = null;
        const commandTriggerPercent = phaseContent.commandTriggerPercent;

        try {
          // Determine which phases need real backend execution
          const shouldExecuteCommand =
            phaseName === "checking_binary" ||    // Always check
            phaseName === "verifying_installation" || // Always verify
            phaseName === "ready" ||              // Always finish setup
            !isAlreadyInstalled;                  // Execute all if not installed

          // Determine if this phase has backend progress events
          const hasBackendProgress =
            phaseName === "downloading_nebula" ||
            phaseName === "installing_nebula";

          if (isAlreadyInstalled && !shouldExecuteCommand) {
            // VPN installed mode: Show fake smooth progress for download/install
            console.log(`[Setup] VPN installed - showing fake progress for ${phaseName}`);

            let currentProgress = 0;

            // Animate through entire phase smoothly
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

            // Wait for animation to complete
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

            // Ensure we show 100%
            setPhaseInternalProgress(100);

          } else if (!shouldExecuteCommand) {
            // Fast path for skipped phases when already installed
            await invoke(phaseContent.command);
          } else {
            // Normal execution path (VPN not installed OR critical phases)
            // PART A: Animate to command trigger point
            console.log(`[Setup] Animating to ${commandTriggerPercent}%`);
            let currentProgress = 0;
            const targetProgress = commandTriggerPercent;

            progressIntervalId = setInterval(() => {
              currentProgress += 5;
              if (currentProgress <= targetProgress) {
                setPhaseInternalProgress(currentProgress);
              } else {
                if (progressIntervalId) {
                  clearInterval(progressIntervalId);
                  progressIntervalId = null;
                }
              }
            }, 100);

            // Wait until we reach trigger point
            await new Promise<void>((resolve) => {
              const checkInterval = setInterval(() => {
                if (currentProgress >= targetProgress) {
                  clearInterval(checkInterval);
                  if (progressIntervalId) {
                    clearInterval(progressIntervalId);
                    progressIntervalId = null;
                  }
                  resolve();
                }
              }, 50);
            });

            // Ensure we're at exact trigger point
            setPhaseInternalProgress(commandTriggerPercent);
            console.log(`[Setup] Reached ${commandTriggerPercent}%, executing command...`);

            // PART B: Execute the backend command
            await runWithMinDuration(invoke(phaseContent.command));
            console.log(`[Setup] Command completed`);

            // PART C: Continue animation from trigger point to 100%
            if (hasBackendProgress && !isAlreadyInstalled) {
              // Backend will emit events to complete the phase
              console.log(`[Setup] Waiting for backend progress events...`);
            } else {
              // Animate from trigger point to 100%
              console.log(`[Setup] Animating from ${commandTriggerPercent}% to 100%`);
              currentProgress = commandTriggerPercent;

              progressIntervalId = setInterval(() => {
                currentProgress += 5;
                if (currentProgress <= 100) {
                  setPhaseInternalProgress(currentProgress);
                } else {
                  if (progressIntervalId) {
                    clearInterval(progressIntervalId);
                    progressIntervalId = null;
                  }
                }
              }, 100);

              // Wait until we reach 100%
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
            }
          }

          // STEP 3: Complete the phase
          setPhaseInternalProgress(100);

          // Small delay to show 100% before moving to next phase
          if (!isAlreadyInstalled) {
            await wait(200);
          } else {
            await wait(150); // Slightly faster transitions when VPN installed
          }

          console.log(`[Setup] Completed phase: ${phaseName}`);

        } catch (error) {
          console.error(`[Setup] Error during phase ${phaseName}:`, error);

          // Clean up interval on error
          if (progressIntervalId) {
            clearInterval(progressIntervalId);
          }

          // Still mark as complete to continue setup
          setPhaseInternalProgress(100);

          if (!isAlreadyInstalled) {
            await wait(200);
          }
        } finally {
          // Ensure interval is cleaned up
          if (progressIntervalId) {
            clearInterval(progressIntervalId);
          }

          setPhaseCommandRunning(false);
        }

        // Mark phase as completed before moving to next
        setCompletedPhases((prev: Set<string>) => {
          const newSet = new Set(prev);
          newSet.add(phaseName);
          return newSet;
        });
      }

      // Wait a bit for the final animation to complete before marking fully complete
      // Only if not already installed
      if (!isAlreadyInstalled) {
        await wait(800);
      }
      setIsFullyComplete(true);
      setSplashComplete(true);
    };

    runSetupPhases();
  }, [
    setPhase,
    setCompletedPhases,
    setNebulaInstalled,
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
