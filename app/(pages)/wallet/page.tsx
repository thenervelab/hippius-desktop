import { Wallet } from "@/components/page-sections";
import { FC } from "react";
import FeatureDisabledRedirect from "@/components/FeatureDisabledRedirect";
import { WALLET_FEATURE_ENABLED } from "@/app/lib/featureFlags";

const WalletPage: FC = () => (
  <FeatureDisabledRedirect enabled={WALLET_FEATURE_ENABLED}>
    <Wallet />
  </FeatureDisabledRedirect>
);

export default WalletPage;
