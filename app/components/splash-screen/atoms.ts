import { atom } from "jotai";
import { PHASE_CONTENT } from "./SplashContent";

export const phaseAtom = atom<string | null>(null);

// Track if we're in the update check phase (before main phases)
export const isUpdateCheckPhaseAtom = atom<boolean>(true);

// Track if nebula is already installed (skip progress bar if true)
export const nebulaInstalledAtom = atom<boolean | null>(null);

// Track completed phases (phase name -> completion status)
export const completedPhasesAtom = atom<Set<string>>(new Set<string>());

export const currentPhaseIndexAtom = atom<number>(0);

export const phaseCommandRunningAtom = atom<boolean>(false);

export const stepAtom = atom((get) => {
  const phase = get(phaseAtom);
  const phaseKeys = Object.keys(PHASE_CONTENT);

  if (phase) {
    const index = phaseKeys.findIndex((v) => v === phase);
    return index >= 0 ? index : 0;
  }

  return 0;
});

// Progress percentage based on completed phases
// 5 phases = 20% each
export const progressAtom = atom((get) => {
  const completedPhases = get(completedPhasesAtom);
  const isCommandRunning = get(phaseCommandRunningAtom);
  const phase = get(phaseAtom);
  const isUpdateCheckPhase = get(isUpdateCheckPhaseAtom);

  // During update check phase, always show 0%
  if (isUpdateCheckPhase) {
    return 0;
  }

  const phaseKeys = Object.keys(PHASE_CONTENT);
  const totalPhases = phaseKeys.length;
  const phasePercent = 100 / totalPhases;

  // Count completed phases
  const completedCount = phaseKeys.filter((p) => completedPhases.has(p)).length;
  const baseProgress = (completedCount / totalPhases) * 100;

  // Get current phase index
  const currentProgressIndex = phase
    ? phaseKeys.findIndex((p) => p === phase)
    : -1;

  if (
    isCommandRunning &&
    currentProgressIndex >= 0 &&
    currentProgressIndex < totalPhases
  ) {
    // Progress should be: completed phases + 95% of current phase
    const targetProgress = baseProgress + phasePercent * 0.95;
    return Math.min(targetProgress, 99); // Never exceed 99% while running
  }

  return Math.min(baseProgress, 100);
});
