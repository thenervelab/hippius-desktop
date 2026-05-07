import { useEffect } from "react";
import { useSetAtom } from "jotai";
import {
  activeSubMenuItemAtom,
  isViewingRecentFilesAtom,
} from "@/app/components/sidebar/sideBarAtoms";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import DetailList from "./DetailList";
import StorageUsageTrends from "./storage-usage-trends";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import Ipfs from "@/app/components/page-sections/files/FilesContainer";
import { IS_SYNC_PAUSED, SyncPausedAlert } from "@/components/ui";

const Home: React.FC = () => {
  const setActiveSubMenuItem = useSetAtom(activeSubMenuItemAtom);
  const setIsViewingRecentFiles = useSetAtom(isViewingRecentFilesAtom);
  const { polkadotAddress } = useWalletAuth();

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

          <div className="gap-4 mt-6 w-full h-full grid grid-cols-1">
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
