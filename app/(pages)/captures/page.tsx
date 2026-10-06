"use client";

import { FC } from "react";
import FeatureDisabledRedirect from "@/components/FeatureDisabledRedirect";
import CapturesView from "@/components/page-sections/captures/CapturesView";
import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";

/** `/captures`: every screenshot and recording, behind the capture flag. */
const CapturesPage: FC = () => (
  <FeatureDisabledRedirect enabled={SCREEN_CAPTURE_ENABLED}>
    <CapturesView />
  </FeatureDisabledRedirect>
);

export default CapturesPage;
