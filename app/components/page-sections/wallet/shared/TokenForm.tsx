"use client";

import { FC, useState, useMemo, useEffect, ReactNode } from "react";
import { Input, CardButton, Icons, AbstractIconWrapper } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useStaking } from "@/app/lib/hooks/useStaking";
import { formatStakingAmount } from "@/app/lib/utils/staking";
import { formatPreciseBalance } from "@/app/lib/utils/formatters/formatPreciseBalance";

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
    isStaking?: boolean; // Prop to identify staking forms
    isUnstaking?: boolean; // Prop to identify unstaking forms
    loading?: boolean; // Prop for loading state
    isLoadingBalance?: boolean; // Prop for balance loading state
    resetForm?: boolean; // Prop to trigger form reset
    onFormReset?: () => void; // Callback when form is reset
    refetchOnSuccess?: boolean; // Prop to trigger refetch after successful operations
    decimals?: number; // Token decimals (default 18 for hAlpha, 9 for Alpha)
    minAmount?: string; // Minimum amount required (formatted string with symbol)
    initialAmount?: string; // Prefilled amount value
    destinationBalanceLabel?: string; // Label for destination token balance
    destinationBalanceAmount?: string; // Destination token balance (formatted string)
    isLoadingDestinationBalance?: boolean; // Loading state for destination balance
    onSwapDirection?: () => void; // Callback to swap bridge direction
    afterReceiveSlot?: ReactNode; // Optional slot rendered below "You Receive" input
    reserveForFees?: number; // Amount to reserve for transaction fees (in human-readable units)
}

const TokenForm: FC<TokenFormProps> = ({
    title,
    description,
    balanceLabel,
    balanceAmount,
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
    isLoadingBalance = false,
    resetForm = false,
    onFormReset,
    refetchOnSuccess = false,
    decimals = 18,
    minAmount,
    initialAmount = "",
    destinationBalanceLabel,
    destinationBalanceAmount,
    isLoadingDestinationBalance = false,
    onSwapDirection,
    afterReceiveSlot,
    reserveForFees = 0,
}) => {
    const [amount, setAmount] = useState(() => initialAmount);
    const { stakingInfo, refetch } = useStaking();

    // Handle form reset when resetForm prop changes
    useEffect(() => {
        if (resetForm) {
            setAmount("");
            onFormReset?.();

            // Refetch staking info if enabled
            if (refetchOnSuccess && typeof refetch === 'function') {
                refetch().catch(console.error);
            }
        }
    }, [resetForm, onFormReset, refetchOnSuccess, refetch]);

    useEffect(() => {
        if (!initialAmount) return;
        setAmount((currentAmount) => currentAmount || initialAmount);
    }, [initialAmount]);

    // Calculate available amounts based on operation type
    const availableAmount = useMemo(() => {
        if (isStaking) {
            // For staking, work with raw planck values to avoid precision loss
            const nativeBalancePlanck = BigInt(balanceAmount || '0');
            const result = Math.max(0, Number(nativeBalancePlanck) / 1e18);
            return result;
        } else if (isUnstaking) {
            // For unstaking, show only the staked amount
            return Number(stakingInfo.bonded || '0') / 1e18;
        }
        // For other operations (like bridge), use BigInt division to avoid precision loss
        // BigInt division gives integer result, then we convert to float for display
        const balancePlanck = BigInt(balanceAmount || '0');
        const divisor = BigInt(10 ** decimals);
        // Get integer part via BigInt division, then remainder for fractional part
        const integerPart = balancePlanck / divisor;
        const remainder = balancePlanck % divisor;
        // Convert to Number only after division (now safe since values are smaller)
        return Number(integerPart) + Number(remainder) / Number(divisor);
    }, [balanceAmount, stakingInfo.bonded, isStaking, isUnstaking, decimals]);

    // Format the staked amount for display
    const formattedStakedAmount = useMemo(() => {
        if (showStakedAmount) {
            return formatStakingAmount(stakingInfo.bonded);
        }
        return stakedAmount || "0.00";
    }, [showStakedAmount, stakingInfo.bonded, stakedAmount]);

    const handleSubmit = () => {
        onSubmit(amount);
    };

    const handleMaxClick = () => {
        // Reserve some balance for transaction fees if specified
        const maxAmount = Math.max(0, availableAmount - reserveForFees);
        setAmount(maxAmount.toString());
    };

    // Parse minimum amount from minAmount prop (e.g., "9.656704 hALPHA" -> 9.656704)
    const parsedMinAmount = useMemo(() => {
        if (!minAmount) return 0;
        const match = minAmount.match(/^([\d.]+)/);
        return match ? parseFloat(match[1]) : 0;
    }, [minAmount]);

    const isAmountBelowMinimum = useMemo(() => {
        if (!amount || parsedMinAmount === 0) return false;
        const numAmount = parseFloat(amount);
        return numAmount > 0 && numAmount < parsedMinAmount;
    }, [amount, parsedMinAmount]);

    const isAmountValid = useMemo(() => {
        const numAmount = parseFloat(amount);
        return numAmount > 0 && numAmount <= availableAmount && !isAmountBelowMinimum;
    }, [amount, availableAmount, isAmountBelowMinimum]);

    return (
        <div className={cn("md:min-w-[29rem] mx-auto", className)}>
            <div className="bg-white border border-grey-80 rounded-lg p-4">
                {/* Header */}
                <div className="text-center mb-6">
                    <h1 className="text-[22px] font-semibold text-grey-10 mb-2">{title}</h1>
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
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium text-grey-70">{inputPlaceholder}</span>
                        <div className="flex items-center text-sm text-grey-20 font-medium">
                            <span>
                                {isUnstaking ? "Staked" : balanceLabel}:
                            </span>
                            <span className="ml-1">
                                {isLoadingBalance ? (
                                    <span className="inline-flex items-center gap-1">
                                        <svg className="animate-spin h-3 w-3 text-primary-50" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        <span className="text-grey-50">Loading...</span>
                                    </span>
                                ) : isUnstaking
                                    ? `${formatStakingAmount(stakingInfo.bonded)} hALPHA`
                                    : formatPreciseBalance(availableAmount, 9)
                                }
                            </span>
                        </div>
                    </div>
                    <div className="relative">
                        <Input
                            type="text"
                            inputMode="decimal"
                            placeholder="0.00"
                            value={amount}
                            onChange={(e) => {
                                // Only allow numbers and decimal point, max 9 decimal places
                                const value = e.target.value;
                                if (value === '' || /^\d*\.?\d{0,9}$/.test(value)) {
                                    setAmount(value);
                                }
                            }}
                            onKeyDown={(e) => {
                                // Prevent e, +, -, etc.
                                if (['e', 'E', '+', '-', '^'].includes(e.key)) {
                                    e.preventDefault();
                                }
                            }}
                            disabled={loading || stakingInfo.isLoading}
                            className={cn(
                                "w-full pr-16 text-base bg-grey-100 border border-grey-80",
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
                            {isAmountBelowMinimum
                                ? `Amount below minimum (${minAmount})`
                                : isUnstaking
                                    ? "Amount exceeds staked balance"
                                    : "Amount exceeds available balance"
                            }
                        </p>
                    )}
                    {minAmount && (
                        <p className="text-grey-50 text-xs mt-1.5 flex items-center gap-1">
                            <span>Minimum: <span className="text-primary-50 font-medium">{minAmount}</span></span>
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
                                    {onSwapDirection ? (
                                        <button
                                            type="button"
                                            onClick={onSwapDirection}
                                            className="group relative transition-transform hover:scale-110 active:scale-95"
                                            title="Swap direction"
                                        >
                                            <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40 group-hover:text-primary-30 transition-colors">
                                                <svg
                                                    className="absolute text-primary-40 group-hover:text-primary-30 size-4 sm:size-5 transition-colors"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="2"
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                >
                                                    <path d="M7 16V4M7 4L3 8M7 4L11 8" />
                                                    <path d="M17 8V20M17 20L21 16M17 20L13 16" />
                                                </svg>
                                            </AbstractIconWrapper>
                                        </button>
                                    ) : (
                                        <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
                                            <Icons.ArrowDown className="absolute text-primary-40 size-4 sm:size-5" />
                                        </AbstractIconWrapper>
                                    )}
                                    <div className="h-0.5 flex-1 bg-gradient-to-r from-[#3167DD] to-transparent"></div>
                                </div>
                            </div>
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-sm font-medium text-grey-70">You Receive</span>
                                <div className="flex items-center text-sm text-grey-20 font-medium">
                                    <span>{destinationBalanceLabel || 'Balance'}:</span>
                                    <span className="ml-1">
                                        {isLoadingDestinationBalance ? (
                                            <span className="inline-flex items-center gap-1">
                                                <svg className="animate-spin h-3 w-3 text-primary-50" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                                </svg>
                                                <span className="text-grey-50">Loading...</span>
                                            </span>
                                        ) : (
                                            destinationBalanceAmount || '0'
                                        )}
                                    </span>
                                </div>
                            </div>
                            <Input
                                type="number"
                                placeholder="0.00"
                                value={amount}
                                disabled
                                className="w-full text-base bg-grey-100 border border-grey-80 text-grey-60"
                            />
                        </div>

                        {afterReceiveSlot && (
                            <div className="mt-4">{afterReceiveSlot}</div>
                        )}

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