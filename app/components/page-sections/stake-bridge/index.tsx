"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BackButton, Icons } from "@/components/ui";
import TabList, { TabOption } from "@/components/ui/tabs/TabList";
import TokenForm from "../wallet/shared/TokenForm";
import { toast } from "sonner";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import { useStaking } from "@/app/lib/hooks/useStaking";
import { toPlancks } from "@/app/lib/utils/staking";
import StakeConfirmationDialog from "../wallet/StakeConfirmationDialog";
import { BN } from "@polkadot/util";

const StakeBridge = () => {
    const searchParams = useSearchParams();
    const router = useRouter();
    const tabParam = searchParams.get("tab");
    const { stakingInfo, operations } = useStaking();

    // Set initial tab based on URL parameter, default to "Stake hAlpha"
    const [activeTab, setActiveTab] = useState(() => {
        return tabParam === "bridge" ? "Bridge hAlpha" : "Stake hAlpha";
    });

    const [isLoading, setIsLoading] = useState(false);
    const [showConfirmation, setShowConfirmation] = useState(false);
    const [pendingAmount, setPendingAmount] = useState("");

    // Update URL when tab changes
    useEffect(() => {
        const newTab = activeTab === "Bridge hAlpha" ? "bridge" : "stake";
        const currentPath = window.location.pathname;
        const newUrl = `${currentPath}?tab=${newTab}`;
        router.replace(newUrl, { scroll: false });
    }, [activeTab, router]);

    const tabs: TabOption[] = [
        {
            tabName: "Stake hAlpha",
            icon: <Icons.MoneyReceive className="size-4" />,
        },
        {
            tabName: "Bridge hAlpha",
            icon: <Icons.Money className="size-4" />,
        },
    ];

    const handleStakeSubmit = async (amount?: string) => {
        if (!amount || parseFloat(amount) <= 0) {
            toast.error("Please enter a valid amount");
            return;
        }

        const availableAmount = Number(availableBalance || '0') / 1e18; // Convert from planck with 18 decimals
        if (parseFloat(amount) > availableAmount) {
            toast.error("Amount exceeds available balance");
            return;
        }

        // Show confirmation dialog
        setPendingAmount(amount);
        setShowConfirmation(true);
    };

    const handleConfirmStake = async () => {
        setIsLoading(true);
        setShowConfirmation(false);

        // Show loading toast
        const loadingToast = toast.loading("Staking tokens...", {
            description: "Please wait while we process your staking transaction",
            duration: Infinity,
        });

        try {
            // Convert amount to planck (18 decimals)
            const amountInPlanck = toPlancks(pendingAmount);

            await operations.bond(amountInPlanck);
            toast.dismiss(loadingToast);
            toast.success(`Successfully staked ${pendingAmount} hALPHA!`);

            // Navigate back to wallet
            router.push("/wallet");
        } catch (error) {
            console.error("Staking failed:", error);
            toast.dismiss(loadingToast);
            toast.error(`Staking failed: ${error instanceof Error ? error.message : "Unknown error"}`);
        } finally {
            setIsLoading(false);
            setPendingAmount("");
        }
    };

    const handleCloseConfirmation = () => {
        setShowConfirmation(false);
        setPendingAmount("");
    };

    const handleBridgeSubmit = () => {
        toast.info("This feature is coming soon!");
    };

    // Calculate available balance for staking (excluding staked and unbonding amounts)
    const calculateAvailableBalance = () => {
        if (!stakingInfo.balance) return "0";

        const totalFreeBalance = stakingInfo.balance.toString();
        const bondedAmount = stakingInfo.bonded || "0";
        const unbondingAmount = stakingInfo.unbonding || "0";

        try {
            // Convert to BN for safe calculation
            const totalBN = new BN(totalFreeBalance);
            const bondedBN = new BN(bondedAmount);
            const unbondingBN = new BN(unbondingAmount);

            // Available = Total Free - Bonded - Unbonding
            const availableBN = totalBN.sub(bondedBN).sub(unbondingBN);

            // Ensure we don't return negative values
            return availableBN.gte(new BN(0)) ? availableBN.toString() : "0";
        } catch (error) {
            console.warn("Error calculating available balance:", error);
            return totalFreeBalance; // Fallback to total balance
        }
    };

    // Get available balance for staking (truly free amount)
    const availableBalance = calculateAvailableBalance();

    return (
        <>
            <DashboardTitleWrapper mainText="Wallet">
                <div className="mb-6">
                    <BackButton text="Go Back" href="/wallet" />
                </div>

                {/* Tabs */}
                <div className="flex justify-center mb-8">
                    <TabList
                        tabs={tabs}
                        activeTab={activeTab}
                        onTabChange={setActiveTab}
                        width="min-w-[140px]"
                        gap="gap-1"
                    />
                </div>

                {/* Content */}
                {activeTab === "Stake hAlpha" && (
                    <TokenForm
                        title="Stake hAlpha"
                        description="Stake your hAlpha tokens on Hippius"
                        balanceLabel="Available Balance"
                        balanceAmount={availableBalance}
                        inputPlaceholder="Enter Amount to Stake"
                        buttonText={isLoading ? "Staking..." : "Stake Now"}
                        onSubmit={handleStakeSubmit}
                        showStakedAmount
                        stakedAmount={`${stakingInfo.bonded || "0.00"} hAlpha`}
                        isStaking={true}
                        loading={isLoading}
                    />
                )}

                {activeTab === "Bridge hAlpha" && (
                    <TokenForm
                        title="Bridge hAlpha"
                        description="Swap hALPHA and TAO without leaving the Hippius easily"
                        balanceLabel="Available Balance"
                        balanceAmount={availableBalance}
                        inputPlaceholder="You Send"
                        buttonText="Bridge Now"
                        onSubmit={handleBridgeSubmit}
                        showEstimateAndFees={true}
                        estimatedTime="0 Seconds"
                        gasFees="0.00 hALPHA"
                    />
                )}
            </DashboardTitleWrapper>

            {/* Stake Confirmation Dialog */}
            <StakeConfirmationDialog
                open={showConfirmation}
                onClose={handleCloseConfirmation}
                onConfirm={handleConfirmStake}
                loading={isLoading}
                amount={pendingAmount}
                isUnstaking={false}
            />
        </>
    );
};

export default StakeBridge;