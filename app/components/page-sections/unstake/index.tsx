"use client";

import { useState, useCallback } from "react";
import { BackButton } from "@/components/ui";
import TokenForm from "../wallet/shared/TokenForm";
import StakeConfirmationDialog from "../wallet/StakeConfirmationDialog";
import { toast } from "sonner";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import { useStaking } from "@/app/lib/hooks/useStaking";
import { toPlancks } from "@/app/lib/utils/staking";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { LocalWalletSelector, AddWalletDialog, InitialWalletSetup } from "../wallet/local-wallet";

const Unstake = () => {
    const { stakingInfo, operations, refetch } = useStaking();
    const { setupStep } = useLocalWallet();
    const [isLoading, setIsLoading] = useState(false);
    const [showConfirmation, setShowConfirmation] = useState(false);
    const [pendingAmount, setPendingAmount] = useState("");
    const [showAddWalletDialog, setShowAddWalletDialog] = useState(false);
    const [resetFormTrigger, setResetFormTrigger] = useState(false);

    const handleUnstakeSubmit = async (amount?: string) => {
        if (!amount || parseFloat(amount) <= 0) {
            toast.error("Please enter a valid amount");
            return;
        }

        const stakedBalance = Number(stakingInfo.bonded || '0') / 1e18; // Convert from planck with 18 decimals
        if (parseFloat(amount) > stakedBalance) {
            toast.error("Amount exceeds staked balance");
            return;
        }

        // Show confirmation dialog
        setPendingAmount(amount);
        setShowConfirmation(true);
    };

    const handleConfirmUnstake = async (mnemonic: string) => {
        setIsLoading(true);
        setShowConfirmation(false);

        // Show loading toast
        const loadingToast = toast.loading("Unstaking tokens...", {
            description: "Please wait while we process your unstaking transaction",
            duration: Infinity,
        });

        try {
            // Convert amount to planck (18 decimals)
            const amountInPlanck = toPlancks(pendingAmount);

            await operations.unbond(amountInPlanck, mnemonic);
            toast.dismiss(loadingToast);
            toast.success(`Successfully initiated unstaking of ${pendingAmount} hALPHA! Tokens will be available after the unbonding period.`);

            // Refetch stake info after unbonding
            if (typeof refetch === 'function') {
                await refetch();
            }

            // Clear form and reset
            setPendingAmount("");
            setResetFormTrigger(true);
        } catch (error) {
            console.error("Unstaking failed:", error);
            toast.dismiss(loadingToast);
            toast.error(`Unstaking failed: ${error instanceof Error ? error.message : "Unknown error"}`);
        } finally {
            setIsLoading(false);
            setPendingAmount("");
        }
    };

    const handleCloseConfirmation = () => {
        setShowConfirmation(false);
        setPendingAmount("");
    };

    const handleFormReset = useCallback(() => {
        setResetFormTrigger(false);
    }, []);

    // Show wallet setup if no wallet is ready
    if (setupStep !== "ready") {
        return (
            <DashboardTitleWrapper mainText="Wallet">
                <div className="mb-6">
                    <BackButton text="Go Back" href="/wallet" />
                </div>
                <div className="flex items-center justify-center min-h-[calc(100vh-250px)]">
                    <div className="bg-white rounded-lg shadow-menu border border-grey-80 overflow-hidden">
                        <InitialWalletSetup />
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
                <div className="flex flex-col items-center">
                    <TokenForm
                        title="Unstake hAlpha"
                        description="Redeem your staked hAlpha tokens on Hippius"
                        balanceLabel="Staked Balance"
                        balanceAmount={stakingInfo.bonded || "0"}
                        inputPlaceholder="Enter Amount to Withdraw"
                        buttonText={isLoading ? "Unstaking..." : "Unstake hAlpha"}
                        onSubmit={handleUnstakeSubmit}
                        showStakedAmount
                        isUnstaking={true}
                        loading={isLoading}
                        isLoadingBalance={stakingInfo.isLoading}
                        resetForm={resetFormTrigger}
                        onFormReset={handleFormReset}
                        refetchOnSuccess={true}
                    />
                </div>
            </DashboardTitleWrapper>

            {/* Unstake Confirmation Dialog */}
            <StakeConfirmationDialog
                open={showConfirmation}
                onClose={handleCloseConfirmation}
                onConfirm={handleConfirmUnstake}
                loading={isLoading}
                amount={pendingAmount}
                isUnstaking={true}
            />

            {/* Add Wallet Dialog */}
            <AddWalletDialog
                open={showAddWalletDialog}
                onClose={() => setShowAddWalletDialog(false)}
            />
        </>
    );
};

export default Unstake;