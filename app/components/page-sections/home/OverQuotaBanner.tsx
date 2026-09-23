"use client";

import React from "react";

import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { StatusBanner } from "@/app/components/page-sections/drive/service-status/DriveStatusBanner";
import { getOverQuotaBanner } from "@/app/components/page-sections/drive/service-status/driveStatusBannerState";

/**
 * Warning bar above the Overview storage card when usage exceeds the
 * free allowance or a paid plan (typically after a downgrade).
 *
 * Files stay; uploads pause. Distinct from {@link NoStoragePlanBanner},
 * which is the access-key "no plan" path. Renders nothing when the
 * account is within capacity.
 */
const OverQuotaBanner: React.FC<{ className?: string }> = ({ className }) => {
  const { data: overview } = useStorageOverview();

  return (
    <StatusBanner
      banner={getOverQuotaBanner({
        capacitySource: overview?.source,
        overDisplay: overview?.overDisplay,
      })}
      className={className}
    />
  );
};

export default OverQuotaBanner;
