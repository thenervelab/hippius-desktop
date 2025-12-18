import { Icons } from "@/components/ui";
import { ReactNode } from "react";

export type AppSetupPhaseContent = {
  icon: ReactNode;
  status: string;
  subStatus: string;
  command: string;
};

export const APP_SETUP_EVENT = "app_setup_event";

// Minimum duration for each phase animation in ms
export const MIN_PHASE_DURATION = 1500;

// Separate content for update check phase (shown at 0%, not part of progress)
export const UPDATE_CHECK_CONTENT: AppSetupPhaseContent = {
  icon: <Icons.CheckingIPFS className="h-[140px] w-[230px]" />,
  status: "Checking for Updates",
  subStatus: "Please wait while we check for new version...",
  command: "check_updates",
};

// Main phases that contribute to progress (5 phases = 20% each)
export const PHASE_CONTENT: Record<string, AppSetupPhaseContent> = {
  checking_binary: {
    icon: <Icons.CheckingIPFS className="h-[140px] w-[230px]" />,
    status: "Checking Tools",
    subStatus: "Verifying tools for Hippius Mesh...",
    command: "check_nebula_requirements",
  },
  downloading_nebula: {
    icon: <Icons.DownloadingIPFS className="h-[200] w-[130px]" />,
    status: "Downloading Tools",
    subStatus: "Fetching tools for Hippius Mesh...",
    command: "download_nebula",
  },
  installing_nebula: {
    icon: <Icons.InitializeRepo className="h-[222px] w-[110px]" />,
    status: "Installing Tools",
    subStatus: "Installing Hippius Mesh Tools. Enter your password to continue...",
    command: "install_nebula",
  },
  verifying_installation: {
    icon: (
      <Icons.ConfiguringCORS className="h-[130px] w-[145px] animate-spin-fast" />
    ),
    status: "Verifying Tools",
    subStatus: "Confirming tools for Hippius Mesh...",
    command: "verify_nebula",
  },
  ready: {
    icon: <Icons.SyncData className="h-[170px] w-[194px]" />,
    status: "Launching App 🚀",
    subStatus: "Preparing your decentralized experience...",
    command: "finish_setup",
  },
};
