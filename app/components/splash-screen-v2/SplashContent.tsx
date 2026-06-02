import { Icons } from "@/components/ui";
import { ReactNode } from "react";

export type AppSetupPhaseContent = {
  icon: ReactNode;
  status: string;
  subStatus: string;
  command: string;
  weight: number; // Percentage weight (must sum to 100 across all phases)
  commandTriggerPercent: number; // When to execute command within phase range (0-100)
};

export const APP_SETUP_EVENT = "app_setup_event";
export const PHASE_PROGRESS_EVENT = "phase_progress_event";

// Minimum duration for each phase animation in ms
export const MIN_PHASE_DURATION = 1500;

// Update check is shown at 0% before main progress kicks in. It blocks until
// `updateCheckCompleteAtom` flips, so it has no weight in the phased progress
// math.
export const UPDATE_CHECK_CONTENT: AppSetupPhaseContent = {
  icon: <Icons.CentralizedDataBase className="h-[min(140px,20vh)] w-[min(230px,32vh)]" />,
  status: "Checking for Updates",
  subStatus: "Please wait while we check for new version...",
  command: "check_updates",
  weight: 0,
  commandTriggerPercent: 0,
};

// Main phases (weights must sum to 100). Today there is a single terminal
// beat that fills the bar to 100% while `splash::finish_splash` resolves on
// the Rust side. Re-introduce additional phases here if a future feature
// needs a multi-step splash.
export const PHASE_CONTENT: Record<string, AppSetupPhaseContent> = {
  finish_splash: {
    icon: <Icons.SyncData className="h-[min(170px,24vh)] w-[min(194px,27vh)]" />,
    status: "Launching App 🚀",
    subStatus: "Preparing your decentralized experience...",
    command: "finish_splash",
    weight: 100,
    commandTriggerPercent: 50,
  },
};
