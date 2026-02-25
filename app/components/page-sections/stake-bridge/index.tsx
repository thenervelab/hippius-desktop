"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { BackButton, Icons } from "@/components/ui";
import TabList, { TabOption } from "@/components/ui/tabs/TabList";
import TokenForm from "../wallet/shared/TokenForm";
import { toast } from "sonner";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import { useStaking } from "@/app/lib/hooks/useStaking";
import { toPlancks } from "@/app/lib/utils/staking";
import StakeConfirmationDialog from "../wallet/StakeConfirmationDialog";
import BridgeConfirmationDialog from "../wallet/BridgeConfirmationDialog";
import { BN } from "@polkadot/util";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { LocalWalletSelector, AddWalletDialog, LocalWalletSetup } from "../wallet/local-wallet";
import { useHippiusBalance } from "@/app/lib/hooks/api/useHippiusBalance";
import { useBridge } from "@/app/lib/hooks/useBridge";
import { BridgeStatusWidget } from "../wallet/BridgeStatusWidget";
import { BRIDGE_CONFIG } from "@/app/lib/bridge/config";
import type { BridgeDirection } from "@/app/lib/bridge/types";

// Helper function to parse bridge error messages into user-friendly text
const parseBridgeError = (error: string | Error | unknown): string => {
    const errorStr = error instanceof Error ? error.message : String(error || '');
    
    // Check for Payment/Insufficient balance errors
    if (errorStr.includes('"type":"Payment"') || errorStr.includes('"type": "Payment"') || errorStr.toLowerCase().includes('payment')) {
        return 'Insufficient TAO balance to pay transaction fees. Please add TAO to your Bittensor wallet.';
    }
    
    // Check for proxy-related errors
    if (errorStr.toLowerCase().includes('proxy') && errorStr.toLowerCase().includes('invalid')) {
        return 'Failed to add escrow proxy. Please ensure you have enough TAO for gas fees.';
    }
    
    // Check for Invalid transaction errors
    if (errorStr.includes('"type":"Invalid"') || errorStr.includes('"type": "Invalid"')) {
        return 'Transaction failed. Please ensure you have enough TAO for gas fees and try again.';
    }
    
    // Check for timeout errors
    if (errorStr.toLowerCase().includes('timeout')) {
        return 'Transaction timed out. Please try again.';
    }
    
    // Check for user rejection
    if (errorStr.toLowerCase().includes('rejected') || errorStr.toLowerCase().includes('cancelled') || errorStr.toLowerCase().includes('canceled')) {
        return 'Transaction was cancelled by user.';
    }
    
    // Return original if no specific parsing needed, but clean up JSON formatting
    if (errorStr.startsWith('{') || errorStr.startsWith('[')) {
        return 'Transaction failed. Please try again or check your wallet balance.';
    }
    
    return errorStr || 'An unknown error occurred';
};

const StakeBridge = () => {
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const tabParam = searchParams.get("tab");
    const { stakingInfo, operations } = useStaking();
    const { setupStep, activeWallet } = useLocalWallet();
    // balanceInfo used for staking tab (available balance calculation)
    const { data: balanceInfo } = useHippiusBalance();

    // Add wallet dialog state
    const [showAddWalletDialog, setShowAddWalletDialog] = useState(false);

    // Form reset triggers
    const [resetFormTrigger, setResetFormTrigger] = useState(false);
    const [resetBridgeFormTrigger, setResetBridgeFormTrigger] = useState(false);

    // Set initial tab based on URL parameter or pathname
    // If on /bridge route, default to bridge tab
    const [activeTab, setActiveTab] = useState(() => {
        if (tabParam === "bridge" || pathname === "/bridge") {
            return "Bridge";
        }
        return "Stake";
    });

    const [isLoading, setIsLoading] = useState(false);
    const [showConfirmation, setShowConfirmation] = useState(false);
    const [pendingAmount, setPendingAmount] = useState("");

    // Bridge state
    const bridge = useBridge();
    const [bridgeDirection, setBridgeDirection] = useState<BridgeDirection>('alpha-to-halpha');
    const [isBridgeLoading, setIsBridgeLoading] = useState(false);
    const [showBridgeConfirmation, setShowBridgeConfirmation] = useState(false);
    const [pendingBridgeAmount, setPendingBridgeAmount] = useState("");

    // Update URL when tab changes - navigate to appropriate route
    useEffect(() => {
        if (activeTab === "Bridge") {
            router.replace("/bridge", { scroll: false });
        } else {
            router.replace("/stake", { scroll: false });
        }
    }, [activeTab, router]);

    const tabs: TabOption[] = [
        {
            tabName: "Stake",
            icon: <Icons.MoneyReceive className="size-4" />,
        },
        {
            tabName: "Bridge",
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

    // Form reset handlers
    const handleFormReset = useCallback(() => {
        setResetFormTrigger(false);
    }, []);

    const handleBridgeFormReset = useCallback(() => {
        setResetBridgeFormTrigger(false);
    }, []);

    // Toggle bridge direction
    const handleSwapBridgeDirection = useCallback(() => {
        setBridgeDirection(prev => prev === 'alpha-to-halpha' ? 'halpha-to-alpha' : 'alpha-to-halpha');
    }, []);

    // ========================================================================
    // BALANCE SOURCES - Single source of truth from useBridge hook
    // 
    // useBridge connects to:
    // - Hippius: wss://hippius-testnet.starkleytech.com (for hAlpha balance)
    // - Bittensor: wss://test.finney.opentensor.ai (for Alpha balance)
    //
    // This ensures consistent balances for the active wallet address.
    // ========================================================================

    // Get the hAlpha balance from useBridge (connects to Hippius testnet)
    const hAlphaBalancePlanck = useMemo(() => {
        return bridge.hAlphaBalance ?? BigInt(0);
    }, [bridge.hAlphaBalance]);

    // Get the Alpha balance from useBridge (connects to Bittensor testnet)
    const alphaBalancePlanck = useMemo(() => {
        return bridge.alphaStakeBalance ?? bridge.alphaBalance ?? BigInt(0);
    }, [bridge.alphaStakeBalance, bridge.alphaBalance]);

    // Helper function to safely convert BigInt to human-readable number
    // Uses BigInt division to avoid precision loss for values exceeding MAX_SAFE_INTEGER
    const bigIntToHuman = (value: bigint, decimals: number): number => {
        const divisor = BigInt(10 ** decimals);
        const integerPart = value / divisor;
        const remainder = value % divisor;
        return Number(integerPart) + Number(remainder) / Number(divisor);
    };

    // Helper function to convert decimal string to planck BigInt without Number precision loss
    // e.g., "15.5" with 18 decimals -> 15500000000000000000n
    const decimalToPlanck = (amountStr: string, decimals: number): bigint => {
        const parts = amountStr.split('.');
        const integerPart = parts[0] || '0';
        let decimalPart = parts[1] || '';

        // Pad or truncate decimal part to match decimals
        if (decimalPart.length > decimals) {
            decimalPart = decimalPart.slice(0, decimals);
        } else {
            decimalPart = decimalPart.padEnd(decimals, '0');
        }

        // Combine as a single number string and convert to BigInt
        const combined = integerPart + decimalPart;
        return BigInt(combined);
    };

    // Handle bridge form submit - show confirmation dialog
    const handleBridgeSubmit = async (amount?: string) => {
        if (!amount || parseFloat(amount) <= 0) {
            toast.error("Please enter a valid amount to bridge");
            return;
        }

        if (!activeWallet) {
            toast.error("Please select a wallet account to bridge");
            return;
        }

        // Reserve enough for tx fees (~0.01) + existential deposit (~0.1) + buffer
        // Substrate chains require accounts to maintain a minimum balance (existential deposit)
        const feeReserve = bridgeDirection === 'halpha-to-alpha' ? 0.5 : 0.05;

        // Use BigInt arithmetic to avoid JavaScript Number precision loss
        // (hAlpha has 18 decimals which exceeds Number.MAX_SAFE_INTEGER)
        if (bridgeDirection === 'halpha-to-alpha') {
            const decimals = BRIDGE_CONFIG.tokens.hAlpha.decimals; // 18
            // Convert user amount to planck using string parsing (avoids Number overflow)
            const amountPlanck = decimalToPlanck(amount, decimals);
            const feeReservePlanck = decimalToPlanck(feeReserve.toString(), decimals);

            // Use hAlphaBalancePlanck from useBridge (connects to Hippius testnet)
            const balancePlanck = hAlphaBalancePlanck;

            // Convert to human-readable for display
            const balanceHuman = bigIntToHuman(balancePlanck, 18);
            const amountHuman = parseFloat(amount);

            console.log('[Bridge] hAlpha→Alpha validation:', {
                activeWallet: activeWallet?.address,
                balanceHuman: balanceHuman.toFixed(4),
                amountHuman,
                feeReserve,
                totalNeeded: amountHuman + feeReserve,
                hasEnough: balanceHuman >= amountHuman + feeReserve,
            });

            // Safety check: if balance is 0 but loading, wait for it
            if (balancePlanck === BigInt(0) && bridge.isLoading) {
                toast.error("Balance is still loading. Please wait a moment and try again.");
                return;
            }

            if (amountPlanck + feeReservePlanck > balancePlanck) {
                toast.error(`Insufficient hALPHA balance. You have ${balanceHuman.toFixed(4)} hALPHA but need ${(amountHuman + feeReserve).toFixed(4)} hALPHA (including ${feeReserve} for fees).`);
                return;
            }
        } else {
            const decimals = BRIDGE_CONFIG.tokens.alpha.decimals; // 9
            const amountPlanck = decimalToPlanck(amount, decimals);

            // Use alphaBalancePlanck (from useBridge - Bittensor chain)
            const balancePlanck = alphaBalancePlanck;
            const balanceHuman = Number(balancePlanck) / 1e9;
            const amountHuman = parseFloat(amount);

            console.log('[Bridge] Alpha→hAlpha validation:', {
                activeWallet: activeWallet?.address,
                balanceHuman: balanceHuman.toFixed(4),
                amountHuman,
                hasEnough: balanceHuman >= amountHuman,
            });

            if (amountPlanck > balancePlanck) {
                toast.error(`Insufficient ALPHA balance. You have ${balanceHuman.toFixed(4)} ALPHA but need ${amountHuman.toFixed(4)} ALPHA.`);
                return;
            }
        }

        // Validate against minimum for both directions
        if (bridgeDirection === 'halpha-to-alpha' && bridge.minHAlphaTransfer) {
            const amountInPlanck = decimalToPlanck(amount, BRIDGE_CONFIG.tokens.hAlpha.decimals);
            if (amountInPlanck < bridge.minHAlphaTransfer) {
                const minFormatted = (Number(bridge.minHAlphaTransfer) / 1e18).toFixed(6);
                toast.error(`Minimum bridge amount is ${minFormatted} hALPHA`);
                return;
            }
        } else if (bridgeDirection === 'alpha-to-halpha' && bridge.minAlphaTransfer) {
            const amountInPlanck = decimalToPlanck(amount, BRIDGE_CONFIG.tokens.alpha.decimals);
            if (amountInPlanck < bridge.minAlphaTransfer) {
                const minFormatted = (Number(bridge.minAlphaTransfer) / 1e9).toFixed(6);
                toast.error(`Minimum bridge amount is ${minFormatted} ALPHA`);
                return;
            }
        }

        // Show confirmation dialog
        setPendingBridgeAmount(amount);
        setShowBridgeConfirmation(true);
    };

    // Handle bridge confirmation
    const handleConfirmBridge = async (mnemonic: string) => {
        setShowBridgeConfirmation(false);
        setIsBridgeLoading(true);
        bridge.clearBridgeSteps();

        try {
            // Convert amount to planck (18 decimals for hAlpha, 9 for Alpha)
            const decimals = bridgeDirection === 'halpha-to-alpha'
                ? BRIDGE_CONFIG.tokens.hAlpha.decimals
                : BRIDGE_CONFIG.tokens.alpha.decimals;
            const amountInPlanck = BigInt(Math.floor(parseFloat(pendingBridgeAmount) * Math.pow(10, decimals)));

            toast.info(
                bridgeDirection === 'alpha-to-halpha'
                    ? "Initiating Bridge... Follow the progress steps below."
                    : "Initiating Bridge... Please wait."
            );

            let result;
            if (bridgeDirection === 'halpha-to-alpha') {
                result = await bridge.bridgeHAlphaToAlpha({ amount: amountInPlanck, mnemonic });
            } else {
                result = await bridge.bridgeAlphaToHAlpha({ amount: amountInPlanck, mnemonic });
            }

            if (result.success) {
                toast.success("Bridge Initiated! Guardians will process it - this may take a few minutes.");
                // Reset the form after successful submission
                setResetBridgeFormTrigger(true);
            } else {
                toast.error(parseBridgeError(result.error || "Bridge failed"));
            }
        } catch (error) {
            console.error("Bridge failed:", error);
            toast.error(parseBridgeError(error));
        } finally {
            setIsBridgeLoading(false);
            setPendingBridgeAmount("");
        }
    };

    const handleCloseBridgeConfirmation = () => {
        setShowBridgeConfirmation(false);
        setPendingBridgeAmount("");
    };

    // Get bridge SOURCE balance based on direction (what the user is sending)
    const bridgeBalance = useMemo(() => {
        if (bridgeDirection === 'halpha-to-alpha') {
            // Sending hAlpha - use the consistent hAlpha source
            return hAlphaBalancePlanck.toString();
        } else {
            // Sending Alpha - use the consistent Alpha source
            return alphaBalancePlanck.toString();
        }
    }, [bridgeDirection, hAlphaBalancePlanck, alphaBalancePlanck]);

    // Helper function to format balance
    const formatBalanceDisplay = (value: number, decimals: number = 9): string => {
        if (value === 0) return '0';
        return value.toFixed(decimals);
    };

    // Get DESTINATION balance based on direction (what the user will receive on the other chain)
    const destinationBalance = useMemo(() => {
        if (bridgeDirection === 'halpha-to-alpha') {
            // Receiving Alpha on Bittensor - use Alpha source (9 decimals)
            const value = Number(alphaBalancePlanck) / 1e9;
            return formatBalanceDisplay(value, 9);
        } else {
            // Receiving hAlpha on Hippius - use hAlpha source (18 decimals)
            const value = bigIntToHuman(hAlphaBalancePlanck, 18);
            return formatBalanceDisplay(value, 9);
        }
    }, [bridgeDirection, hAlphaBalancePlanck, alphaBalancePlanck]);

    // Get destination balance label based on direction
    const destinationBalanceLabel = useMemo(() => {
        return bridgeDirection === 'halpha-to-alpha' ? 'ALPHA Balance' : 'hALPHA Balance';
    }, [bridgeDirection]);

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
                {activeTab === "Stake" && (
                    <div className="flex flex-col items-center">
                        <TokenForm
                            title="Stake"
                            description="Stake your hAlpha tokens on Hippius"
                            balanceLabel="Available Balance"
                            balanceAmount={availableBalance}
                            inputPlaceholder="Enter Amount to Stake"
                            buttonText={isLoading ? "Staking..." : "Stake Now"}
                            onSubmit={handleStakeSubmit}
                            showStakedAmount
                            isStaking={true}
                            loading={isLoading}
                            isLoadingBalance={stakingInfo.isLoading}
                            resetForm={resetFormTrigger}
                            onFormReset={handleFormReset}
                            refetchOnSuccess={true}
                        />
                    </div>
                )}

                {activeTab === "Bridge" && (
                    <div className="flex flex-col items-center">
                        <TokenForm
                            title={bridgeDirection === 'halpha-to-alpha' ? "Bridge to Alpha" : "Bridge to hAlpha"}
                            description={bridgeDirection === 'halpha-to-alpha'
                                ? "Bridge your tokens from Hippius to Bittensor"
                                : "Bridge your tokens from Bittensor to Hippius"
                            }
                            balanceLabel={bridgeDirection === 'halpha-to-alpha' ? "hALPHA Balance" : "ALPHA Balance"}
                            balanceAmount={bridgeBalance}
                            inputPlaceholder="You Send"
                            buttonText={isBridgeLoading ? "Bridging..." : "Bridge Now"}
                            onSubmit={handleBridgeSubmit}
                            showEstimateAndFees={true}
                            estimatedTime={`~${BRIDGE_CONFIG.timing.estimatedTimeSeconds} Seconds`}
                            gasFees={`~${(BRIDGE_CONFIG.fees.feePercentage * 100).toFixed(1)}% Fee`}
                            loading={isBridgeLoading}
                            isLoadingBalance={bridge.isLoading}
                            decimals={bridgeDirection === 'halpha-to-alpha' ? BRIDGE_CONFIG.tokens.hAlpha.decimals : BRIDGE_CONFIG.tokens.alpha.decimals}
                            minAmount={
                                bridgeDirection === 'halpha-to-alpha'
                                    ? (bridge.minHAlphaTransfer !== null && bridge.minHAlphaTransfer > BigInt(0)
                                        ? `${(Number(bridge.minHAlphaTransfer) / 1e18).toFixed(6)} hALPHA`
                                        : undefined)
                                    : (bridge.minAlphaTransfer !== null && bridge.minAlphaTransfer > BigInt(0)
                                        ? `${(Number(bridge.minAlphaTransfer) / 1e9).toFixed(6)} ALPHA`
                                        : undefined)
                            }
                            destinationBalanceLabel={destinationBalanceLabel}
                            destinationBalanceAmount={destinationBalance}
                            isLoadingDestinationBalance={bridge.isLoading}
                            resetForm={resetBridgeFormTrigger}
                            onFormReset={handleBridgeFormReset}
                            onSwapDirection={handleSwapBridgeDirection}
                            reserveForFees={bridgeDirection === 'halpha-to-alpha' ? 0.5 : 0.05}
                        />
                    </div>
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

            {/* Bridge Confirmation Dialog */}
            <BridgeConfirmationDialog
                open={showBridgeConfirmation}
                onClose={handleCloseBridgeConfirmation}
                onConfirm={handleConfirmBridge}
                loading={isBridgeLoading}
                amount={pendingBridgeAmount}
                direction={bridgeDirection}
            />

            {/* Bridge Status Widget - only shown on Bridge tab */}
            {activeTab === "Bridge" && (
                <BridgeStatusWidget
                    className="right-4 left-auto"
                    isBridgeInProgress={isBridgeLoading}
                    bridgeSteps={bridge.bridgeSteps}
                    clearBridgeSteps={bridge.clearBridgeSteps}
                    walletAddress={activeWallet?.address}
                    bridgeDirection={bridgeDirection}
                />
            )}

            {/* Add Wallet Dialog */}
            <AddWalletDialog
                open={showAddWalletDialog}
                onClose={() => setShowAddWalletDialog(false)}
            />
        </>
    );
};

export default StakeBridge;