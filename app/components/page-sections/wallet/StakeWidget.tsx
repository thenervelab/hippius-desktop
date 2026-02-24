"use client";

import { FC, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AbstractIconWrapper, CardButton, Icons } from "@/components/ui";
import { useStaking } from "@/app/lib/hooks/useStaking";
import { formatStakingAmount } from "@/app/lib/utils/staking";
import { toast } from "sonner";
import { Clock, Lock, Unlock } from "lucide-react";
import { cn } from "@/app/lib/utils";
import WithdrawConfirmationDialog from "./WithdrawConfirmationDialog";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { useActiveWalletAddress } from "@/app/lib/hooks/useActiveWalletAddress";

const StakeWidget: FC = () => {
    const router = useRouter();
    const { stakingInfo, operations } = useStaking();
    const { activeWallet } = useLocalWallet();
    const activeAddress = useActiveWalletAddress();
    const [isWithdrawing, setIsWithdrawing] = useState(false);
    const [showWithdrawConfirmation, setShowWithdrawConfirmation] = useState(false);

    // Debug logging
    useEffect(() => {
        console.log('[StakeWidget] ====== DEBUG INFO ======');
        console.log('[StakeWidget] activeWallet:', activeWallet?.address);
        console.log('[StakeWidget] activeAddress from hook:', activeAddress);
        console.log('[StakeWidget] stakingInfo:', stakingInfo);
    }, [activeWallet, activeAddress, stakingInfo]);

    const handleStakeNow = () => {
        router.push("/stake");
    };

    const handleUnstakeAlpha = () => {
        router.push("/unstake");
    };

    const handleWithdrawClick = () => {
        setShowWithdrawConfirmation(true);
    };

    const handleConfirmWithdraw = async (mnemonic: string) => {
        if (!operations.withdrawUnbonded) return;

        setIsWithdrawing(true);
        setShowWithdrawConfirmation(false);
        const loadingToast = toast.loading("Withdrawing unbonded tokens...", {
            duration: Infinity,
        });

        try {
            await operations.withdrawUnbonded(mnemonic);
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
    const formattedUnbonding = formatStakingAmount(stakingInfo.unbonding);
    const formattedWithdrawable = formatStakingAmount(stakingInfo.withdrawable);

    // Compute total locked = bonded + unbonding + withdrawable
    const totalLockedRaw = (
        parseFloat(stakingInfo.bonded) +
        parseFloat(stakingInfo.unbonding) +
        parseFloat(stakingInfo.withdrawable)
    );
    const formattedLocked = formatStakingAmount(totalLockedRaw.toString());

    // Only show sections when not loading and values are > 0
    const hasStakedTokens = !stakingInfo.isLoading && parseFloat(stakingInfo.bonded) > 0;
    const hasUnbonding = !stakingInfo.isLoading && parseFloat(stakingInfo.unbonding) > 0;
    const hasWithdrawable = !stakingInfo.isLoading && parseFloat(stakingInfo.withdrawable) > 0;
    const hasLocked = !stakingInfo.isLoading && totalLockedRaw > 0;

    // Compute human-readable remaining time from blocks (6s per block)
    const BLOCK_TIME_SECONDS = 6;
    const formatRemainingTime = (blocks: number): string => {
        if (blocks <= 0) return '';
        const totalSeconds = blocks * BLOCK_TIME_SECONDS;
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const mins = Math.floor((totalSeconds % 3600) / 60);
        if (days > 0) return `${days}d ${hours}h`;
        if (hours > 0) return `${hours}h ${mins}m`;
        return `${mins}m`;
    };

    // Aggregate remaining blocks across all unbonding periods (use max since they finish at different times)
    const totalRemainingBlocks = stakingInfo.unbondingPeriods.reduce(
        (max, p) => Math.max(max, p.remainingBlocks), 0
    );
    const unbondingTimeStr = formatRemainingTime(totalRemainingBlocks);
    const unbondingTooltip = stakingInfo.unbondingPeriods.map(p => {
        const time = formatRemainingTime(p.remainingBlocks);
        return `${formatStakingAmount(p.amount)} hALPHA - ${p.remainingBlocks.toLocaleString()} blocks${time ? ` (~${time})` : ''}`;
    }).join('\n');

    return (
        <div className="w-full p-4 flex flex-col border border-grey-80 rounded-lg justify-between h-[310px]">
            <div className="flex flex-col w-full items-start">
                {/* Header */}
                <div className="flex gap-4 items-center">
                    <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
                        <Icons.MoneyReceive className="absolute text-primary-40 size-4 sm:size-5" />
                    </AbstractIconWrapper>
                    <span className="text-base font-medium text-grey-60">
                        Stake hAlpha
                    </span>
                </div>

                {/* Top row: Total Staked (left) + Locked (right) */}
                <div className="flex justify-between items-start mt-3 w-full">
                    <div className="flex flex-col">
                        <div className="text-2xl font-medium text-grey-10">
                            {stakingInfo.isLoading ? "Loading..." : formattedStakedAmount}
                            <span className="text-xs font-medium -translate-y-1 ml-1">
                                hALPHA
                            </span>
                        </div>
                        <div className="text-xs text-grey-70">
                            Total Staked
                        </div>
                    </div>

                    {hasLocked && (
                        <div className="flex flex-col items-end">
                            <div className="flex items-center gap-1 text-lg font-medium text-grey-30">
                                <Lock className="size-3.5" />
                                {formattedLocked}
                                <span className="text-xs font-medium ml-0.5">
                                    hALPHA
                                </span>
                            </div>
                            <div className="text-xs text-grey-70 text-right">
                                Total Locked
                            </div>
                        </div>
                    )}
                </div>

                {/* Bottom row: Unbonding (left) + Redeemable (right) */}
                {(hasUnbonding || hasWithdrawable) && (
                    <div className="flex justify-between items-start mt-3 w-full">
                        {/* Unbonding Section - Left */}
                        {hasUnbonding && (
                            <div className="flex items-center gap-2 group relative">
                                <div className="flex flex-col">
                                    <div className="flex items-center gap-1 text-sm font-medium text-amber-500 cursor-default">
                                        <Clock className="size-3.5" />
                                        {formattedUnbonding} hALPHA
                                    </div>
                                    <div className="text-xs text-grey-70">
                                        {unbondingTimeStr
                                            ? `~${unbondingTimeStr} remaining`
                                            : `Unbonding (${stakingInfo.unbondingPeriods.length})`}
                                    </div>
                                </div>
                                {/* Hover tooltip with detailed info */}
                                {unbondingTooltip && (
                                    <div className="absolute bottom-full left-0 mb-2 px-4 py-3 bg-white text-grey-10 text-xs rounded-lg border border-grey-80 shadow-md opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 min-w-[220px]">
                                        <div className="font-semibold text-grey-30 mb-1.5">Unbonding Details</div>
                                        {stakingInfo.unbondingPeriods.map((p, i) => {
                                            const time = formatRemainingTime(p.remainingBlocks);
                                            return (
                                                <div key={i} className="text-grey-10 leading-relaxed">
                                                    {formatStakingAmount(p.amount)} hALPHA
                                                    <span className="text-grey-50 ml-1">
                                                        {p.remainingBlocks.toLocaleString()} blocks{time ? ` (~${time})` : ''}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Redeemable Section - Right (or left if no unbonding) */}
                        {hasWithdrawable && (
                            <div className={cn("flex flex-col", hasUnbonding ? "items-end" : "items-start")}>
                                <div className="flex items-center gap-1 text-sm font-medium text-green-500">
                                    <Unlock className="size-3.5" />
                                    {formattedWithdrawable} hALPHA
                                </div>
                                <div className="text-xs text-grey-70">
                                    Redeemable
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Action buttons */}
            <div className="flex flex-col">
                {/* Unstake and Withdraw buttons - show conditionally */}
                {(hasStakedTokens || hasWithdrawable) && (
                    <div className="flex gap-3 mt-4 flex-row">
                        {hasStakedTokens && (
                            <CardButton
                                className="flex-1 h-[50px]"
                                variant="secondary"
                                onClick={handleUnstakeAlpha}
                            >
                                <div className="flex items-center gap-2 text-lg font-medium text-grey-10">
                                    <Icons.MoneySend className="size-4" />
                                    Unstake
                                </div>
                            </CardButton>
                        )}

                        {hasWithdrawable && (
                            <CardButton
                                className="flex-1 h-[50px]"
                                variant={hasStakedTokens ? undefined : "secondary"}
                                onClick={handleWithdrawClick}
                                disabled={isWithdrawing}
                            >
                                <div className={cn("flex items-center gap-2", hasStakedTokens ? "text-white" : "text-grey-10")}>
                                    <Icons.ArrowDown className="size-4 text-white" />
                                    <span className="flex items-center text-lg font-medium">
                                        Withdraw
                                    </span>
                                </div>
                            </CardButton>
                        )}
                    </div>
                )}

                <CardButton
                    className={cn("w-full h-[50px]", (hasStakedTokens || hasWithdrawable) ? "mt-3" : "mt-4")}
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

            {/* Withdraw Confirmation Dialog */}
            <WithdrawConfirmationDialog
                open={showWithdrawConfirmation}
                onClose={() => setShowWithdrawConfirmation(false)}
                onConfirm={handleConfirmWithdraw}
                loading={isWithdrawing}
                amount={formattedWithdrawable}
            />
        </div>
    );
};

export default StakeWidget;
