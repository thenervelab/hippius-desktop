"use client";

import { Drive } from "@/components/page-sections";
import { FC, useEffect } from "react";
import PageHeader from "@/components/ui/page-header";
import PlanSummaryCard from "@/components/ui/plan-chip/PlanSummaryCard";
import { useAtomValue, useSetAtom } from "jotai";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { isNestedFolderView } from "@/lib/utils/filesViewMode";

import InfoTooltip from "@/components/ui/info-tooltip";
import { fileDetailsPanelAtom } from "@/app/lib/global-atoms/fileDetailsAtoms";
import { driveAtFolderListAtom } from "@/app/lib/global-atoms/driveViewAtoms";

const DRIVE_DOCS_URL = "https://docs.hippius.com/use/desktop/drive";

const FilesPage: FC = () => {
  // The inline FileDetailsPanel is mounted at the layout level
  // (ResponsiveContent) so it stays pinned to the available screen height
  // instead of scrolling with the page. We just need to clear the panel
  // atom on unmount so a selection from this page doesn't bleed into other
  // routes if the user navigates away with the panel still open.
  const setFileDetails = useSetAtom(fileDetailsPanelAtom);

  // The plan card belongs to the drive as a whole, so it is drawn on the one
  // view that is about the drive as a whole: the list of folders. Inside a
  // drive it repeats an account-wide fact over a view scoped to one folder,
  // next to a breadcrumb that is the thing actually worth reading up there.
  //
  // This cannot be read off the URL. Opening a synced drive from the folder
  // list is a state change inside DriveContainer, not a navigation, so
  // `/files` stays `/files` all the way into a drive; a URL-only check said
  // "folder list" while a drive's contents were on screen, which is how the
  // card survived one level in. DriveContainer publishes the answer instead.
  const atFolderList = useAtomValue(driveAtFolderListAtom);
  // The URL check stays as well, for the one case the atom cannot answer in
  // time: a link opened straight into a subfolder paints once before
  // DriveContainer's effect runs, and the atom still holds its initial true.
  const { getParam } = useUrlParams();
  const insideFolder = isNestedFolderView({
    folderName: getParam("folderName"),
    subFolderPath: getParam("subFolderPath"),
  });
  const showPlanCard = atFolderList && !insideFolder;
  useEffect(() => {
    return () => setFileDetails(null);
  }, [setFileDetails]);
  return (
    <>
      <PageHeader
        hideStats={true}
        infoTooltip={
          <InfoTooltip
            ariaLabel="Drive information"
            align="start"
            contentClassName="max-w-[280px]"
            learnMoreUrl={DRIVE_DOCS_URL}
          >
            Every folder you sync from this computer shows up here. Files are
            encrypted on your device before they upload, so only your unlock
            password can open them.
          </InfoTooltip>
        }
        title="Your Files"
        className="!shadow-none"
        subtitle="All uploaded files are private and securely encrypted."
        actions={
          // The same plan card the Overview header shows, rather than the
          // standing plans button that used to sit here: an account already
          // on a plan was being sold one, and neither the plan nor how full
          // it is was stated anywhere on this page.
          //
          // It goes in `actions`, not the header's own stats card, because
          // that card is xl-only and this page hides it, and because
          // `actions` renders at every width and in the cards view.
          //
          // Only on the folder list: see `showPlanCard`.
          showPlanCard ? <PlanSummaryCard /> : null
        }
      />
      <Drive />
    </>
  );
};

export default FilesPage;
