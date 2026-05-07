import { useEffect } from "react";
import { useSetAtom } from "jotai";
import {
  activeSubMenuItemAtom,
  isViewingRecentFilesAtom,
} from "@/app/components/sidebar/sideBarAtoms";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import HomepageHeader from "./HomepageHeader";
import AvailableCreditsCard from "./available-credits";
import StorageUsageCard from "./storage-usage-bars";
import Drive from "@/app/components/page-sections/drive/DriveContainer";
import { IS_SYNC_PAUSED, SyncPausedAlert } from "@/components/ui";

const Home: React.FC = () => {
  const setActiveSubMenuItem = useSetAtom(activeSubMenuItemAtom);
  const setIsViewingRecentFiles = useSetAtom(isViewingRecentFilesAtom);

  useEffect(() => {
    setActiveSubMenuItem("");
    setIsViewingRecentFiles(true);

    return () => {
      setIsViewingRecentFiles(false);
    };
  }, [setActiveSubMenuItem, setIsViewingRecentFiles]);

  return (
    <>
      <DashboardTitleWrapper mainText="Overview">
        <div className="px-3">
          <HomepageHeader />
          <div className="mt-3">
            {IS_SYNC_PAUSED && (
              <div className="mb-4">
                <SyncPausedAlert variant="inline" />
              </div>
            )}

            <div className="mb-3 grid gap-4 grid-cols-1 @xl:grid-cols-2">
              <AvailableCreditsCard />
              <StorageUsageCard />
            </div>

            <div id="recent-files">
              <Drive isRecentFiles />
            </div>
          </div>
        </div>
      </DashboardTitleWrapper>
    </>
  );
};

export default Home;
