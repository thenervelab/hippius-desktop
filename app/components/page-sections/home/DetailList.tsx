"use client";

import { useState, useEffect, ReactNode, useMemo } from "react";
import { Icons } from "@/components/ui";
import DetailsCard from "./DetailsCard";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import useMarketplaceCredits from "@/app/lib/hooks/api/useMarketplaceCredits";
import { invoke } from "@tauri-apps/api/core";
import { Account } from "@/lib/types";
import { useRemoteStorageStats } from "@/app/lib/hooks/api/useRemoteStorageStats";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { formatCreditBalance } from "@/app/lib/utils/formatters/formatCredits";
import { toast } from "sonner";
import {
  calculateStorageCost,
  DEFAULT_TIMING_OPTION,
} from "@/lib/utils/storageCostUtils";
import pricingJson from "@/app/utils/data/pricing-cfg.json";

export default function DetailList() {
  const [isRefreshingCredits, setIsRefreshingCredits] = useState(false);

  const {
    data: credits,
    isLoading: isCreditsLoading,
    error: creditsError,
    refetch: refetchCredits,
  } = useUserCredits();

  const {
    data: remoteStats,
    isLoading: isRemoteStatsLoading,
  } = useRemoteStorageStats();

  // Fetch marketplace credits for Total Credits Used (all-time)
  const { data: marketplaceCredits, isLoading: isLoadingMarketplaceCredits } =
    useMarketplaceCredits();

  // Transform marketplace credits to the format expected by the chart
  const [transformedCreditsData, setTransformedCreditsData] = useState<Account[]>([]);
  useEffect(() => {
    if (!marketplaceCredits?.length) {
      setTransformedCreditsData([]);
      return;
    }
    invoke<Account[]>("transform_marketplace_credits", { credits: marketplaceCredits })
      .then(setTransformedCreditsData)
      .catch(() => setTransformedCreditsData([]));
  }, [marketplaceCredits]);

  const handleRefreshCredits = async () => {
    try {
      setIsRefreshingCredits(true);
      await refetchCredits();
      toast.success("Credits refreshed successfully!");
    } catch (error) {
      console.error("Failed to refresh credits:", error);
      toast.error("Failed to refresh credits");
    } finally {
      setIsRefreshingCredits(false);
    }
  };

  const getCreditsValue = () => {
    if (isCreditsLoading) return "Loading...";
    if (credits !== undefined) return formatCreditBalance(credits);
    if (creditsError) return "0";
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

  const getCreditsSubtitle = (): ReactNode => {
    if (credits !== undefined) {
      const numCredits = getCreditsAsNumber(credits);
      if (numCredits > 0) {
        const storageGB = calculateStorageFromCredits(numCredits);
        return formatStorageDisplay(storageGB, numCredits);
      }
    }
    return "≈0 GB/mo Storage";
  };

  const getTotalFiles = () => {
    if (isRemoteStatsLoading) return "Loading...";
    return remoteStats?.totalFiles ?? 0;
  };

  // Calculate all-time Total Credits Used from marketplace credits
  // Using the SAME LOGIC as CreditUsageTrends component
  // Get the LAST point from ALL DATA (complete dataset, not filtered by time range)
  const getTotalCreditsUsed = useMemo(() => {
    if (isLoadingMarketplaceCredits) return "Loading...";
    if (!transformedCreditsData || transformedCreditsData.length === 0) return "0";
    // This contains the all-time cumulative total
    const lastPoint = transformedCreditsData[transformedCreditsData.length - 1];
    const allTimeTotal = Number(lastPoint.total_balance) / Math.pow(10, 18);
    return allTimeTotal.toFixed(6);
  }, [transformedCreditsData, isLoadingMarketplaceCredits]);

  const getTotalStorageUsed = useMemo(() => {
    if (isRemoteStatsLoading) return "Loading...";
    if (!remoteStats?.totalBytes) return "0 B";
    return formatBytes(remoteStats.totalBytes, 2);
  }, [remoteStats, isRemoteStatsLoading]);



  const detailCards = [
    {
      id: "available-credits",
      icon: Icons.WalletAdd,
      title: "Available Credits",
      value: getCreditsValue(),
      subtitle: getCreditsSubtitle(),
      showRefresh: true,
      showAddCreditsButton: (!isCreditsLoading && (credits === undefined || getCreditsAsNumber(credits) === 0)) ? true : false,
      onRefresh: handleRefreshCredits,
      isLoading: isRefreshingCredits,
      info: "Credits available for storage usage. Each credit equals $1 and can be used to pay for IPFS storage costs.",
    },
    {
      id: "total-files",
      icon: Icons.Document,
      title: "Total Files",
      value: getTotalFiles(),
      showRefresh: false,
      isLoading: isRemoteStatsLoading,
      info: "Total number of files stored on the Hippius network.",
    },
    {
      id: "total-credits-used",
      icon: Icons.Tag2,
      title: "Total Credit Used",
      value: getTotalCreditsUsed,
      showRefresh: false,
      isLoading: isLoadingMarketplaceCredits,
      info: "All time total credits consumed for storage services since account creation.",
    },
    {
      id: "total-storage-used",
      icon: Icons.Chart,
      title: "Total Storage Used",
      value: getTotalStorageUsed,
      showRefresh: false,
      isLoading: isRemoteStatsLoading,
      info: "Total storage space used on the Hippius network.",
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
          showAddCreditsButton={card.showAddCreditsButton}
          info={card.info}
        />
      ))}
    </div>
  );
}
