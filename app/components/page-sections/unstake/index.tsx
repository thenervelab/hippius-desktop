"use client";

import { BackButton, Icons } from "@/components/ui";
import TokenForm from "../wallet/shared/TokenForm";
import { toast } from "sonner";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";

const Unstake = () => {
    const handleUnstakeSubmit = () => {
        toast.info("This feature is coming soon!");
    };

    return (
        <DashboardTitleWrapper mainText="Wallet">
            <div className="mb-6">
                <BackButton text="Go Back" href="/wallet" />
            </div>
            <TokenForm
                title="Unstake hAlpha"
                description="Redeem your staked hAlpha"
                balanceLabel="Native Balance"
                balanceAmount="413,000.00"
                inputPlaceholder="Enter Amount to Withdraw"
                buttonText="Unstake hAlpha"
                buttonIcon={<Icons.Repeat className="size-4 rotate-180" />}
                onSubmit={handleUnstakeSubmit}
                showStakedAmount
                stakedAmount="0.00 hAlpha"
            />
        </DashboardTitleWrapper>
    );
};

export default Unstake;