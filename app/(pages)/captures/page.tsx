"use client";

import { FC } from "react";
import FeatureDisabledRedirect from "@/components/FeatureDisabledRedirect";
import CapturesView from "@/components/page-sections/captures/CapturesView";
import { useCaptureAvailability } from "@/app/lib/capture/useCaptureAvailability";

/**
 * `/captures`: every screenshot and recording, behind the capture flag and
 * Rust's support for this computer. Nothing renders while Rust has not
 * answered: redirecting then would bounce a Mac that captures off a deep
 * link (the tray's Captures folder, a preview card's "Show in folder")
 * before the answer lands a moment later.
 */
const CapturesPage: FC = () => {
  const availability = useCaptureAvailability();
  if (availability === "unknown") return null;
  return (
    <FeatureDisabledRedirect enabled={availability === "available"}>
      <CapturesView />
    </FeatureDisabledRedirect>
  );
};

export default CapturesPage;
