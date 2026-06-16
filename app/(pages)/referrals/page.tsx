import { Referrals } from "@/components/page-sections";
import { FC } from "react";
import FeatureDisabledRedirect from "@/components/FeatureDisabledRedirect";
import { REFERRALS_FEATURE_ENABLED } from "@/app/lib/featureFlags";

const ReferralsPage: FC = () => (
  <FeatureDisabledRedirect enabled={REFERRALS_FEATURE_ENABLED}>
    <Referrals />
  </FeatureDisabledRedirect>
);

export default ReferralsPage;
