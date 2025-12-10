"use client";
import { useEffect, useState, useRef } from "react";
import SplashScreen from "./SplashScreen";
import { useAtom, useSetAtom, useAtomValue } from "jotai";
import { phaseAtom, phaseProgressionClockAtom } from "./atoms";
import {
  updateCheckCompleteAtom,
  updateDialogOpenAtom,
  updateStore,
} from "@/app/components/updater/updateStore";
import { cn } from "@/app/lib/utils";
import * as Dialog from "@radix-ui/react-dialog";

export default function SplashWrapper({
  children,
}: {
  children: React.ReactNode;
  skipSplash?: boolean;
}) {
  const [phase, setPhase] = useAtom(phaseAtom);
  const setPhaseProgressionClock = useSetAtom(phaseProgressionClockAtom);
  const [showSplash, setShowSplash] = useState(true);
  const splashCompletedRef = useRef(false);

  // Track update status
  const updateCheckComplete = useAtomValue(updateCheckCompleteAtom);
  const updateDialogOpen = useAtomValue(updateDialogOpenAtom, {
    store: updateStore,
  });
  const canProceedWithSplash = updateCheckComplete && !updateDialogOpen;

  // Reset phase progression clock and phase when update check is not complete or dialog is open
  useEffect(() => {
    // Don't reset if splash has already completed
    if (splashCompletedRef.current) return;

    if (!updateCheckComplete || updateDialogOpen) {
      setPhaseProgressionClock(0);
      // Reset phase to prevent any content changes
      if (updateDialogOpen && phase) {
        setPhase(null);
      }
    }
  }, [
    updateCheckComplete,
    updateDialogOpen,
    setPhaseProgressionClock,
    phase,
    setPhase,
  ]);

  useEffect(() => {
    // Don't run if splash has already completed
    if (splashCompletedRef.current) return;
    if (!canProceedWithSplash) return;

    if (phase !== "ready") {
      const timer = setTimeout(() => {
        setPhase("ready");
      }, 5000);

      return () => {
        clearTimeout(timer);
      };
    }
  }, [phase, setPhase, canProceedWithSplash]);

  useEffect(() => {
    // Don't run if splash has already completed
    if (splashCompletedRef.current) return;
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

  // Close splash dialog when ready
  useEffect(() => {
    // Don't run if splash has already completed
    if (splashCompletedRef.current) return;
    if (!canProceedWithSplash) return;

    if (phase === "ready") {
      const timeout = setTimeout(() => {
        splashCompletedRef.current = true;
        setShowSplash(false);
      }, 1000);

      return () => {
        clearTimeout(timeout);
      };
    }
  }, [phase, canProceedWithSplash]);

  const isReady = phase === "ready";

  return (
    <>
      {/* Always render children so WebSocket connections are established */}
      <div className={cn(showSplash && "invisible")}>{children}</div>

      {/* Splash screen as a dialog overlay */}
      <Dialog.Root open={showSplash}>
        <Dialog.Portal>
          <Dialog.Overlay
            className={cn(
              "fixed inset-0 z-40 bg-primary-10 transition-opacity duration-300",
              isReady && "opacity-0"
            )}
          />
          <Dialog.Content
            className={cn(
              "fixed inset-0 z-40 flex flex-col items-center justify-center w-full h-full transition-all duration-300",
              isReady && "pointer-events-none opacity-0 scale-90"
            )}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <Dialog.Title className="sr-only">Loading</Dialog.Title>
            <Dialog.Description className="sr-only">
              Application is loading
            </Dialog.Description>
            <SplashScreen />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
