"use client";

import { Icons } from "@/components/ui";
import DetailsCard from "./DetailsCard";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import { formatCreditBalance } from "@/app/lib/utils/formatters/formatCredits";
import { toast } from "sonner";
import {
  calculateStorageCost,
  DEFAULT_TIMING_OPTION,
} from "@/lib/utils/storageCostUtils";
import pricingJson from "@/app/utils/data/pricing-cfg.json";
import { useUserIpfsFiles } from "@/app/lib/hooks/use-user-ipfs-files";
import { formatBytesFromBigInt } from "@/lib/utils";

export default function DetailList() {
  const {
    data: credits,
    isLoading: isCreditsLoading,
    error: creditsError,
    refetch: refetchCredits,
  } = useUserCredits();

  const {
    data: filesData,
    isLoading: isFilesLoading,
    error: filesError,
  } = useUserIpfsFiles();

  const handleRefreshCredits = async () => {
    try {
      await refetchCredits();
      toast.success("Credits refreshed successfully!");
    } catch (error) {
      console.error("Failed to refresh credits:", error);
      toast.error("Failed to refresh credits");
    }
  };

  const getCreditsValue = () => {
    if (isCreditsLoading) return "Loading...";
    if (creditsError) return "Error";
    if (credits !== undefined) return formatCreditBalance(credits);
    return "--";
  };

  // Convert credits BigInt to number for calculations
  const getCreditsAsNumber = (credits: bigint | null): number => {
    if (credits === null) return 0;

    const divisor = BigInt(10) ** BigInt(18);
    const integerPart = Number(credits / divisor);
    const fractionalPart = Number(credits % divisor);

    return integerPart + fractionalPart / Math.pow(10, 18);
  };

  // Calculate storage capacity based on credits (1 credit = $1)
  const calculateStorageFromCredits = (creditsAmount: number): number => {
    // Binary search to find max GB that can be stored with given credits
    let low = 0;
    let high = 1000000000; // Start with reasonable upper bound
    let maxGB = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const monthlyCost = calculateStorageCost({
        storageTypeData: pricingJson.storage.ipfs,
        perBlockTime: pricingJson.per_block_time_s,
        timeframe: DEFAULT_TIMING_OPTION,
        numOfGb: mid,
      });

      if (monthlyCost <= creditsAmount) {
        maxGB = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return maxGB;
  };

  // Format storage display (GB for small amounts, TB for larger) - matching PlansPage style
  const formatStorageDisplay = (storageGB: number, credits: number): string => {
    const gb = Math.floor(storageGB);
    const tb = storageGB / 1000;
    const tbStr = tb >= 10 ? Math.floor(tb).toLocaleString() : tb.toFixed(2);

    if (credits <= 3) {
      return `≈${gb.toLocaleString()} GB/mo Storage`;
    }
    return `≈${tbStr} TB/mo Storage`;
  };

  const getCreditsSubtitle = () => {
    if (credits !== undefined) {
      const numCredits = getCreditsAsNumber(credits);
      if (numCredits > 0) {
        const storageGB = calculateStorageFromCredits(numCredits);
        return formatStorageDisplay(storageGB, numCredits);
      }
    }
    return "≈0 GB/mo Storage";
  };

  // Helper functions for file data
  const getTotalFiles = () => {
    if (isFilesLoading) return "Loading...";
    if (filesError) return "Error";
    return filesData?.files.length || 0;
  };

  const getPrivateFiles = () => {
    if (isFilesLoading) return "Loading...";
    if (filesError) return "Error";
    return filesData?.files.filter(f => f.type?.toLowerCase() === "private").length || 0;
  };

  const getPublicFiles = () => {
    if (isFilesLoading) return "Loading...";
    if (filesError) return "Error";
    return filesData?.files.filter(f => f.type?.toLowerCase() === "public").length || 0;
  };

  // Calculate total available storage from credits
  const getTotalAvailableStorage = (): bigint => {
    if (credits !== undefined) {
      const numCredits = getCreditsAsNumber(credits);
      if (numCredits > 0) {
        const storageGB = calculateStorageFromCredits(numCredits);
        // Convert GB to bytes (1 GB = 1000^3 bytes)
        return BigInt(storageGB) * BigInt(1000) * BigInt(1000) * BigInt(1000);
      }
    }
    return BigInt(0);
  };

  // Calculate usage percentage
  const getUsagePercentage = (usedStorage: bigint, totalAvailable: bigint): number => {
    if (totalAvailable === BigInt(0)) return 0;
    const percentage = Number((usedStorage * BigInt(100)) / totalAvailable);
    return Math.min(percentage, 100); // Cap at 100%
  };

  // Get storage usage display for file cards
  const getStorageUsageDisplay = (usedStorage: bigint) => {
    const totalAvailable = getTotalAvailableStorage();
    const totalStorage = totalAvailable + usedStorage; // Total = Available + Used
    const usedFormatted = formatBytesFromBigInt(usedStorage);
    const totalFormatted = formatBytesFromBigInt(totalStorage);
    const percentage = getUsagePercentage(usedStorage, totalStorage);

    return {
      display: `${usedFormatted} of ${totalFormatted}`,
      percentage: percentage,
      used: usedFormatted,
      total: totalFormatted
    };
  };

  const detailCards = [
    {
      id: "available-credits",
      icon: Icons.WalletAdd,
      title: "Available Credits",
      value: getCreditsValue(),
      subtitle: getCreditsSubtitle(),
      showRefresh: true,
      onRefresh: handleRefreshCredits,
      isLoading: isCreditsLoading,
    },
    {
      id: "total-files",
      icon: Icons.Document,
      title: "Total Files",
      value: getTotalFiles(),
      showRefresh: false,
      isLoading: isFilesLoading,
      storageUsage: filesData
        ? getStorageUsageDisplay(filesData.privateStorageSize + filesData.publicStorageSize)
        : null,
    },
    {
      id: "private-files",
      icon: Icons.ShieldSecurity,
      title: "Private Files",
      value: getPrivateFiles(),
      showRefresh: false,
      isLoading: isFilesLoading,
      storageUsage: filesData
        ? getStorageUsageDisplay(filesData.privateStorageSize)
        : null,
    },
    {
      id: "public-files",
      icon: Icons.FolderOpen,
      title: "Public Files",
      value: getPublicFiles(),
      showRefresh: false,
      isLoading: isFilesLoading,
      storageUsage: filesData
        ? getStorageUsageDisplay(filesData.publicStorageSize)
        : null,
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      {detailCards.map((card) => (
        <DetailsCard
          key={card.id}
          icon={card.icon}
          title={card.title}
          value={card.value}
          subtitle={card.subtitle}
          showRefresh={card.showRefresh}
          onRefresh={card.onRefresh}
          isLoading={card.isLoading}
          storageUsage={card.storageUsage}
        />
      ))}
    </div>
  );
}
