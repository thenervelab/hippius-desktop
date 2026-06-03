import { atom } from "jotai";
import { PHASE_CONTENT, UPDATE_CHECK_CEILING } from "./SplashContent";

export const phaseAtom = atom<string | null>(null);

export { splashCompleteAtom } from "@/lib/global-atoms/splashAtoms";

// Track if we're in the update check phase (before main phases)
export const isUpdateCheckPhaseAtom = atom<boolean>(true);

// Track completed phases (phase name -> completion status)
export const completedPhasesAtom = atom<Set<string>>(new Set<string>());

export const currentPhaseIndexAtom = atom<number>(0);

export const phaseCommandRunningAtom = atom<boolean>(false);

// Track current phase's internal progress (0-100) reported by backend
// Use writable atom so we can update it from the component
const _phaseInternalProgressAtom = atom<number>(0);
export const phaseInternalProgressAtom = atom(
  (get) => get(_phaseInternalProgressAtom),
  (get, set, newValue: number) => {
    // Ensure value is always between 0-100
    const clampedValue = Math.max(0, Math.min(100, newValue));
    set(_phaseInternalProgressAtom, clampedValue);
  }
);

export const stepAtom = atom((get) => {
  const phase = get(phaseAtom);
  const phaseKeys = Object.keys(PHASE_CONTENT);

  if (phase) {
    const index = phaseKeys.findIndex((v) => v === phase);
    return index >= 0 ? index : 0;
  }

  return 0;
});


// Progress percentage based on weighted phases and real-time backend progress
export const progressAtom = atom((get) => {
  const phase = get(phaseAtom);
  const isUpdateCheckPhase = get(isUpdateCheckPhaseAtom);
  const phaseInternalProgress = get(_phaseInternalProgressAtom);

  const clampedInternal = Math.max(0, Math.min(100, phaseInternalProgress));

  // During the update-check beat, fill the bar from 0% up to the ceiling
  // (e.g. 15%) so the user sees real movement instead of a frozen 0%. The
  // ceiling is reached as the beat's internal progress hits 100.
  if (isUpdateCheckPhase) {
    return (clampedInternal / 100) * UPDATE_CHECK_CEILING;
  }

  // The main phases occupy the remaining span above the ceiling.
  const mainSpan = 100 - UPDATE_CHECK_CEILING;

  if (!phase) {
    return UPDATE_CHECK_CEILING;
  }

  const phaseKeys = Object.keys(PHASE_CONTENT);
  const currentPhaseIndex = phaseKeys.findIndex((p) => p === phase);

  if (currentPhaseIndex === -1) {
    return UPDATE_CHECK_CEILING;
  }

  // Calculate base progress (0-100 across the main phases only) from all
  // PREVIOUS completed phases.
  let baseProgress = 0;
  for (let i = 0; i < currentPhaseIndex; i++) {
    const phaseKey = phaseKeys[i];
    baseProgress += PHASE_CONTENT[phaseKey].weight;
  }

  // Add progress within current phase, scaled by the phase's weight.
  const currentPhaseKey = phaseKeys[currentPhaseIndex];
  const currentPhaseWeight = PHASE_CONTENT[currentPhaseKey].weight;
  const phaseProgress = (clampedInternal / 100) * currentPhaseWeight;

  // Map the main-phase 0-100 range onto [UPDATE_CHECK_CEILING, 100] so the bar
  // resumes from the ceiling instead of snapping back toward 0.
  const scaledBase = UPDATE_CHECK_CEILING + (baseProgress / 100) * mainSpan;
  const scaledTotal =
    UPDATE_CHECK_CEILING + ((baseProgress + phaseProgress) / 100) * mainSpan;

  // Never exceed 100% or go below the scaled base progress.
  return Math.max(scaledBase, Math.min(scaledTotal, 99.9));
});
