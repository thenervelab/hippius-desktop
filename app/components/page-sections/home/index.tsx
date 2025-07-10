import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import DetailList from "./DetailList";

import CreditUsageTrends from "./credit-usage-trends";
import useMarketplaceCredits from "@/app/lib/hooks/api/useMarketplaceCredits";
import { transformMarketplaceCreditsToAccounts } from "@/app/lib/utils/transformMarketplaceCredits";
import { IPFS_NODE_CONFIG } from "@/app/lib/config";
import { useIpfsBandwidth } from "@/app/lib/hooks/api/useIpfsBandwidth";
import StorageUsageTrends from "./storage-usage-trends";
import useFiles from "@/app/lib/hooks/api/useFilesSize";
import { transformFilesToStorageData } from "@/app/lib/utils/transformFiles";

type IpfsInfo = {
  ID?: string;
  Addresses?: string[];
  AgentVersion?: string;
  ProtocolVersion?: string;
  // [key: string]: any;
};

function useIpfsInfo() {
  const [ipfsInfo, setIpfsInfo] = useState<IpfsInfo | null>(null);

  useEffect(() => {
    fetch(`${IPFS_NODE_CONFIG.baseURL}/api/v0/id`, { method: "POST" })
      .then((res) => res.json())
      .then(setIpfsInfo)
      .catch(() => setIpfsInfo(null));
  }, []);

  return ipfsInfo;
}

const Home: React.FC = () => {
  const { polkadotAddress, mnemonic } = useWalletAuth();
  const ipfsInfo = useIpfsInfo();
  const { download, upload } = useIpfsBandwidth(1000);

  // Fetch marketplace credits with a higher limit to get good chart data
  const { data: marketplaceCredits, isLoading: isLoadingCredits } =
    useMarketplaceCredits({ limit: 1000 });

  // Fetch files data for storage usage chart
  const { data: filesData, isLoading: isLoadingFiles } = useFiles({
    limit: 1000,
  });

  // Transform marketplace credits to the format expected by the chart
  const transformedCreditsData = transformMarketplaceCreditsToAccounts(
    marketplaceCredits || []
  );

  // Transform files data to the format expected by the storage chart
  const transformedFilesData = transformFilesToStorageData(filesData || []);
  console.log(transformedFilesData, "transformedFilesData");

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
      <DetailList ipfsInfo={ipfsInfo} upload={upload} download={download} />

      <div className="flex gap-4 mt-6 w-full h-full">
        <CreditUsageTrends
          chartData={transformedCreditsData}
          isLoading={isLoadingCredits}
        />
        <StorageUsageTrends
          chartData={transformedFilesData}
          isLoading={isLoadingFiles}
        />
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
