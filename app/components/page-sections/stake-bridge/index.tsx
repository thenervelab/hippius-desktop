"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { BackButton, Icons } from "@/components/ui";
import TabList, { TabOption } from "@/components/ui/tabs/TabList";
import TokenForm from "../wallet/shared/TokenForm";
import { toast } from "sonner";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import { useStaking } from "@/app/lib/hooks/useStaking";
import { toPlancks } from "@/app/lib/utils/staking";
import StakeConfirmationDialog from "../wallet/StakeConfirmationDialog";
import { BN } from "@polkadot/util";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { LocalWalletSelector, AddWalletDialog, LocalWalletSetup } from "../wallet/local-wallet";
import { useHippiusBalance } from "@/app/lib/hooks/api/useHippiusBalance";

const StakeBridge = () => {
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const tabParam = searchParams.get("tab");
    const { stakingInfo, operations } = useStaking();
    const { setupStep, activeWallet } = useLocalWallet();
    const { data: balanceInfo } = useHippiusBalance();

    // Add wallet dialog state
    const [showAddWalletDialog, setShowAddWalletDialog] = useState(false);

    // Set initial tab based on URL parameter or pathname
    // If on /bridge route, default to bridge tab
    const [activeTab, setActiveTab] = useState(() => {
        if (tabParam === "bridge" || pathname === "/bridge") {
            return "Bridge hAlpha";
        }
        return "Stake hAlpha";
    });

    const [isLoading, setIsLoading] = useState(false);
    const [showConfirmation, setShowConfirmation] = useState(false);
    const [pendingAmount, setPendingAmount] = useState("");

    // Update URL when tab changes - navigate to appropriate route
    useEffect(() => {
        if (activeTab === "Bridge hAlpha") {
            router.replace("/bridge", { scroll: false });
        } else {
            router.replace("/stake", { scroll: false });
        }
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

    const handleConfirmStake = async (mnemonic: string) => {
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

            await operations.bond(amountInPlanck, mnemonic);
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
    // Uses balanceInfo from useHippiusBalance for consistency with wallet page
    const calculateAvailableBalance = () => {
        // Use balanceInfo.data.free from useHippiusBalance (same as WalletBalanceWidget)
        const freeBalance = balanceInfo?.data?.free;
        if (!freeBalance) return "0";

        const totalFreeBalance = freeBalance.toString();
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

    // Show wallet setup if no wallet is ready
    if (setupStep !== "ready") {
        return (
            <DashboardTitleWrapper mainText="Wallet">
                <div className="mb-6">
                    <BackButton text="Go Back" href="/wallet" />
                </div>
                <div className="flex items-center justify-center min-h-[400px]">
                    <div className="bg-white rounded-lg shadow-menu border border-grey-80 overflow-hidden">
                        <LocalWalletSetup />
                    </div>
                </div>
            </DashboardTitleWrapper>
        );
    }

    return (
        <>
            <DashboardTitleWrapper
                mainText="Wallet"
                subText="Manage your wallet, view balances, stake, and bridge tokens"
            >
                <div className="my-6 flex items-center justify-between">
                    <BackButton text="Go Back" href="/wallet" />
                    <LocalWalletSelector
                        onAddWallet={() => setShowAddWalletDialog(true)}
                    />
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

            {/* Add Wallet Dialog */}
            <AddWalletDialog
                open={showAddWalletDialog}
                onClose={() => setShowAddWalletDialog(false)}
            />
        </>
    );
};

export default StakeBridge;