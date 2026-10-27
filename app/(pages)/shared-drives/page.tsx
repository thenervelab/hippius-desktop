"use client";

import { FC } from "react";

import FeatureDisabledRedirect from "@/components/FeatureDisabledRedirect";
import SharedDrivesView from "@/components/page-sections/shared-drives/SharedDrivesView";
import PageHeader from "@/components/ui/page-header";
import InfoTooltip from "@/components/ui/info-tooltip";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import { SHARED_DRIVES_DOCS_URL } from "@/components/page-sections/shared-drives/ShareADriveEmptyState";

/**
 * `/shared-drives`: the drives this account shared and the ones shared with
 * it, behind the shared drives flag like every other shared drive surface.
 */
const SharedDrivesPage: FC = () => (
  <FeatureDisabledRedirect enabled={SHARED_DRIVES_ENABLED}>
    <SharedDrivesView
      // The header is drawn by the view so "Share a drive" can sit on its
      // right, beside the title, and open the view's own picker.
      renderHeader={(actions) => (
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
      )}
    />
  </FeatureDisabledRedirect>
);

export default SharedDrivesPage;
