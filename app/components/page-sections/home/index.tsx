import { useEffect, useState, useCallback } from "react";

import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import DetailList from "./DetailList";

import CreditUsageTrends from "./credit-usage-trends";
import useMarketplaceCredits from "@/app/lib/hooks/api/useMarketplaceCredits";
import { transformMarketplaceCreditsToAccounts } from "@/app/lib/utils/transformMarketplaceCredits";
import { IPFS_NODE_CONFIG } from "@/app/lib/config";
import { useIpfsBandwidth } from "@/app/lib/hooks/api/useIpfsBandwidth";
import StorageUsageTrends from "./storage-usage-trends";
import useFiles from "@/app/lib/hooks/api/useFilesSize";
import { transformFilesToStorageData } from "@/app/lib/utils/transformFiles";
import Ipfs from "@/components/page-sections/files/ipfs";
import { getPrivateSyncPath } from "@/app/lib/utils/syncPathUtils";
import { Icons } from "@/components/ui";

type IpfsInfo = {
  ID?: string;
  Addresses?: string[];
  AgentVersion?: string;
  ProtocolVersion?: string;
};

function useIpfsInfo() {
  const [ipfsInfo, setIpfsInfo] = useState<IpfsInfo | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const MAX_RETRIES = 3;

  const fetchIpfsInfo = useCallback(async () => {
    try {
      const response = await tauriFetch(
        `${IPFS_NODE_CONFIG.baseURL}/api/v0/id`,
        {
          method: "POST",
        }
      );

      if (response.ok) {
        const data = await response.json();
        setIpfsInfo(data);
        setIsRetrying(false);
      } else {
        console.warn(`Error fetching IPFS info: HTTP ${response.status}`);
        throw new Error(`HTTP error ${response.status}`);
      }
    } catch (error) {
      console.warn("Failed to fetch IPFS info:", error);
      try {
        const ipfsData = await invoke<IpfsInfo>("get_ipfs_node_info");
        setIpfsInfo(ipfsData);
        setIsRetrying(false);
      } catch (invokeError) {
        console.warn("Tauri invoke also failed:", invokeError);

        // Implement retry logic
        if (retryCount < MAX_RETRIES) {
          setIsRetrying(true);
          setRetryCount((prev) => prev + 1);
        } else {
          setIpfsInfo({
            ID: "Not available",
            AgentVersion: "Connection failed",
            ProtocolVersion: "Connection failed",
            Addresses: [],
          });
          setIsRetrying(false);
        }
      }
    }
  }, [retryCount, MAX_RETRIES]);

  useEffect(() => {
    fetchIpfsInfo();
  }, [fetchIpfsInfo]);

  useEffect(() => {
    if (isRetrying) {
      const timer = setTimeout(() => {
        console.log(`Retry attempt ${retryCount} for IPFS info`);
        fetchIpfsInfo();
      }, 2000 * retryCount);

      return () => clearTimeout(timer);
    }
  }, [isRetrying, retryCount, fetchIpfsInfo]);

  return ipfsInfo;
}

const Home: React.FC = () => {
  const ipfsInfo = useIpfsInfo();
  const { download, upload } = useIpfsBandwidth(1000);

  const [isSyncPathConfigured, setIsSyncPathConfigured] = useState<
    boolean | null
  >(null);
  const [isCheckingSyncPath, setIsCheckingSyncPath] = useState(true);

  // Fetch marketplace credits with a higher limit to get good chart data
  const { data: marketplaceCredits, isLoading: isLoadingCredits } =
    useMarketplaceCredits();

  // Fetch files data for storage usage chart
  const { data: filesData, isLoading: isLoadingFiles } = useFiles();

  // Transform marketplace credits to the format expected by the chart
  const transformedCreditsData = transformMarketplaceCreditsToAccounts(
    marketplaceCredits || []
  );

  // Transform files data to the format expected by the storage chart
  const transformedFilesData = transformFilesToStorageData(filesData || []);

  useEffect(() => {
    const checkSyncPath = async () => {
      try {
        setIsCheckingSyncPath(true);
        const privateSyncPath = await getPrivateSyncPath();
        setIsSyncPathConfigured(!!privateSyncPath);
      } catch (error) {
        console.error("Failed to check sync path:", error);
        setIsSyncPathConfigured(false);
      } finally {
        setIsCheckingSyncPath(false);
      }
    };

    checkSyncPath();
  }, []);

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

      <div className="gap-4 mt-6 w-full h-full grid grid-cols-1 md:grid-cols-2">
        <CreditUsageTrends
          chartData={transformedCreditsData}
          isLoading={isLoadingCredits}
        />
        <StorageUsageTrends
          chartData={transformedFilesData}
          isLoading={isLoadingFiles}
        />
      </div>
      {isCheckingSyncPath ? (
        <div className="flex items-center justify-center w-full h-full">
          <Icons.Loader className="size-8 animate-spin text-primary-60" />
        </div>
      ) : (
        isSyncPathConfigured && <Ipfs isRecentFiles />
      )}
    </div>
  );
};

export default Home;
