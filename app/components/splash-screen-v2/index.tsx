"use client";
import { useEffect, useState, useRef } from "react";
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
  UPDATE_CHECK_MIN_DURATION,
  PHASE_PROGRESS_EVENT,
} from "./SplashContent";
import { listen } from "@tauri-apps/api/event";
import LoadingScreen from "./LoadingScreen";
import PixelateTransition from "./PixelateTransition";
import GrainTexture from "./GrainTexture";
import PageLoader from "@/app/components/PageLoader";
import { shouldResetSplashForUpdateDialog } from "./splashReset";

// Splash background blue, shared by the loader card and the outro pixel grid so
// the dissolve into the app reads as one continuous colour wash.
const SPLASH_BG = "#3167DD";

// Intro PixelateTransition timing (seconds). The setup progress bar holds at
// 0% until the opening dissolve completes so the percentage never moves while
// the intro is still playing; these are the single source of truth for both
// the <PixelateTransition> props and that hold.
const INTRO_DELAY_S = 0.05;
const INTRO_DURATION_S = 1.8;
const INTRO_TOTAL_MS = (INTRO_DELAY_S + INTRO_DURATION_S) * 1000;

// Derive a square pixel grid from the viewport width so cells stay roughly
// uniform across window sizes (mirrors the mockup's `getGridSize`).
function getGridSize() {
  return Math.max(
    7,
    Math.floor(
      (typeof window !== "undefined" ? window.innerWidth : 1024) / 100,
    ),
  );
}

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
  // True once the 1.5s page-loading handoff has finished. Children mount while
  // this loader is still covering the app, which lets route/auth guards settle
  // without showing another full-screen loader after the splash.
  const [outroDone, setOutroDone] = useState(false);
  const setSplashComplete = useSetAtom(splashCompleteAtom);
  const setupStartedRef = useRef(false);

  // Pixel grid dimension for the intro/outro transitions; recomputed on resize
  // so the outro grid matches the current window.
  const [gridSize, setGridSize] = useState(() => getGridSize());

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

  // Keep the transition grid sized to the window.
  useEffect(() => {
    const onResize = () => setGridSize(getGridSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Listen for phase progress events from backend (download/install progress)
  useEffect(() => {
    let mounted = true;
    const setupListener = async () => {
      const unlisten = await listen<{ phase: string; progress: number }>(
        PHASE_PROGRESS_EVENT,
        (event) => {
          if (!mounted) return;

          const { phase: eventPhase, progress } = event.payload;
          console.log(
            `[Progress Event] Phase: ${eventPhase}, Progress: ${progress}%`,
          );

          // Only update if this event is for the current phase
          if (currentPhaseRef.current === eventPhase) {
            const clampedProgress = Math.max(0, Math.min(100, progress));
            setPhaseInternalProgress(clampedProgress);
          } else {
            console.log(
              `[Progress Event] Ignoring - current phase is ${currentPhaseRef.current}`,
            );
          }
        },
      );

      return unlisten;
    };

    const unlistenPromise = setupListener();

    return () => {
      mounted = false;
      unlistenPromise.then((fn) => fn());
    };
  }, [setPhaseInternalProgress]);

  // Rewind the splash to its update-check beat when the updater dialog opens
  // OVER the still-running splash during boot. Gated on `isFullyComplete` so it
  // never fires once the splash has finished and handed off to the app: a
  // manually-opened update dialog (profile menu, tray "Check for Updates", deep
  // link) would otherwise flip `isFullyComplete` back to false, unmounting the
  // app behind the dialog's full-screen overlay and leaving a blank window when
  // the dialog is closed. See `shouldResetSplashForUpdateDialog`.
  useEffect(() => {
    if (
      shouldResetSplashForUpdateDialog({
        updateDialogOpen,
        hasActivePhase: Boolean(phase),
        splashFullyComplete: isFullyComplete,
      })
    ) {
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
    isFullyComplete,
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
    minDuration: number = MIN_PHASE_DURATION,
  ) => {
    const startTime = Date.now();
    const result = await promise;
    const elapsed = Date.now() - startTime;
    if (elapsed < minDuration) {
      await new Promise((resolve) =>
        setTimeout(resolve, minDuration - elapsed),
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

    // Cancellation guard (audit FE-low): `runSetupPhases` is a long, fire-and-
    // forget async sequence. On an abrupt unmount (e.g. a fast login swapping
    // the splash out) every `await` resumption must bail before its setState,
    // and every timer must be cleared, so we neither leak intervals nor call
    // setState after unmount. The cleanup flips `cancelled` and clears `timers`.
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setInterval>>();
    const track = <T extends ReturnType<typeof setInterval>>(id: T): T => {
      timers.add(id);
      return id;
    };

    const runSetupPhases = async () => {
      // ========== UPDATE CHECK PHASE (at 0% - before main phases) ==========
      setIsUpdateCheckPhase(true);
      setPhase("checking_updates");

      const updateCheckPromise = new Promise<void>((resolve) => {
        const checkInterval = track(
          setInterval(() => {
            if (updateCheckCompleteRef.current || updateDialogOpenRef.current || cancelled) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 50),
        );

        track(
          setTimeout(() => {
            clearInterval(checkInterval);
            resolve();
          }, 10000),
        );
      });

      // Hold the bar at 0% while the opening dissolve plays so the percentage
      // doesn't move behind the still-animating intro. The check itself polls
      // in the background (updateCheckPromise) the whole time.
      setPhaseInternalProgress(0);
      await wait(INTRO_TOTAL_MS);
      if (cancelled) return;

      // After the intro, animate the beat's internal progress 0->100 over the
      // remaining update-check window. `progressAtom` maps that onto
      // 0->UPDATE_CHECK_CEILING (15%), so the bar visibly fills, then the main
      // phases resume from the ceiling. Keeping the total window at
      // UPDATE_CHECK_MIN_DURATION means the intro just eats into the front of
      // it rather than lengthening the splash.
      const rampDuration = Math.max(0, UPDATE_CHECK_MIN_DURATION - INTRO_TOTAL_MS);
      let updateCheckProgress = 0;
      const updateCheckProgressInterval = track(
        setInterval(() => {
          updateCheckProgress = Math.min(100, updateCheckProgress + 4);
          setPhaseInternalProgress(updateCheckProgress);
        }, rampDuration / 25),
      );

      // Held so the "Checking for Updates" beat never flickers off too fast
      // when the updater resolves immediately (cached / offline) — it needs to
      // stay up long enough to actually read.
      await runWithMinDuration(updateCheckPromise, rampDuration);
      clearInterval(updateCheckProgressInterval);
      if (cancelled) return;

      setPhaseInternalProgress(100);

      // If an update dialog opened, wait for the user to resolve it
      // (install / skip / cancel) before continuing to the main
      // phases. The PRIOR code did `return;` here, which left
      // `setupStartedRef.current` permanently `true` so `runSetupPhases`
      // never resumed — `setSplashComplete(true)` at the bottom was
      // never called, and any consumer gated on the atom (historically
      // `wallet-auth-context.tsx`'s `initSync`) was stranded forever.
      // Spinning here resumes naturally once `updateDialogOpenRef`
      // flips, after which the main phases run and the splash
      // completes normally. The interval is cheap (a single ref read
      // every 100ms); the cap is a safety net in case the dialog
      // state somehow gets stuck — at that point we proceed anyway
      // because the cost of an orphaned splash overlay is worse than
      // the cost of the main phases running concurrently with a
      // visible dialog.
      const DIALOG_WAIT_CAP_MS = 60_000;
      const dialogWaitStart = Date.now();
      while (
        updateDialogOpenRef.current &&
        Date.now() - dialogWaitStart < DIALOG_WAIT_CAP_MS
      ) {
        await wait(100);
      }
      if (updateDialogOpenRef.current) {
        console.warn(
          "[Setup] Update dialog still open after",
          DIALOG_WAIT_CAP_MS,
          "ms — proceeding past update-check phase anyway to avoid stranding splash.",
        );
      }

      if (cancelled) return;
      setIsUpdateCheckPhase(false);

      // ========== MAIN PHASES (quick animation, no blocking) ==========
      const phaseNames = Object.keys(PHASE_CONTENT);

      for (let i = 0; i < phaseNames.length; i++) {
        if (cancelled) return;
        const phaseName = phaseNames[i];
        console.log(
          `[Setup] Starting phase ${i + 1}/${phaseNames.length}: ${phaseName}`,
        );

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

          progressIntervalId = track(setInterval(() => {
            currentProgress += 4;
            if (currentProgress <= 100) {
              setPhaseInternalProgress(currentProgress);
            } else {
              if (progressIntervalId) {
                clearInterval(progressIntervalId);
                progressIntervalId = null;
              }
            }
          }, 75));

          await new Promise<void>((resolve) => {
            const checkInterval = track(setInterval(() => {
              if (currentProgress >= 100 || cancelled) {
                clearInterval(checkInterval);
                if (progressIntervalId) {
                  clearInterval(progressIntervalId);
                  progressIntervalId = null;
                }
                resolve();
              }
            }, 50));
          });
          if (cancelled) return;

          setPhaseInternalProgress(100);
          await wait(100);

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

      if (cancelled) return;
      setIsFullyComplete(true);
      setSplashComplete(true);
    };

    runSetupPhases();

    // Abrupt-unmount cleanup: stop the sequence and clear every tracked timer.
    return () => {
      cancelled = true;
      timers.forEach((t) => clearInterval(t));
      // The guard must reset here or React StrictMode (dev only) hangs the
      // splash forever: StrictMode mounts, CLEANS UP, and mounts again — this
      // cleanup cancels run one, and without the reset the second mount sees
      // "already started", starts nothing, and the splash sits at
      // "Checking for Updates 0%" with no phase machine running. Production
      // mounts effects once and never hits this path.
      setupStartedRef.current = false;
    };
  }, [
    setPhase,
    setCompletedPhases,
    setCurrentPhaseIndex,
    setPhaseCommandRunning,
    setIsUpdateCheckPhase,
    setPhaseInternalProgress,
    setSplashComplete,
  ]);

  // `isReady` flips when setup finishes (unless the splash is pinned open via
  // preventClose). It triggers the one-shot page-loading handoff.
  const isReady = isFullyComplete && !preventClose;

  // When setup finishes, swap the splash for the app's PageLoader with a
  // single-shot ring (`ringFill="once"`) that sweeps full in 1.2s and holds
  // there (`forwards`) — it never restarts from empty. Hold a touch past the
  // fill so the user registers the completed circle, then reveal the page.
  useEffect(() => {
    if (!isReady) return;

    const OUTRO_DURATION_MS = MIN_PHASE_DURATION;
    const timeout = setTimeout(() => {
      setOutroDone(true);
      setKeepSplacescreenInDom(false);
    }, OUTRO_DURATION_MS);

    return () => clearTimeout(timeout);
  }, [isReady]);

  return (
    <>
      {isReady && (
        <div
          aria-hidden={!outroDone}
          className={cn(!outroDone && "invisible pointer-events-none")}
        >
          {children}
        </div>
      )}
      {keepSplashscreenInDom && (
        <div
          className={cn(
            "fixed inset-0 z-40 flex flex-col items-center justify-center w-full h-full overflow-hidden",
            isReady && "pointer-events-none",
          )}
          // The overlay stays blue throughout the handoff; the PageLoader layer
          // below carries its own opaque app-background and fades in on top, so
          // blue+hippo dissolve into grey/black+lock as a single cross-fade
          // instead of a hard cut.
          style={{ backgroundColor: SPLASH_BG }}
        >
          {/* Splash layer (blue card + hippo). Fades out on the handoff so the
              lock underneath it is revealed gradually. */}
          <div
            className={cn(
              "absolute inset-0 flex flex-col items-center justify-center transition-opacity duration-500 ease-out",
              isReady && "opacity-0",
            )}
          >
            <GrainTexture />
            <PixelateTransition
              key="intro"
              color="black"
              gridSize={gridSize}
              // Stretched from 1.1s so the opening dissolve reads at a
              // similar pace to the ~2s phase beats below it instead of
              // snapping away faster than the rest of the splash. Kept in sync
              // with the progress-bar hold via the shared INTRO_* constants.
              duration={INTRO_DURATION_S}
              delay={INTRO_DELAY_S}
              from="random"
            />
            <LoadingScreen />
          </div>

          {/* Lock layer (PageLoader). Mounted only on handoff and faded in over
              the blue so the decrypting-lock animation arrives smoothly rather
              than snapping in. */}
          {isReady && (
            <div className="absolute inset-0 opacity-0 animate-fade-in-0.5">
              <PageLoader ringFill="once" />
            </div>
          )}
        </div>
      )}
    </>
  );
}
