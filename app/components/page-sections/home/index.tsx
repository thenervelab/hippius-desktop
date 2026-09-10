import { useEffect } from "react";
import { useSetAtom } from "jotai";
import {
  activeSubMenuItemAtom,
  isViewingRecentFilesAtom,
} from "@/app/components/sidebar/sideBarAtoms";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import PageHeader from "./PageHeader";
import StorageOverviewCard from "./storage-overview";
import PlanOverviewCard from "./plan-overview";
import NoStoragePlanBanner from "./NoStoragePlanBanner";
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
          {/* No plan card up here: the Storage and Plan cards immediately
              below already carry the plan, the usage and Manage/Upgrade,
              with the room to show them properly. */}
          <PageHeader showPlanCard={false} />
          <div className="mt-3">
            {/* Above the pair, not inside either one: it is about both
                of them, and it is the only thing on the page worth
                interrupting for. Renders nothing for an account that has
                storage. */}
            <NoStoragePlanBanner className="mb-3" />

            {/* Usage bar + the plan/credits summary. Both render from the same
                get_storage_overview fetch, so they can't disagree. */}
            <div className="mb-3 grid gap-4 grid-cols-1 @xl:grid-cols-2 items-stretch">
              <StorageOverviewCard />
              <PlanOverviewCard />
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
