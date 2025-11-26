import { AppSetupPhaseContent } from "@/app/lib/constants";
import { Icons } from "@/components/ui";
import { AppSetupPhases } from "@/app/lib/types";

export const PHASE_CONTENT: Record<AppSetupPhases, AppSetupPhaseContent> = {
  checking_binary: {
    icon: <Icons.CheckingIPFS className="h-[140px] w-[230px]" />,
    status: "Checking Tools",
    subStatus: "Verifying tools for Hippius Mesh...",
  },
  downloading_nebula: {
    icon: <Icons.DownloadingIPFS className="h-[200] w-[130px]" />,
    status: "Downloading Tools",
    subStatus: "Fetching tools for Hippius Mesh...",
  },
  installing_nebula: {
    icon: <Icons.InitializeRepo className="h-[222px] w-[110px]" />,
    status: "Installing Tools",
    subStatus: "Setting up tools for Hippius Mesh...",
  },
  verifying_installation: {
    icon: (
      <Icons.ConfiguringCORS className="h-[130px] w-[145px] animate-spin-fast" />
    ),
    status: "Verifying Tools",
    subStatus: "Confirming tools for Hippius Mesh...",
  },
  ready: {
    icon: <Icons.SyncData className="h-[170px] w-[194px]" />,
    status: "Launching App 🚀",
    subStatus: "Preparing your decentralized experience...",
  },
};
