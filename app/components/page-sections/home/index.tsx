import { useEffect } from "react";
import { useSetAtom } from "jotai";
import {
  activeSubMenuItemAtom,
  isViewingRecentFilesAtom,
} from "@/app/components/sidebar/sideBarAtoms";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import PageHeader from "./PageHeader";
import StorageOverviewCard from "./storage-overview";
import DriveBreakdownCard from "./breakdown/DriveBreakdownCard";
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

            {/* One card, not two. The Plan card beside this one restated the
                plan name and the allowance the storage card was already
                showing, from the same get_storage_overview fetch, so the
                pair said one thing twice and only its button was new. That
                button now sits in this card, next to the reading it acts on.

                Still capped, and ONLY here: the banner above and Recent
                Files below stay full-bleed, which is the page's intended
                shape. This card is the exception because its content does
                not grow with the window, where the files table genuinely
                uses every pixel it is given for filenames. A page-wide cap
                was tried and reverted for exactly that reason. */}
            {/* Two cards: how full the drive is, and what is in it. The
                breakdown holds both of its views behind a tab rather than
                taking a card each, which is what kept this row at two.

                Three cards was tried and read badly: each sat a third wide,
                and below the three-across breakpoint they stacked into a
                column of near-identical bar charts, the same shape twice.
                Two cards at half the row is the width each actually has
                content for, and it is the shape the console uses.

                Full bleed, like Recent Files below it. The row used to be
                capped, from when a single card sat here and stretched into
                an empty banner past about 700px. Split in half, each card
                is half of whatever the window gives, so the cap was holding
                the row narrower than the page for a reason that no longer
                applied. */}
            <div className="mb-3 grid w-full grid-cols-1 gap-3 @4xl:grid-cols-2">
              <StorageOverviewCard />
              <DriveBreakdownCard />
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
