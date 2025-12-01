import { Icons } from "@/components/ui";
import { ReactNode } from "react";

export type AppSetupPhaseContent = {
  icon: ReactNode;
  status: string;
  subStatus: string;
  command: string;
};

export const APP_SETUP_EVENT = "app_setup_event";

export const PHASE_CONTENT: Record<string, AppSetupPhaseContent> = {
  checking_binary: {
    icon: <Icons.CheckingIPFS className="h-[140px] w-[230px]" />,
    status: "Checking Tools",
    subStatus: "Verifying tools for Hippius Mesh...",
    command: "dummy_setup_step",
  },
  downloading_nebula: {
    icon: <Icons.DownloadingIPFS className="h-[200] w-[130px]" />,
    status: "Downloading Tools",
    subStatus: "Fetching tools for Hippius Mesh...",
    command: "dummy_setup_step",
  },
  installing_nebula: {
    icon: <Icons.InitializeRepo className="h-[222px] w-[110px]" />,
    status: "Installing Tools",
    subStatus: "Setting up tools for Hippius Mesh...",
    command: "dummy_setup_step",
  },
  verifying_installation: {
    icon: (
      <Icons.ConfiguringCORS className="h-[130px] w-[145px] animate-spin-fast" />
    ),
    status: "Verifying Tools",
    subStatus: "Confirming tools for Hippius Mesh...",
    command: "dummy_setup_step",
  },
  ready: {
    icon: <Icons.SyncData className="h-[170px] w-[194px]" />,
    status: "Launching App 🚀",
    subStatus: "Preparing your decentralized experience...",
    command: "dummy_setup_step",
  },
};
