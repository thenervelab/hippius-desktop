"use client";

import { useState, useEffect, ReactNode, useMemo } from "react";
import { Icons } from "@/components/ui";
import DetailsCard from "./DetailsCard";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import { useDriveCreditsTotal } from "@/app/lib/hooks/api/useDriveCreditsTotal";
import { invoke } from "@tauri-apps/api/core";
import { useDriveStorageStats } from "@/app/lib/hooks/api/useDriveStorageStats";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { toast } from "sonner";

export default function DetailList() {
  const [isRefreshingCredits, setIsRefreshingCredits] = useState(false);

  const {
    data: credits,
    isLoading: isCreditsLoading,
    error: creditsError,
    refetch: refetchCredits,
  } = useUserCredits();

  // Single drive-scoped query feeds both the storage and file-count cards.
  // Loading state is shared so the two cards never flash inconsistent values.
  const {
    data: driveStats,
    isLoading: isDriveStatsLoading,
  } = useDriveStorageStats();
  const remoteStats = driveStats;
  const isRemoteStatsLoading = isDriveStatsLoading;
  const fileCount = driveStats?.fileCount;
  const isFileCountLoading = isDriveStatsLoading;

  // Drive-scoped credit total: same indexer endpoint backs the Credit
  // Usage chart, so this tile and the chart can never disagree about
  // what counts as "drive credit usage".
  const {
    data: driveCreditsTotal,
    isLoading: isLoadingDriveCreditsTotal,
  } = useDriveCreditsTotal();

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
    if (credits !== undefined) return credits.hip;
    return "--";
  };

  // Storage subtitle from Rust (replaces duplicated binary search).
  // TODO(#2): once the capacity binary search accepts a planck string,
  // drop the f64 conversion here and pass `credits.planck.toString()`.
  const [storageSubtitle, setStorageSubtitle] = useState("≈0 GB/mo Storage");
  useEffect(() => {
    if (credits === undefined || credits.planck === BigInt(0)) return;
    const numCredits = Number(credits.hip);
    if (!Number.isFinite(numCredits) || numCredits <= 0) return;
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

  // Drive-scoped all-time credit usage. Same indexer endpoint as the
  // Credit Usage chart, so the tile and the chart agree by construction.
  const getTotalCreditsUsed = useMemo(() => {
    if (isLoadingDriveCreditsTotal) return "Loading...";
    if (driveCreditsTotal === undefined || driveCreditsTotal === null) return "0";
    return driveCreditsTotal.toFixed(6);
  }, [driveCreditsTotal, isLoadingDriveCreditsTotal]);

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
      showAddCreditsButton: !isCreditsLoading && (credits === undefined || credits.planck === BigInt(0)),
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
      isLoading: isLoadingDriveCreditsTotal,
      info: "All-time credits consumed for drive storage. Matches the scope shown in the Credit Usage chart below.",
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
