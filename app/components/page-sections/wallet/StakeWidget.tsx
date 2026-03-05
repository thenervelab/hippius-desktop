"use client";

import { FC, useState } from "react";
import { useRouter } from "next/navigation";
import { AbstractIconWrapper, CardButton, Icons } from "@/components/ui";
import { useStaking } from "@/app/lib/hooks/useStaking";
import { formatStakingAmount } from "@/app/lib/utils/staking";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { toast } from "sonner";
import PasscodePromptDialog from "../stake-bridge/PasscodePromptDialog";

const StakeWidget: FC = () => {
    const router = useRouter();
    const { stakingInfo, operations, needsUnlock } = useStaking();
    const { unlockWithPasscode } = useWalletAuth();
    const [isWithdrawing, setIsWithdrawing] = useState(false);
    const [showPasscodePrompt, setShowPasscodePrompt] = useState(false);

    const handleStakeNow = () => {
        router.push("/stake?tab=stake");
    };

    const handleUnstakeAlpha = () => {
        router.push("/unstake");
    };

    // const handleViewRewards = () => {
    //     if (polkadotAddress) {
    //         openInExplorer(polkadotAddress, 'account');
    //     }
    // };

    const handleWithdrawUnbonded = async () => {
        if (needsUnlock) {
            setShowPasscodePrompt(true);
            return;
        }
        if (!operations.withdrawUnbonded) return;

        setIsWithdrawing(true);
        const loadingToast = toast.loading("Withdrawing unbonded tokens...", {
            duration: Infinity,
        });

        try {
            await operations.withdrawUnbonded();
            toast.dismiss(loadingToast);
            toast.success("Successfully withdrew unbonded tokens!");
        } catch (error) {
            toast.dismiss(loadingToast);
            toast.error(error instanceof Error ? error.message : "Failed to withdraw tokens");
            console.error("Withdraw error:", error);
        } finally {
            setIsWithdrawing(false);
        }
    };

    const formattedStakedAmount = formatStakingAmount(stakingInfo.bonded);
    const formattedRewards = formatStakingAmount(stakingInfo.rewards);
    const formattedUnbonding = formatStakingAmount(stakingInfo.unbonding);
    const formattedWithdrawable = formatStakingAmount(stakingInfo.withdrawable);

    const hasRewards = parseFloat(stakingInfo.rewards) > 0;
    const hasStakedTokens = parseFloat(stakingInfo.bonded) > 0;
    const hasUnbonding = parseFloat(stakingInfo.unbonding) > 0;
    const hasWithdrawable = parseFloat(stakingInfo.withdrawable) > 0;

    return (
        <div className="w-full p-4 flex flex-col border border-grey-80 rounded-lg justify-between min-h-[310px]">
            <div className="flex flex-col w-full items-start">
                <div className="flex gap-4 items-center">
                    <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
                        <Icons.MoneyReceive className="absolute text-primary-40 size-4 sm:size-5" />
                    </AbstractIconWrapper>
                    <span className="text-base font-medium text-grey-60">
                        Stake hAlpha
                    </span>
                </div>
                <div className="flex justify-between items-start mt-4 w-full">
                    <div className="flex flex-col">
                        {/* Staked Amount */}
                        <div className="text-2xl font-medium text-grey-10">
                            {stakingInfo.isLoading ? "Loading..." : formattedStakedAmount}
                            <span className="text-xs font-medium -translate-y-1 ml-1">
                                hALPHA
                            </span>
                        </div>
                        <div className="text-xs text-grey-70 mt-2">
                            Total Staked hALPHA
                        </div>

                        {/* Withdrawable Section */}
                        {hasWithdrawable && (
                            <div className="flex items-center gap-2 mt-3">
                                <div className="flex flex-col">
                                    <div className="text-sm font-medium text-green-500">
                                        {formattedWithdrawable} hALPHA
                                    </div>
                                    <div className="text-xs text-grey-70">
                                        Ready to Withdraw
                                    </div>
                                </div>
                                <button
                                    onClick={handleWithdrawUnbonded}
                                    disabled={isWithdrawing}
                                    className="ml-2 text-green-500 hover:text-green-400 transition-colors disabled:opacity-50"
                                    title="Withdraw to free balance"
                                >
                                    <Icons.ArrowDown className="size-3" />
                                </button>
                            </div>
                        )}

                        {/* Rewards Section */}
                        {hasRewards && (
                            <div className="flex items-center gap-2 mt-3">
                                <div className="flex flex-col">
                                    <div className="text-sm font-medium text-primary-50">
                                        {formattedRewards} hALPHA
                                    </div>
                                    <div className="text-xs text-grey-70">
                                        Pending Rewards
                                    </div>
                                </div>
                                {/* <button
                                    onClick={handleViewRewards}
                                    className="ml-2 text-primary-50 hover:text-primary-40 transition-colors"
                                    title="View on Explorer"
                                >
                                    <Icons.SendSquare2 className="size-3" />
                                </button> */}
                            </div>
                        )}
                    </div>

                    {/* Unbonding Section - Right Side */}
                    {hasUnbonding && (
                        <div className="flex flex-col items-end">
                            <div className="text-lg font-medium text-error-70">
                                {formattedUnbonding} hALPHA
                            </div>
                            <div className="text-xs text-grey-70 text-right">
                                Unbonding ({stakingInfo.unbondingPeriods.length} period{stakingInfo.unbondingPeriods.length !== 1 ? 's' : ''})
                            </div>
                        </div>
                    )}
                </div>
            </div>
            <div className="flex flex-col">
                {/* Withdraw Button - Higher priority if withdrawable funds exist */}
                {hasWithdrawable && (
                    <CardButton
                        className="w-full mt-4 h-[50px]"
                        onClick={handleWithdrawUnbonded}
                        disabled={isWithdrawing}
                        variant="secondary"
                    >
                        <div className="flex items-center gap-2">
                            <Icons.ArrowDown className="size-4" />
                            <span className="flex items-center text-lg font-medium">
                                Withdraw {formattedWithdrawable} hALPHA
                            </span>
                        </div>
                    </CardButton>
                )}

                {/* Only show unstake button if user has staked tokens */}
                {hasStakedTokens && (
                    <CardButton
                        className="w-full mt-4 h-[50px]"
                        variant="secondary"
                        onClick={handleUnstakeAlpha}
                    >
                        <div className="flex items-center gap-2 text-lg font-medium text-grey-10">
                            <Icons.MoneySend className="size-4" />
                            Unstake hAlpha
                        </div>
                    </CardButton>
                )}
                <CardButton
                    className="w-full mt-3 h-[50px]"
                    onClick={handleStakeNow}
                >
                    <div className="flex items-center gap-2">
                        <Icons.MoneyReceive className="size-4" />
                        <span className="flex items-center text-lg font-medium">
                            Stake Now
                        </span>
                    </div>
                </CardButton>

            </div>

            <PasscodePromptDialog
                open={showPasscodePrompt}
                onOpenChange={setShowPasscodePrompt}
                onSubmit={unlockWithPasscode}
            />
        </div>
    );
};

export default StakeWidget;
