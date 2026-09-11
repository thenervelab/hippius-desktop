"use client";

import React from "react";

import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { StatusBanner } from "@/app/components/page-sections/drive/service-status/DriveStatusBanner";
import { getNoStoragePlanBanner } from "@/app/components/page-sections/drive/service-status/driveStatusBannerState";

/**
 * The red bar above the Overview page's Storage and Plan cards, for an
 * account that has no storage capacity at all.
 *
 * It carries the whole explanation so the two cards below it do not have
 * to. A card is glanced at — a figure, a bar, a button — and the earlier
 * design tried to fit the reason into that shape, which turned the one
 * card meant to be readable at a glance into the loudest thing on the
 * page. The banner is the right place for a sentence; the card goes back
 * to stating its number.
 *
 * Deliberately narrower than the Drive page's `DriveStatusBanner`: it
 * draws ONLY the no-capacity state. Billing states (provisioning, past
 * due, cancelled) belong where the user acts on the drive, and the
 * Overview page is not that place.
 *
 * Renders nothing for an entitled account, so it can be mounted
 * unconditionally.
 */
const NoStoragePlanBanner: React.FC<{ className?: string }> = ({
  className,
}) => {
  // The capacity decision is Rust's (`get_storage_overview.source`); this
  // component must never re-derive it from the auth type or the plan.
  const { data: overview } = useStorageOverview();

  return (
    <StatusBanner
      banner={getNoStoragePlanBanner(overview?.source)}
      className={className}
    />
  );
};

export default NoStoragePlanBanner;
