import { APP_SETUP_PHASES } from "@/app/lib/constants";
import { AppSetupPhases } from "@/app/lib/types";
import { remap } from "@/app/lib/utils";
import { atom } from "jotai";

export const phaseAtom = atom<AppSetupPhases | null>(null);

export const phaseProgressionClockAtom = atom(0);

export const stepAtom = atom((get) => {
  const phase = get(phaseAtom);

  if (phase) {
    return APP_SETUP_PHASES.findIndex((v) => v === phase);
  }

  return 0;
});

export const progressAtom = atom((get) => {
  const step = get(stepAtom);
  const phaseProgressionClock = get(phaseProgressionClockAtom);

  const total = step + phaseProgressionClock;

  return remap(total, 0, APP_SETUP_PHASES.length - 1, 0, 98);
});
