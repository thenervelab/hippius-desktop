import { atom } from "jotai";
import { PHASE_CONTENT } from "./SplashContent";

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

  // During update check phase, always show 0%
  if (isUpdateCheckPhase) {
    return 0;
  }

  if (!phase) {
    return 0;
  }

  const phaseKeys = Object.keys(PHASE_CONTENT);
  const currentPhaseIndex = phaseKeys.findIndex((p) => p === phase);

  if (currentPhaseIndex === -1) {
    return 0;
  }

  // Calculate base progress from all PREVIOUS completed phases
  let baseProgress = 0;
  for (let i = 0; i < currentPhaseIndex; i++) {
    const phaseKey = phaseKeys[i];
    baseProgress += PHASE_CONTENT[phaseKey].weight;
  }

  // Add progress within current phase
  const currentPhaseKey = phaseKeys[currentPhaseIndex];
  const currentPhaseWeight = PHASE_CONTENT[currentPhaseKey].weight;

  // Scale phase internal progress (0-100) to phase weight
  // Clamp phaseInternalProgress between 0-100
  const clampedProgress = Math.max(0, Math.min(100, phaseInternalProgress));
  const phaseProgress = (clampedProgress / 100) * currentPhaseWeight;

  const totalProgress = baseProgress + phaseProgress;

  // Never exceed 100% or go below base progress
  return Math.max(baseProgress, Math.min(totalProgress, 99.9));
});
