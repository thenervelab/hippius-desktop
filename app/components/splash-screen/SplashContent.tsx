import { AppSetupPhaseContent } from "@/app/lib/constants";
import { Icons } from "@/components/ui";
import { AppSetupPhases } from "@/app/lib/types";

export const PHASE_CONTENT: Record<AppSetupPhases, AppSetupPhaseContent> = {
  checking_binary: {
    icon: <Icons.CheckingIPFS className="h-[140px] w-[230px]" />,
    status: "Checking Nebula VPN",
    subStatus: "Verifying Nebula installation status...",
  },
  downloading_nebula: {
    icon: <Icons.DownloadingIPFS className="h-[200] w-[130px]" />,
    status: "Downloading Nebula",
    subStatus: "Fetching latest Nebula release...",
  },
  installing_nebula: {
    icon: <Icons.InitializeRepo className="h-[222px] w-[110px]" />,
    status: "Installing Nebula",
    subStatus: "Setting up Nebula VPN client...",
  },
  verifying_installation: {
    icon: (
      <Icons.ConfiguringCORS className="h-[130px] w-[145px] animate-spin-fast" />
    ),
    status: "Verifying Installation",
    subStatus: "Confirming Nebula is ready...",
  },
  ready: {
    icon: <Icons.SyncData className="h-[170px] w-[194px]" />,
    status: "Launching App 🚀",
    subStatus: "Preparing your decentralized experience...",
  },
};
