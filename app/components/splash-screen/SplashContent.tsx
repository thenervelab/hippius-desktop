import { AppSetupPhaseContent } from "@/app/lib/constants";
import { Icons } from "@/components/ui";
import { AppSetupPhases } from "@/app/lib/types";

export const PHASE_CONTENT: Record<AppSetupPhases, AppSetupPhaseContent> = {
  checking_binary: {
    icon: <Icons.CheckingIPFS className="h-[140px] w-[230px]" />,
    status: "Checking IPFS Status",
    subStatus: "Verifying node status ....",
  },
  // downloading_binary: {
  //   icon: <Icons.DownloadingIPFS className="h-[200] w-[130px] " />,
  //   status: "Downloading IPFS",
  //   subStatus: "Fetching and installing IPFS binary ....",
  // },
  initializing_repo: {
    icon: <Icons.InitializeRepo className="h-[222px] w-[110px] " />,
    status: "Initializing IPFS Repository",
    subStatus: "Setting up IPFS repository ....",
  },
  configuring_cors: {
    icon: (
      <Icons.ConfiguringCORS className="h-[130px] w-[145px] animate-spin-fast " />
    ),
    status: "Configuring CORS",
    subStatus: "Setting up CORS headers for IPFS API ....",
  },
  starting_daemon: {
    icon: (
      <Icons.StartingDaemon className="h-[135px] w-[135px] animate-spin-fast overflow-hidden" />
    ),
    status: "Starting Daemon",
    subStatus: "Preparing background services ....",
  },
  connecting_to_network: {
    icon: <Icons.ConnectingNetwork className="h-[130px] w-[240px]" />,
    status: "Connecting to Network",
    subStatus: "Establishing peer connections ....",
  },
  initialising_database: {
    icon: <Icons.CentralizedDataBase className="h-[156px] w-[225px]" />,
    status: "Initializing Decentralized Database",
    subStatus: "Setting up database service ....",
  },
  syncing_data: {
    icon: <Icons.SyncData className="h-[170px] w-[194px]" />,
    status: "Syncing Data",
    subStatus: "Setting up database service ....",
  },

  //////////////// - Ready does not really show since its revealing the dashboard at that point

  ready: {
    icon: <Icons.SyncData className="h-[170px] w-[194px]" />,
    status: "Syncing Data",
    subStatus: "Setting up database service ....",
  },
};
