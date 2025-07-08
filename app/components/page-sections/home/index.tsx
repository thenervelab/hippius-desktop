import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import DetailsCard from "./DetailsCard";
import { Icons } from "../../ui";

import CreditUsageTrends from "./credit-usage-trends";
import useMarketplaceCredits from "@/app/lib/hooks/api/useMarketplaceCredits";
import { transformMarketplaceCreditsToAccounts } from "@/app/lib/utils/transformMarketplaceCredits";

// import IpfsTest from "@/components/upload-download";

type IpfsInfo = {
  ID?: string;
  Addresses?: string[];
  AgentVersion?: string;
  ProtocolVersion?: string;
  // [key: string]: any;
};

function shortId(id?: string) {
  if (!id || id.length <= 8) return id || "";
  return `${id.slice(0, 3)}...${id.slice(-3)}`;
}

function useIpfsInfo() {
  const [ipfsInfo, setIpfsInfo] = useState<IpfsInfo | null>(null);

  useEffect(() => {
    fetch("http://127.0.0.1:5001/api/v0/id", { method: "POST" })
      .then((res) => res.json())
      .then(setIpfsInfo)
      .catch(() => setIpfsInfo(null));
  }, []);

  return ipfsInfo;
}
const Home: React.FC = () => {
  const { polkadotAddress, mnemonic } = useWalletAuth();
  const ipfsInfo = useIpfsInfo();

  // Fetch marketplace credits with a higher limit to get good chart data
  const { data: marketplaceCredits, isLoading: isLoadingCredits } =
    useMarketplaceCredits({ limit: 100 });

  // Transform marketplace credits to the format expected by the chart
  const transformedCreditsData = transformMarketplaceCreditsToAccounts(
    marketplaceCredits || []
  );
  console.log(transformedCreditsData, "transformedCreditsData");

  useEffect(() => {
    if (polkadotAddress) {
      invoke("start_user_profile_sync_tauri", { accountId: polkadotAddress });
      invoke("start_folder_sync_tauri", {
        accountId: polkadotAddress,
        seedPhrase: mnemonic,
      });
    }
  }, [polkadotAddress, mnemonic]);

  return (
    <div className="flex flex-col mt-6">
      <section className="mb-6">
        <h1 className="text-2xl font-semibold mb-1">Welcome to Hippius</h1>
        <p className="text-grey-50 text-base">
          Monitor your IPFS node status and performance
        </p>
      </section>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <DetailsCard
          icon={Icons.WifiSquare}
          title="Network Connections"
          value={ipfsInfo?.Addresses?.length ?? "--"}
          subtitle="Active Network Connections"
        />

        <DetailsCard
          icon={Icons.ShieldTick}
          title="Node Status"
          value="--"
          peerId={`${ipfsInfo?.ID ? shortId(ipfsInfo.ID) : "Loading..."}`}
          showStatus={true}
          showInfo={false}
        />

        <DetailsCard
          icon={Icons.DocumentUpload}
          title="Upload Speed"
          value="--"
          speed="-"
          isIncrease
        />

        <DetailsCard
          icon={Icons.DocumentDownload}
          title="Download Speed"
          value="--"
          speed="-"
          isIncrease={false}
        />
      </div>
      <div className="flex gap-4 mt-6 w-full h-full">
        <CreditUsageTrends
          chartData={transformedCreditsData}
          isLoading={isLoadingCredits}
        />
        <div className="w-full"></div>
      </div>
      {/* IPFS Upload/Download Test */}
      {/* <section>
          <h2 className="text-xl font-semibold mb-2">
            IPFS Encrypted Upload/Download Test
          </h2>
          <IpfsTest />
        </section> */}
    </div>
  );
};

export default Home;
