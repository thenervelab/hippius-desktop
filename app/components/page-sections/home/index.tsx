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
import Ipfs from "@/components/page-sections/files/ipfs";
import { Icons } from "@/components/ui";


const Home: React.FC = () => {
  const setActiveSubMenuItem = useSetAtom(activeSubMenuItemAtom);
  const setIsViewingRecentFiles = useSetAtom(isViewingRecentFilesAtom);

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
  }, [
    isCheckingSyncPath,
    setActiveSubMenuItem,
    setIsViewingRecentFiles,
  ]);

  return (
    <>
      <DashboardTitleWrapper mainText="Welcome to Hippius" subText="Secure & Encrypted Storage with Easy Sync and Real-Time Tracking">

        <div className="mt-6">

          {/* Stats Cards */}
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
    </>
  );
};

export default Home;
