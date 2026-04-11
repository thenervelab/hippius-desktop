"use client";

import { useState, useEffect, ReactNode, useMemo } from "react";
import { Icons } from "@/components/ui";
import DetailsCard from "./DetailsCard";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import useMarketplaceCredits from "@/app/lib/hooks/api/useMarketplaceCredits";
import { invoke } from "@tauri-apps/api/core";
import { Account } from "@/lib/types";
import { useRemoteStorageStats } from "@/app/lib/hooks/api/useRemoteStorageStats";
import useFilesCount from "@/app/lib/hooks/api/useFilesCount";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { formatCreditBalance } from "@/app/lib/utils/formatters/formatCredits";
import { toast } from "sonner";

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

  const {
    data: fileCount,
    isLoading: isFileCountLoading,
  } = useFilesCount();

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
    if (creditsError) return "Error";
    if (credits !== undefined) return formatCreditBalance(credits);
    return "--";
  };

  // Storage subtitle from Rust (replaces duplicated binary search)
  const [storageSubtitle, setStorageSubtitle] = useState("≈0 GB/mo Storage");
  useEffect(() => {
    if (credits === undefined || credits === BigInt(0)) return;
    const numCredits = Number(credits / BigInt(10 ** 18)) + Number(credits % BigInt(10 ** 18)) / 1e18;
    if (numCredits <= 0) return;
    invoke<Array<{ storageDisplay: string }>>("calculate_storage_capacity", { creditsPerMonth: [numCredits] })
      .then((results) => {
        if (results[0]) setStorageSubtitle(results[0].storageDisplay);
      })
      .catch(() => {});
  }, [credits]);

  const getCreditsSubtitle = (): ReactNode => storageSubtitle;

  const getTotalFiles = () => {
    if (isFileCountLoading) return "Loading...";
    return fileCount ?? 0;
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
      showAddCreditsButton: !isCreditsLoading && (credits === undefined || credits === BigInt(0)),
      onRefresh: handleRefreshCredits,
      isLoading: isRefreshingCredits,
      info: "Credits available for storage usage. Each credit equals $1 and can be used to pay for arion storage costs.",
    },
    {
      id: "total-files",
      icon: Icons.Document,
      title: "Total Files",
      value: getTotalFiles(),
      showRefresh: false,
      isLoading: isFileCountLoading,
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
    <div className="grid grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-4 gap-4">
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
