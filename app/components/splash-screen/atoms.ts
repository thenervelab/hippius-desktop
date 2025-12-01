import { atom } from "jotai";
import { PHASE_CONTENT } from "./SplashContent";
import { updateCheckCompleteAtom } from "@/app/components/updater/updateStore";

export const phaseAtom = atom<string | null>(null);

export const stepAtom = atom((get) => {
  const phase = get(phaseAtom);
  const updateCheckComplete = get(updateCheckCompleteAtom);

  // During update check, always return 0 to show first phase
  if (!updateCheckComplete) {
    return 0;
  }

  if (phase) {
    return Object.keys(PHASE_CONTENT).findIndex((v) => v === phase);
  }

  return 0;
});
