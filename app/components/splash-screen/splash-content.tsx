import { Icons } from "../ui";
export const PROGRESS_CONTENT = [
  {
    icon: <Icons.CheckingIPFS className="h-[140px] w-[230px]" />,
    progress: 20,
    status: "Checking IPFS Status",
    subStatus: "Verifying node status ....",
  },
  {
    icon: <Icons.StartingDaemon className="h-[135px] w-[135px]" />,
    progress: 40,
    status: "Starting Daemon",
    subStatus: "Preparing background services ....",
  },
  {
    icon: <Icons.ConnectingNetwork className="h-[130px] w-[240px]" />,
    progress: 60,
    status: "Connecting to Network",
    subStatus: "Establishing peer connections ....",
  },
  {
    icon: <Icons.CentralizedDataBase className="h-[170px] w-[120px]" />,
    progress: 80,
    status: "Initializing Decentralized Database",
    subStatus: "Setting up database service ....",
  },
  {
    icon: <Icons.SyncData className="h-[170px] w-[170px]" />,
    progress: 94,
    status: "Syncing Data",
    subStatus: "Setting up database service ....",
  },
];
