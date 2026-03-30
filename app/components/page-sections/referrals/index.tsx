"use client";

import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import { UserSquare, PieChart } from "lucide-react";
import { WalletAdd, TaoLogo, Refresh } from "@/components/ui/icons";
import { Link as LinkIcon, Hourglass, Send } from "lucide-react";
import { ComingSoon, AbstractIconWrapper } from "@/components/ui";
import { P } from "@/components/ui/typography";

// Feature flag - set to true when referrals feature is ready
const REFERRALS_ENABLED = false;

// Static placeholder card component
const PlaceholderCard = ({
  icon: Icon,
  title,
  value
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  value: string;
}) => (
  <div className="bg-white p-3 rounded-lg border border-grey-80 shadow-sm flex justify-between flex-col">
    <div className="flex justify-between items-start">
      <AbstractIconWrapper className="size-10 text-primary-40">
        <Icon className="absolute text-primary-40 size-6" />
      </AbstractIconWrapper>
    </div>
    <div className="mt-4">
      <div className="text-base font-medium text-grey-60 mb-2">{title}</div>
      <div className="text-2xl text-grey-10 font-medium">{value}</div>
    </div>
  </div>
);

// Static referral link card
const StaticReferralLinkCard = () => (
  <div className="bg-white p-3 rounded-lg border border-grey-80 shadow-sm h-[10.375rem] relative bg-[url('/assets/refferal.png')] bg-repeat-round bg-cover">
    <div className="flex flex-col gap-4">
      <div className="flex justify-between items-center">
        <div className="flex gap-2">
          <AbstractIconWrapper className="size-10 text-primary-40">
            <TaoLogo className="absolute text-white rounded size-6 p-1 bg-primary-50" />
          </AbstractIconWrapper>
          <div className="text-primary-40 text-xs flex gap-x-1 font-medium items-center">
            REFERRAL LINK
          </div>
        </div>
        <button className="flex items-center text-xs gap-1 cursor-not-allowed opacity-50" disabled>
          <Refresh className="size-[1.125rem] text-grey-60" />
          Generate Link
        </button>
      </div>
      <div className="h-[5.375rem] text-base leading-[1.375rem] text-grey-60 flex flex-col justify-center">
        <span className="mb-2">Your Referral Link</span>
        <div className="flex items-center justify-between rounded-[0.5rem] p-3 border border-grey-80 bg-white">
          <div className="text-grey-60 text-sm font-medium">
            Referral links coming soon
          </div>
        </div>
      </div>
    </div>
  </div>
);

// Static referral links table placeholder
const StaticReferralLinksTable = () => (
  <div className="mb-4">
    <div className="flex items-center gap-x-2 mb-4">
      <AbstractIconWrapper className="size-10">
        <LinkIcon className="absolute size-6 text-primary-50" />
      </AbstractIconWrapper>
      <P size="lg">Your Referral Links</P>
    </div>
    <div className="p-6 text-center text-gray-500 border border-grey-80 rounded-lg">
      No referral links yet
    </div>
  </div>
);

// Static referral history table placeholder
const StaticReferralHistoryTable = () => (
  <div>
    <div className="flex items-center gap-x-2 mb-4">
      <AbstractIconWrapper className="size-10">
        <Hourglass className="absolute size-6 text-primary-50" />
      </AbstractIconWrapper>
      <P size="lg">Referral History</P>
    </div>
    <div className="w-full h-[12.5rem] flex items-center justify-center border border-grey-80 rounded-lg">
      <div className="flex flex-col items-center">
        <AbstractIconWrapper className="size-10 rounded-2xl flex items-center justify-center bg-grey-40/20 mb-2">
          <Send className="absolute size-6 text-primary-50" />
        </AbstractIconWrapper>
        <span className="text-grey-60 text-sm font-medium max-w-[11.875rem] text-center">
          You have not made any referrals yet
        </span>
      </div>
    </div>
  </div>
);

const Referrals: React.FC = () => {
  // When feature is disabled, show static placeholder content
  if (!REFERRALS_ENABLED) {
    return (
      <DashboardTitleWrapper mainText="Referrals">
        <div className="w-full mt-6 relative">
          <ComingSoon
            variant="white"
            overlay={true}
            blurIntensity="extraLight"
            position="top-right"
            size="small"
          />
          <div className="grid grid-cols-1 md:grid-cols-2 min-[81.25rem]:grid-cols-4 gap-4 mb-6">
            <StaticReferralLinkCard />
            <PlaceholderCard icon={UserSquare} title="Total Referrals" value="0" />
            <PlaceholderCard icon={PieChart} title="Usage Count" value="0" />
            <PlaceholderCard icon={WalletAdd} title="Total hAlpha Earned" value="0" />
          </div>
          <div className="p-4 border border-grey-80 shadow-sm rounded-lg mb-6">
            <StaticReferralLinksTable />
          </div>
          <div className="p-4 border border-grey-80 shadow-sm rounded-lg">
            <StaticReferralHistoryTable />
          </div>
        </div>
      </DashboardTitleWrapper>
    );
  }

  // When feature is enabled, render the full components (future implementation)
  return (
    <DashboardTitleWrapper mainText="Referrals">
      <div className="w-full mt-6">
        <div className="text-center text-grey-60">
          Referrals feature coming soon...
        </div>
      </div>
    </DashboardTitleWrapper>
  );
};

export default Referrals;
