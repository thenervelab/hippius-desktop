"use client";

import { FC, useEffect } from "react";
import { useSetAtom } from "jotai";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import StarredView, { STARRED_TITLE } from "@/components/page-sections/starred/StarredView";
import { fileDetailsPanelAtom } from "@/app/lib/global-atoms/fileDetailsAtoms";

/**
 * `/starred`: the files, folders and drives this account starred. Not gated:
 * on a server without Starred the page says so itself.
 */
const StarredPage: FC = () => {
  // File Details is mounted for the whole layout; a panel opened from this
  // page closes when the page does, as on the Drive page.
  const setFileDetails = useSetAtom(fileDetailsPanelAtom);
  useEffect(() => () => setFileDetails(null), [setFileDetails]);
  // The top bar names the page, as on My Drive and Overview.
  return (
    <DashboardTitleWrapper mainText={STARRED_TITLE}>
      <StarredView />
    </DashboardTitleWrapper>
  );
};

export default StarredPage;
