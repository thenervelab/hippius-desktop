"use client";

import { useState, useEffect, ReactNode, useMemo } from "react";
import { Icons } from "@/components/ui";
import DetailsCard from "./DetailsCard";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
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
      info: "Total number of files in your Drive.",
    },
    {
      id: "total-storage-used",
      icon: Icons.Chart,
      title: "Total Storage Used",
      value: getTotalStorageUsed,
      showRefresh: false,
      isLoading: isRemoteStatsLoading,
      info: "Total storage used by your Drives",
    },
  ];

  return (
    <div className="grid grid-cols-1 @md:grid-cols-3 gap-4">
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
