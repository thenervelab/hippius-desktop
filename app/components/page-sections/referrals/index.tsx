"use client";

import ReferralLinkCard from "./ReferralLinkaCard";
import DetailsCard from "./RefferalCard";
import ReferralHistoryTable from "./ReferralHistoryTable";
import ReferralLinksTable from "./ReferralLinksTable";
import DashboardTitleWrapper from "../../dashboard-title-wrapper";
import { useReferralLinks } from "@/app/lib/hooks/api/useReferralLinks";
import { useUserReferrals } from "@/app/lib/hooks/api/useUserReferrals";
import { UserSquare, PieChart } from "lucide-react";
import { WalletAdd } from "../../ui/icons";

const Referrals: React.FC = () => {
  const { data } = useUserReferrals();
  const { links } = useReferralLinks();

  const totalCredits = links.reduce(
    (sum, { reward }) => sum + Number(reward),
    0
  );

  return (
    <DashboardTitleWrapper mainText="Referrals">
      <div className="w-full mt-6">
        <div className="grid grid-cols-1 md:grid-cols-2 min-[1300px]:grid-cols-4 gap-4 mb-6">
          <ReferralLinkCard />
          <DetailsCard
            icon={UserSquare}
            title="Total Referrals`"
            value={data ? data.totalReferrals : "---"}
          />
          <DetailsCard
            icon={PieChart}
            title="Usage Count"
            value={data ? data.referralHistory.length : "---"}
          />
          <DetailsCard
            icon={WalletAdd}
            title="Total Credits Earned "
            value={totalCredits.toString()}
          />
        </div>
        <div className="p-4 border border-grey-80 shadow-sm rounded-lg mb-6">
          <ReferralLinksTable />
        </div>
        <div className="p-4 border border-grey-80 shadow-sm rounded-lg">
          <ReferralHistoryTable />
        </div>
      </div>
    </DashboardTitleWrapper>
  );
};

export default Referrals;
