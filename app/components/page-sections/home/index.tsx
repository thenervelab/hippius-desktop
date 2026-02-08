import { useEffect, useState } from "react";
import { useSetAtom } from "jotai";
import {
  activeSubMenuItemAtom,
  isViewingRecentFilesAtom,
} from "@/app/components/sidebar/sideBarAtoms";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import DetailList from "./DetailList";
import CreditUsageTrends from "./credit-usage-trends";
import useMarketplaceCredits from "@/app/lib/hooks/api/useMarketplaceCredits";
import { transformMarketplaceCreditsToAccounts } from "@/app/lib/utils/transformMarketplaceCredits";
import StorageUsageTrends from "./storage-usage-trends";
import useFiles from "@/app/lib/hooks/api/useFilesSize";
import Ipfs from "@/app/components/page-sections/files/FilesContainer";
import { Icons, IS_SYNC_PAUSED, SyncPausedAlert } from "@/components/ui";
import { useStagedChanges } from "@/lib/hooks/useStagedChanges";
import StagedChangesDialog from "@/app/components/page-sections/files/StagedChangesDialog";
import { cn } from "@/lib/utils";
import type { ConflictResolution } from "@/lib/types/syncTypes";
import { toast } from "sonner";

const Home: React.FC = () => {
  const setActiveSubMenuItem = useSetAtom(activeSubMenuItemAtom);
  const setIsViewingRecentFiles = useSetAtom(isViewingRecentFilesAtom);

  const [isCheckingSyncPath, setIsCheckingSyncPath] = useState(true);
  const [isReviewOpen, setIsReviewOpen] = useState(false);

  const {
    stagedChanges,
    isLoading: isStaging,
    isSyncing: isReviewSyncing,
    fetchStagedChanges,
    syncWithResolutions,
    cancelReview,
  } = useStagedChanges();

  const handleReviewChanges = async () => {
    const changes = await fetchStagedChanges();
    if (changes) {
      setIsReviewOpen(true);
    } else {
      toast.error("Failed to stage changes. Is the drive initialized?");
    }
  };

  // Fetch marketplace credits with a higher limit to get good chart data
  const { data: marketplaceCredits, isLoading: isLoadingCredits } =
    useMarketplaceCredits();

  // Fetch files data for storage usage chart
  const { data: filesData, isLoading: isLoadingFiles } = useFiles();

  // Transform marketplace credits to the format expected by the chart
  const transformedCreditsData = transformMarketplaceCreditsToAccounts(
    marketplaceCredits || []
  );

  useEffect(() => {
    const checkSyncPath = async () => {
      try {
        setIsCheckingSyncPath(true);
      } catch (error) {
        console.error("Failed to check sync path:", error);
      } finally {
        setIsCheckingSyncPath(false);
      }
    };

    checkSyncPath();
  }, []);

  // Set active submenu item to "Private" when showing recent files
  useEffect(() => {
    if (!isCheckingSyncPath) {
      setActiveSubMenuItem("Private");
      setIsViewingRecentFiles(true);
    }

    // Clean up when component unmounts
    return () => {
      setIsViewingRecentFiles(false);
    };
  }, [isCheckingSyncPath, setActiveSubMenuItem, setIsViewingRecentFiles]);

  return (
    <>
      <DashboardTitleWrapper
        mainText="Welcome to Hippius"
        subText="Secure & Encrypted Storage with Easy Sync and Real-Time Tracking"
      >
        <div className="mt-6">
          {/* <NebulaTest /> */}
          {/* Stats Cards */}
          {/* Sync Paused Alert */}
          {IS_SYNC_PAUSED && (
            <div className="mb-4">
              <SyncPausedAlert variant="inline" />
            </div>
          )}

          {/* Review Changes button */}
          {!IS_SYNC_PAUSED && (
            <div className="flex justify-end mb-4">
              <button
                onClick={handleReviewChanges}
                disabled={isStaging}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 rounded bg-grey-90 border border-grey-80 text-grey-10 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50",
                  isStaging
                    ? "opacity-50 cursor-not-allowed"
                    : "hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white"
                )}
              >
                {isStaging ? (
                  <Icons.Loader className="size-4 animate-spin" />
                ) : (
                  <Icons.Document className="size-4" />
                )}
                Review Changes
              </button>
            </div>
          )}

          <DetailList />

          <div className="gap-4 mt-6 w-full h-full grid grid-cols-1 md:grid-cols-2">
            <CreditUsageTrends
              chartData={transformedCreditsData}
              isLoading={isLoadingCredits}
            />
            <StorageUsageTrends
              chartData={filesData || []}
              isLoading={isLoadingFiles}
            />
          </div>
          {isCheckingSyncPath ? (
            <div className="flex items-center justify-center w-full h-full">
              <Icons.Loader className="size-8 animate-spin text-primary-60" />
            </div>
          ) : (
            <div id="recent-files">
              <Ipfs isRecentFiles />
            </div>
          )}
        </div>
      </DashboardTitleWrapper>

      <StagedChangesDialog
        open={isReviewOpen}
        onClose={() => setIsReviewOpen(false)}
        stagedChanges={stagedChanges}
        isSyncing={isReviewSyncing}
        onSync={async (resolutions: Record<string, ConflictResolution>) => {
          await syncWithResolutions(resolutions);
          setIsReviewOpen(false);
        }}
        onCancel={cancelReview}
      />
    </>
  );
};

export default Home;
