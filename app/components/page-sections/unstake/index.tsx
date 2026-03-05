"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { BackButton } from "@/components/ui";
import TokenForm from "../wallet/shared/TokenForm";
import StakeConfirmationDialog from "../wallet/StakeConfirmationDialog";
import { toast } from "sonner";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import { useStaking } from "@/app/lib/hooks/useStaking";
import { toPlancks } from "@/app/lib/utils/staking";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import PasscodePromptDialog from "../stake-bridge/PasscodePromptDialog";

const Unstake = () => {
    const router = useRouter();
    const { stakingInfo, operations, needsUnlock } = useStaking();
    const { unlockWithPasscode } = useWalletAuth();
    const [isLoading, setIsLoading] = useState(false);
    const [showConfirmation, setShowConfirmation] = useState(false);
    const [pendingAmount, setPendingAmount] = useState("");
    const [showPasscodePrompt, setShowPasscodePrompt] = useState(false);
    const pendingUnstakeAmount = useRef<string | undefined>();

    // After passcode unlock, retry the pending unstake action.
    // Only depends on needsUnlock — the ref carries the pending amount.
    useEffect(() => {
        if (!needsUnlock && pendingUnstakeAmount.current) {
            const amount = pendingUnstakeAmount.current;
            pendingUnstakeAmount.current = undefined;
            handleUnstakeSubmit(amount);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [needsUnlock]);

    const handleUnstakeSubmit = async (amount?: string) => {
        if (needsUnlock) {
            pendingUnstakeAmount.current = amount;
            setShowPasscodePrompt(true);
            return;
        }

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

    const handleConfirmUnstake = async () => {
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

            await operations.unbond(amountInPlanck);
            toast.dismiss(loadingToast);
            toast.success(`Successfully initiated unstaking of ${pendingAmount} hALPHA! Tokens will be available after the unbonding period.`);

            // Navigate back to wallet
            router.push("/wallet");
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

    return (
        <>
            <DashboardTitleWrapper mainText="Wallet">
                <div className="mb-6">
                    <BackButton text="Go Back" href="/wallet" />
                </div>
                <TokenForm
                    title="Unstake hAlpha"
                    description="Redeem your staked hAlpha tokens on Hippius"
                    balanceLabel="Staked Balance"
                    balanceAmount={stakingInfo.bonded || "0"} // Pass raw planck value
                    inputPlaceholder="Enter Amount to Withdraw"
                    buttonText={isLoading ? "Unstaking..." : "Unstake hAlpha"}
                    onSubmit={handleUnstakeSubmit}
                    showStakedAmount
                    stakedAmount={`${stakingInfo.bonded || "0.00"} hAlpha`}
                    isUnstaking={true}
                    loading={isLoading}
                />
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

            {/* Passcode prompt when wallet keypair is not in memory */}
            <PasscodePromptDialog
                open={showPasscodePrompt}
                onOpenChange={setShowPasscodePrompt}
                onSubmit={unlockWithPasscode}
            />
        </>
    );
};

export default Unstake;