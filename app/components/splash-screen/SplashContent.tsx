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

// Separate content for update check phase (shown at 0%, not part of progress)
export const UPDATE_CHECK_CONTENT: AppSetupPhaseContent = {
  icon: <Icons.CentralizedDataBase className="h-[min(140px,20vh)] w-[min(230px,32vh)]" />,
  status: "Checking for Updates",
  subStatus: "Please wait while we check for new version...",
  command: "check_updates",
  weight: 0, // Not part of main progress
  commandTriggerPercent: 0,
};

// Main phases with weighted percentages (must sum to 100)
// commandTriggerPercent: when to execute backend command (50 = execute at midpoint)
export const PHASE_CONTENT_BASE: Record<string, AppSetupPhaseContent> = {
  checking_binary: {
    icon: <Icons.CheckingIPFS className="h-[min(140px,20vh)] w-[min(230px,32vh)]" />,
    status: "Checking Tools",
    subStatus: "Verifying tools for Hippius Mesh...",
    command: "check_nebula_requirements",
    weight: 20, // 0-20%
    commandTriggerPercent: 50, // Execute at 10% (50% through the 0-20% range)
  },
  downloading_nebula: {
    icon: <Icons.DownloadingIPFS className="h-[min(200px,28vh)] w-[min(130px,19vh)]" />,
    status: "Downloading Tools",
    subStatus: "Fetching tools for Hippius Mesh...",
    command: "download_nebula",
    weight: 20, // 20-40%
    commandTriggerPercent: 50, // Execute at 30% (50% through the 20-40% range)
  },
  installing_nebula: {
    icon: <Icons.InitializeRepo className="h-[min(180px,26vh)] w-[min(180px,26vh)]" />,
    status: "Installing Tools",
    subStatus: "", // Will be set dynamically based on installation state
    command: "install_nebula",
    weight: 20, // 40-60%
    commandTriggerPercent: 50, // Execute at 50% (50% through the 40-60% range)
  },
  verifying_installation: {
    icon: (
      <Icons.ConfiguringCORS className="h-[min(130px,19vh)] w-[min(145px,21vh)] animate-spin-fast" />
    ),
    status: "Verifying Tools",
    subStatus: "Confirming tools for Hippius Mesh...",
    command: "verify_nebula",
    weight: 20, // 60-80%
    commandTriggerPercent: 50, // Execute at 70% (50% through the 60-80% range)
  },
  ready: {
    icon: <Icons.SyncData className="h-[min(170px,24vh)] w-[min(194px,27vh)]" />,
    status: "Launching App 🚀",
    subStatus: "Preparing your decentralized experience...",
    // Renamed from `finish_setup` (which was the Nebula auto-start hook) to
    // `finish_splash` (the no-op terminal handshake in `src-tauri/src/splash.rs`).
    // Avoids a `generate_handler!` name collision while the Nebula module is
    // being removed across subsequent commits.
    command: "finish_splash",
    weight: 20, // 80-100%
    commandTriggerPercent: 50, // Execute at 90% (50% through the 80-100% range)
  },
};

/**
 * Get phase content with appropriate messages
 * @returns Phase content with appropriate messages
 */
export function getPhaseContent(): Record<string, AppSetupPhaseContent> {
  const content = { ...PHASE_CONTENT_BASE };

  content.installing_nebula.subStatus = "Installing Hippius Mesh Tools...";

  return content;
}

// For backwards compatibility with existing code that imports PHASE_CONTENT directly
export const PHASE_CONTENT = PHASE_CONTENT_BASE;
