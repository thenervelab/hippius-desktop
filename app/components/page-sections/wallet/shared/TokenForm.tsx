"use client";

import { FC, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Input, CardButton, Icons, AbstractIconWrapper } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useStaking } from "@/app/lib/hooks/useStaking";


interface TokenFormProps {
    title: string;
    description: string;
    balanceLabel: string;
    balanceAmount: string; // Raw planck value as string
    inputPlaceholder: string;
    buttonText: string;
    onSubmit: (amount?: string) => void;
    estimatedTime?: string;
    gasFees?: string;
    showEstimateAndFees?: boolean;
    showStakedAmount?: boolean;
    stakedAmount?: string;
    className?: string;
    isStaking?: boolean; // New prop to identify staking forms
    isUnstaking?: boolean; // New prop to identify unstaking forms
    loading?: boolean; // New prop for loading state
}

const TokenForm: FC<TokenFormProps> = ({
    title,
    description,
    balanceLabel,
    // balanceAmount — kept in props interface for callers, but we use Rust display values instead
    inputPlaceholder,
    buttonText,
    showStakedAmount = false,
    stakedAmount,
    onSubmit,
    estimatedTime = "0 Seconds",
    gasFees = "0.00 hALPHA",
    showEstimateAndFees = false,
    className,
    isStaking = false,
    isUnstaking = false,
    loading = false,
}) => {
    const [amount, setAmount] = useState("");
    const { stakingInfo } = useStaking();

    // Raw planck string for the relevant balance.
    const availablePlanck = useMemo(() => {
        if (isStaking) return stakingInfo.availableBalance || "0";
        if (isUnstaking) return stakingInfo.bonded || "0";
        return stakingInfo.balance || "0";
    }, [stakingInfo.availableBalance, stakingInfo.bonded, stakingInfo.balance, isStaking, isUnstaking]);

    // Rust pre-formats every balance as HIP (`planck_to_hip`) — see
    // `src-tauri/src/blockchain/convert.rs`. We pick the matching
    // `*_hip` field here instead of re-dividing in JS.
    const availableDisplay = useMemo(() => {
        if (isStaking) return stakingInfo.availableBalanceHip;
        if (isUnstaking) return stakingInfo.bondedHip;
        return stakingInfo.balanceHip;
    }, [
        stakingInfo.availableBalanceHip,
        stakingInfo.bondedHip,
        stakingInfo.balanceHip,
        isStaking,
        isUnstaking,
    ]);

    const formattedStakedAmount = useMemo(() => {
        if (showStakedAmount) {
            return stakingInfo.bondedHip;
        }
        return stakedAmount || "0.00";
    }, [showStakedAmount, stakingInfo.bondedHip, stakedAmount]);

    const handleSubmit = () => {
        onSubmit(amount);
    };

    // Full-precision HIP for the max-fill. The displayed `availableDisplay`
    // already carries every planck digit (Rust strips trailing zeros only),
    // so we can use it directly and skip the IPC round-trip.
    const handleMaxClick = async () => {
        try {
            const full = await invoke<string>("planck_to_hip_full", { planck: availablePlanck });
            setAmount(full);
        } catch {
            setAmount(availableDisplay);
        }
    };

    // Lossless validation: convert user input to planck BigInt and compare
    // against the raw planck balance — no float intermediary.
    const isAmountValid = useMemo(() => {
        if (!amount || amount === "." || amount === "0") return false;
        try {
            const [intPart, fracPart = ""] = amount.split(".");
            const padded = fracPart.padEnd(18, "0").slice(0, 18);
            const userPlanck = BigInt((intPart || "0") + padded);
            return userPlanck > BigInt(0) && userPlanck <= BigInt(availablePlanck);
        } catch {
            return false;
        }
    }, [amount, availablePlanck]);

    return (
        <div className={cn("w-full max-w-[29rem] mx-auto", className)}>
            <div className="bg-white border border-grey-80 rounded-lg p-4">
                {/* Header */}
                <div className="text-center mb-6">
                    <h1 className="text-[1.375rem] font-semibold text-grey-10 mb-2">{title}</h1>
                    <p className="text-grey-50 text-base font-medium">{description}</p>
                </div>

                {/* Total hALPHA Staked */}
                {showStakedAmount && (
                    <>
                        {/* Total hALPHA Staked */}
                        <div className="bg-grey-80/40 p-4 rounded-lg mb-6">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-base font-medium">
                                    <Icons.MoneyTick className="size-4 text-grey-60" />
                                    <span className="text-grey-60">Total hALPHA Staked</span>
                                </div>
                                <span className="text-grey-10 font-medium text-sm">
                                    {stakingInfo.isLoading ? "Loading..." : `${formattedStakedAmount} hALPHA`}
                                </span>
                            </div>
                        </div>
                    </>
                )}

                {/* Amount Input */}
                <div className="mb-6">
                    <label className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium text-grey-70">{inputPlaceholder}</span>
                        <div className="flex items-center text-sm text-grey-20 font-medium">
                            <span>
                                {isUnstaking ? "Staked" : balanceLabel}:
                            </span>
                            <span className="ml-1">
                                {isUnstaking
                                    ? `${stakingInfo.bondedHip} hALPHA`
                                    : availableDisplay
                                }
                            </span>
                        </div>
                    </label>
                    <div className="relative">
                        <Input
                            type="text"
                            inputMode="decimal"
                            placeholder="0.00"
                            value={amount}
                            onChange={(e) => {
                                // Only allow digits and one decimal point
                                const value = e.target.value;
                                if (value === '' || /^\d*\.?\d*$/.test(value)) {
                                    setAmount(e.target.value);
                                }
                            }}
                            disabled={loading || stakingInfo.isLoading}
                            className={cn(
                                "w-full pr-16 text-lg",
                                !isAmountValid && amount ? "border-red-500" : ""
                            )}
                        />
                        <button
                            type="button"
                            onClick={handleMaxClick}
                            disabled={loading || stakingInfo.isLoading}
                            className="absolute right-3 top-1/2 transform -translate-y-1/2 text-primary-50 font-medium text-base hover:text-primary-40 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            MAX
                        </button>
                    </div>
                    {!isAmountValid && amount && (
                        <p className="text-red-500 text-xs mt-1">
                            {isUnstaking
                                ? "Amount exceeds staked balance"
                                : "Amount exceeds available balance"
                            }
                        </p>
                    )}
                </div>

                {/* Receive Amount (for Bridge) */}
                {showEstimateAndFees && (
                    <>
                        <div className="mb-6">
                            <div className="flex justify-center mb-4">
                                <div className="flex items-center w-full gap-4">
                                    <div className="h-0.5 flex-1 bg-gradient-to-l from-[#3167DD] to-transparent"></div>
                                    <AbstractIconWrapper className="size-8 @sm:size-10 text-primary-40">
                                        <Icons.ArrowDown className="absolute text-primary-40 size-4 @sm:size-5" />
                                    </AbstractIconWrapper>
                                    <div className="h-0.5 flex-1 bg-gradient-to-r from-[#3167DD] to-transparent"></div>
                                </div>
                            </div>
                            <label className="flex items-center justify-between mb-2">
                                <span className="text-sm font-medium text-grey-70">You Receive</span>
                                <div className="flex items-center text-sm text-grey-20 font-medium">
                                    <span>TAO Balance:</span>
                                    <span className="ml-1">0</span>
                                </div>
                            </label>
                            <Input
                                type="number"
                                placeholder="0.00"
                                value={amount}
                                disabled
                                className="w-full bg-grey-95 text-lg"
                            />
                        </div>

                        <div className="my-4 h-[1px] bg-grey-80"></div>

                        {/* Estimated Time and Gas Fees */}
                        <div className="bg-grey-80/40 p-4 rounded-lg mb-8">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-base font-medium">
                                    <Icons.EstimatedTime className="size-4 text-grey-60" />
                                    <span className="text-grey-60">Estimated Time</span>
                                </div>
                                <span className="text-grey-10 font-medium text-sm">{estimatedTime}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-base font-medium">
                                    <Icons.GasStation className="size-4 text-grey-60" />
                                    <span className="text-grey-60">Gas Fees</span>
                                </div>
                                <span className="text-grey-10 font-medium text-sm">{gasFees}</span>
                            </div>
                        </div>
                    </>
                )}

                {/* Submit Button */}
                <CardButton
                    className="w-full h-12"
                    onClick={handleSubmit}
                    disabled={!amount || !isAmountValid || stakingInfo.isLoading || loading}
                >
                    <div className="flex items-center gap-2">
                        <span className="text-lg font-medium">
                            {loading || stakingInfo.isLoading ? "Loading..." : buttonText}
                        </span>
                    </div>
                </CardButton>
            </div>
        </div>
    );
};

export default TokenForm;