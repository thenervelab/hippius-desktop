import { AppSetupPhases } from "@/app/lib/types";
import { remap } from "@/app/lib/utils";
import { atom } from "jotai";
import { APP_SETUP_PHASES } from "@/app/lib/constants/appSetupPhases";
import { updateCheckCompleteAtom } from "@/app/components/updater/updateStore";

export const phaseAtom = atom<AppSetupPhases | null>(null);

export const phaseProgressionClockAtom = atom(0);

export const stepAtom = atom((get) => {
  const phase = get(phaseAtom);
  const updateCheckComplete = get(updateCheckCompleteAtom);

  // During update check, always return 0 to show first phase
  if (!updateCheckComplete) {
    return 0;
  }

  if (phase) {
    return APP_SETUP_PHASES.findIndex((v) => v === phase);
  }

  return 0;
});

export const progressAtom = atom((get) => {
  const updateCheckComplete = get(updateCheckCompleteAtom);

  // Force 0% progress during update check - don't calculate step/clock
  if (!updateCheckComplete) {
    return 0;
  }

  const step = get(stepAtom);
  const phaseProgressionClock = get(phaseProgressionClockAtom);
  const total = step + phaseProgressionClock;
  return remap(total, 0, APP_SETUP_PHASES.length - 1, 0, 98);
});
