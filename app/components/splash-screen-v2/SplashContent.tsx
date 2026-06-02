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

// The update-check beat is held noticeably longer than the cosmetic main
// phases so the "Checking for Updates" message stays on screen long enough to
// actually read (client feedback: it flashed by too fast to see when the
// updater resolved instantly from cache/offline).
export const UPDATE_CHECK_MIN_DURATION = 3500;

// Update check is shown at 0% before main progress kicks in. It blocks until
// `updateCheckCompleteAtom` flips, so it has no weight in the phased progress
// math.
export const UPDATE_CHECK_CONTENT: AppSetupPhaseContent = {
  icon: (
    <Icons.CentralizedDataBase className="h-[min(140px,20vh)] w-[min(230px,32vh)]" />
  ),
  status: "Checking for Updates",
  subStatus: "Please wait while we check for new version...",
  command: "check_updates",
  weight: 0,
  commandTriggerPercent: 0,
};

// Main phases (weights must sum to 100). These are purely cosmetic loading
// beats — the wrapper (`index.tsx`) animates each phase's progress 0→100 in
// sequence without invoking a backend command per beat, so they exist only so
// the splash doesn't sit on a single "Launching App" message the whole time.
// The copy mirrors the legacy multi-step splash (Checking tools for Hippius
// Mesh) for continuity. The terminal `finish_splash` beat fills the bar to
// 100% while `splash::finish_splash` resolves on the Rust side, so it MUST
// stay last. Per-beat speed is tuned in `index.tsx` (the progress tick): two
// beats at ~2s each keep the whole splash ~4s, so the count and the tick are
// balanced together — dropping a beat means slowing the tick to hold ~4s.
export const PHASE_CONTENT: Record<string, AppSetupPhaseContent> = {
  checking_tools: {
    icon: (
      <Icons.CheckingIPFS className="h-[min(140px,20vh)] w-[min(230px,32vh)]" />
    ),
    status: "Checking Tools",
    subStatus: "Verifying tools for Hippius Mesh...",
    command: "checking_tools",
    weight: 50, // 0-50%
    commandTriggerPercent: 50,
  },
  finish_splash: {
    icon: (
      <Icons.SyncData className="h-[min(170px,24vh)] w-[min(194px,27vh)]" />
    ),
    status: "Launching App 🚀",
    subStatus: "Almost ready, securing your encrypted space...",
    command: "finish_splash",
    weight: 50, // 50-100%
    commandTriggerPercent: 50,
  },
};
