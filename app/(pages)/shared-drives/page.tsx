"use client";

import { FC, type ReactNode } from "react";

import FeatureDisabledRedirect from "@/components/FeatureDisabledRedirect";
import SharedDrivesView from "@/components/page-sections/shared-drives/SharedDrivesView";
import SharedDriveOpenView from "@/components/page-sections/shared-drives/SharedDriveOpenView";
import { isDriveOpenInUrl } from "@/components/page-sections/drive/driveTrail";
import PageHeader from "@/components/ui/page-header";
import InfoTooltip from "@/components/ui/info-tooltip";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import { SHARED_DRIVES_DOCS_URL } from "@/components/page-sections/shared-drives/ShareADriveEmptyState";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";

const renderHeader = (actions?: ReactNode) => (
  <PageHeader
    hideStats={true}
    title="Shared Drives"
    subtitle="Drives you've shared, and drives other people invited you into."
    className="!shadow-none"
    actions={actions}
    infoTooltip={
      <InfoTooltip
        ariaLabel="Shared drives information"
        align="start"
        contentClassName="max-w-[280px]"
        learnMoreUrl={SHARED_DRIVES_DOCS_URL}
      >
        A shared drive is one of your drives that other people can open too.
        Its files stay encrypted, and you decide who can see or change them.
      </InfoTooltip>
    }
  />
);

/**
 * `/shared-drives`: the drives this account shared and the ones shared with
 * it, behind the shared drives flag like every other shared drive surface.
 *
 * A row opens its drive on this page (`SharedDriveOpenView`), for as long as
 * the URL names one (`isDriveOpenInUrl`), so the trail and Back lead here.
 */
const SharedDrivesPage: FC = () => {
  const { getParam } = useUrlParams();
  const driveOpen = isDriveOpenInUrl(getParam);
  return (
    <FeatureDisabledRedirect enabled={SHARED_DRIVES_ENABLED}>
      {driveOpen && <SharedDriveOpenView header={renderHeader()} />}
      {/* The list stays mounted, hidden, while a drive is open, so coming
          back to it keeps the tab and page it was left on (and does not
          load from scratch). `contents` keeps the wrapper out of the
          layout when it shows. Hidden by attribute AND class: `contents`
          is a utility, which beats the `[hidden]` base rule. */}
      <div
        data-testid="shared-drives-list"
        hidden={driveOpen}
        className={driveOpen ? "hidden" : "contents"}
      >
        <SharedDrivesView
          // The header is drawn by the view so "Share a drive" can sit on its
          // right, beside the title, and open the view's own picker.
          renderHeader={renderHeader}
        />
      </div>
    </FeatureDisabledRedirect>
  );
};

export default SharedDrivesPage;
