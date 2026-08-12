import { useEffect } from "react";
import { useSetAtom } from "jotai";
import {
  activeSubMenuItemAtom,
  isViewingRecentFilesAtom,
} from "@/app/components/sidebar/sideBarAtoms";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import PageHeader from "./PageHeader";
import AvailableCreditsCard from "./available-credits";
import StorageUsageCard from "./storage-usage";
import Drive from "@/app/components/page-sections/drive/DriveContainer";

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
          <PageHeader />
          <div className="mt-3">
            <div className="mb-3 grid gap-4 grid-cols-1 @xl:grid-cols-2">
              <AvailableCreditsCard />
              <StorageUsageCard />
            </div>

            {/* `pb-10` mirrors the drive page's bottom gap: the recent-files
                card is the last block in the page scroll, so without it the
                card sits flush against the bottom edge when fully scrolled.
                It belongs here (the recent-files card's own wrapper in the
                page scroll) rather than inside DriveContainer, whose
                isRecentFiles branch intentionally skips its `pb-10`. */}
            <div id="recent-files" className="pb-10">
              <Drive isRecentFiles />
            </div>
          </div>
        </div>
      </DashboardTitleWrapper>
    </>
  );
};

export default Home;
