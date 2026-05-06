"use client";

import { useState, useEffect, ReactNode, useMemo } from "react";
import { Icons } from "@/components/ui";
import DetailsCard from "./DetailsCard";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import { useDriveCreditsTotal } from "@/app/lib/hooks/api/useDriveCreditsTotal";
import useMarketplaceCredits from "@/app/lib/hooks/api/useMarketplaceCredits";
import { Account } from "@/lib/types";
import { invoke } from "@tauri-apps/api/core";
import { useDriveStorageStats } from "@/app/lib/hooks/api/useDriveStorageStats";
import { DRIVE_SCOPED_CREDITS_ENABLED } from "@/app/lib/featureFlags";
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

  // Total Credit Used data sources — picked by the same gate that
  // drives the chart so the tile and the chart always agree on scope.
  // Drive-scoped path: matches the chart's drive-only IPC.
  // Wallet-wide path: marketplace credits cumulative, matches the
  // legacy chart and the InfoTooltip's "drive + S3" wording.
  const {
    data: driveCreditsTotal,
    isLoading: isLoadingDriveCreditsTotal,
  } = useDriveCreditsTotal();
  const {
    data: marketplaceCredits,
    isLoading: isLoadingMarketplaceCredits,
  } = useMarketplaceCredits(undefined, { enabled: !DRIVE_SCOPED_CREDITS_ENABLED });
  const [transformedCreditsData, setTransformedCreditsData] = useState<Account[]>([]);
  useEffect(() => {
    if (DRIVE_SCOPED_CREDITS_ENABLED) return;
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

  // All-time credit usage — wallet-wide while the gate is off, drive-
  // scoped when on. The wallet-wide total is the last cumulative
  // point of the marketplace-credits transform, mirroring the legacy
  // implementation byte-for-byte so users see no value drift across
  // a release that only flips the gate.
  const isLoadingTotalCreditsUsed = DRIVE_SCOPED_CREDITS_ENABLED
    ? isLoadingDriveCreditsTotal
    : isLoadingMarketplaceCredits;
  const getTotalCreditsUsed = useMemo(() => {
    if (DRIVE_SCOPED_CREDITS_ENABLED) {
      if (isLoadingDriveCreditsTotal) return "Loading...";
      if (driveCreditsTotal === undefined || driveCreditsTotal === null) return "0";
      return driveCreditsTotal.toFixed(6);
    }
    if (isLoadingMarketplaceCredits) return "Loading...";
    if (!transformedCreditsData.length) return "0";
    const lastPoint = transformedCreditsData[transformedCreditsData.length - 1];
    const allTimeTotal = Number(lastPoint.total_balance) / Math.pow(10, 18);
    return allTimeTotal.toFixed(6);
  }, [
    driveCreditsTotal,
    isLoadingDriveCreditsTotal,
    transformedCreditsData,
    isLoadingMarketplaceCredits,
  ]);

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
      isLoading: isLoadingTotalCreditsUsed,
      info: DRIVE_SCOPED_CREDITS_ENABLED
        ? "All-time credits consumed for drive storage. Matches the scope shown in the Credit Usage chart below."
        : "Credits consumption includes both drive + S3 storage.",
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
