import { useEffect, useState } from "react";
import { useSetAtom } from "jotai";
import {
  activeSubMenuItemAtom,
  isViewingRecentFilesAtom,
} from "@/app/components/sidebar/sideBarAtoms";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import DetailList from "./DetailList";
import CreditUsageTrends from "./credit-usage-trends";
import StorageUsageTrends from "./storage-usage-trends";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";
import { Account } from "@/lib/types";
import useMarketplaceCredits from "@/app/lib/hooks/api/useMarketplaceCredits";
import { DRIVE_SCOPED_CREDITS_ENABLED } from "@/app/lib/featureFlags";
import Ipfs from "@/app/components/page-sections/files/FilesContainer";
import { IS_SYNC_PAUSED, SyncPausedAlert } from "@/components/ui";

const Home: React.FC = () => {
  const setActiveSubMenuItem = useSetAtom(activeSubMenuItemAtom);
  const setIsViewingRecentFiles = useSetAtom(isViewingRecentFilesAtom);
  const { polkadotAddress } = useWalletAuth();

  // Wallet-wide credit chart input. Only used while the gate is off;
  // the drive-scoped path is fully self-fetching and ignores both
  // chartData and isLoading.
  const { data: marketplaceCredits, isLoading: isLoadingCredits } =
    useMarketplaceCredits(undefined, { enabled: !DRIVE_SCOPED_CREDITS_ENABLED });
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

  useEffect(() => {
    setActiveSubMenuItem("");
    setIsViewingRecentFiles(true);

    return () => {
      setIsViewingRecentFiles(false);
    };
  }, [setActiveSubMenuItem, setIsViewingRecentFiles]);

  return (
    <>
      <DashboardTitleWrapper
        mainText="Welcome to Hippius"
        subText="Secure & Encrypted Storage with Easy Sync and Real-Time Tracking"
      >
        <div className="mt-6">
          {IS_SYNC_PAUSED && (
            <div className="mb-4">
              <SyncPausedAlert variant="inline" />
            </div>
          )}

          <DetailList />

          {/*
            Storage chart is drive-scoped; credit chart is gated. While
            DRIVE_SCOPED_CREDITS_ENABLED is false the credit chart shows
            wallet-wide marketplace data + a tooltip explaining the
            scope difference vs. the drive-only storage tile. Flipping
            the flag swaps it to the matching drive-only series.
          */}
          <div className="gap-4 mt-6 w-full h-full grid grid-cols-1 @xl:grid-cols-2">
            {DRIVE_SCOPED_CREDITS_ENABLED ? (
              <CreditUsageTrends accountId={polkadotAddress ?? undefined} />
            ) : (
              <CreditUsageTrends
                chartData={transformedCreditsData}
                isLoading={isLoadingCredits}
              />
            )}
            <StorageUsageTrends accountId={polkadotAddress ?? undefined} />
          </div>
          <div id="recent-files">
            <Ipfs isRecentFiles />
          </div>
        </div>
      </DashboardTitleWrapper>
    </>
  );
};

export default Home;
