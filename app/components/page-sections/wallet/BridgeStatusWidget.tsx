"use client";

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    ArrowRight,
    Loader2,
    CheckCircle2,
    XCircle,
    Clock,
    AlertTriangle,
    ChevronDown,
    ChevronUp,
    RefreshCw,
    ArrowDownToLine,
    ArrowUpFromLine,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { cn } from "@/app/lib/utils";
import {
    fetchExplorerData,
    getDepositStatus,
    getWithdrawalStatus,
    truncId,
    isStaleTransaction,
    type DepositView,
    type WithdrawalView,
    type BridgeExplorerStatus,
} from "@/app/lib/bridge/explorer-api";
import type { BridgeStep, BridgeStepState } from "@/app/lib/bridge/service";
import { BRIDGE_CONFIG } from "@/app/lib/bridge/config";
import type { BridgeDirection } from "@/app/lib/bridge/types";
import {
    mergeAndPersist,
    getCachedTransactions,
    type CachedDeposit,
    type CachedWithdrawal,
} from "@/app/lib/bridge/local-cache";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BridgeStatusWidgetProps {
    className?: string;
    /** Show widget when bridge operation is in progress */
    isBridgeInProgress?: boolean;
    /** Wizard step progress for active bridge operation */
    bridgeSteps?: BridgeStep[];
    /** Callback to clear wizard steps after dismissal */
    clearBridgeSteps?: () => void;
    /** Active wallet SS58 address — used to filter transactions for this wallet only */
    walletAddress?: string | null;
    /** Current bridge direction — used to show wizard in correct tab */
    bridgeDirection?: BridgeDirection;
}

// ---------------------------------------------------------------------------
// Status badge configs
// ---------------------------------------------------------------------------

const statusConfig: Record<
    BridgeExplorerStatus,
    { icon: React.ReactNode; color: string; bg: string; label: string }
> = {
    pending: {
        icon: <Clock className="w-3.5 h-3.5" />,
        color: "text-yellow-400",
        bg: "bg-yellow-500/20",
        label: "Pending",
    },
    processing: {
        icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
        color: "text-blue-400",
        bg: "bg-blue-500/20",
        label: "Processing",
    },
    completed: {
        icon: <CheckCircle2 className="w-3.5 h-3.5" />,
        color: "text-green-400",
        bg: "bg-green-500/20",
        label: "Completed",
    },
    failed: {
        icon: <XCircle className="w-3.5 h-3.5" />,
        color: "text-red-400",
        bg: "bg-red-500/20",
        label: "Failed",
    },
};

// Chain-level status badge (Requested, Completed, Locked, Pending, etc.)
function ChainStatusBadge({ status }: { status: string }) {
    const lower = status.toLowerCase();
    const color =
        lower === "completed" || lower === "locked" || lower === "burned"
            ? "text-green-400 bg-green-500/20"
            : lower === "failed" || lower === "denied" || lower === "expired"
                ? "text-red-400 bg-red-500/20"
                : lower === "pending" || lower === "requested"
                    ? "text-yellow-400 bg-yellow-500/20"
                    : "text-gray-400 bg-gray-500/20";

    return (
        <span
            className={cn(
                "px-1.5 py-0.5 text-[10px] font-medium rounded",
                color,
            )}
        >
            {status}
        </span>
    );
}

// Vote progress display
function VoteProgress({
    voteCount,
    threshold,
}: {
    voteCount: number;
    threshold: number;
}) {
    return (
        <span
            className={cn(
                "text-[10px] font-mono",
                voteCount >= threshold ? "text-green-400" : "text-gray-400",
            )}
        >
            {voteCount}/{threshold}
        </span>
    );
}

// ---------------------------------------------------------------------------
// Stable block-time anchor
// ---------------------------------------------------------------------------

interface BlockAnchor {
    height: number;
    capturedAt: number;
}

function useBlockAnchor(currentHeight: number): BlockAnchor | null {
    const ref = React.useRef<BlockAnchor | null>(null);

    if (currentHeight > 0) {
        if (!ref.current) {
            ref.current = { height: currentHeight, capturedAt: Date.now() };
        } else if (currentHeight - ref.current.height >= 10) {
            ref.current = { height: currentHeight, capturedAt: Date.now() };
        }
    }
    return ref.current;
}

function blockToTimestamp(createdAtBlock: string, anchor: BlockAnchor | null): number {
    if (!anchor) return 0;
    const blockNum = parseInt(createdAtBlock, 10);
    if (!blockNum || blockNum <= 0) return 0;
    const blockDelta = anchor.height - blockNum;
    if (blockDelta < 0) return anchor.capturedAt;
    return anchor.capturedAt - blockDelta * 6000;
}

function RelativeTime({ date }: { date: number }) {
    const [, setTick] = React.useState(0);

    React.useEffect(() => {
        const id = setInterval(() => setTick((t) => t + 1), 15_000);
        return () => clearInterval(id);
    }, []);

    const seconds = Math.max(0, Math.round((Date.now() - date) / 1000));
    let label: string;
    if (seconds < 60) label = `${seconds}s ago`;
    else if (seconds < 3600) label = `${Math.floor(seconds / 60)}m ago`;
    else if (seconds < 86400) label = `${Math.floor(seconds / 3600)}h ago`;
    else label = `${Math.floor(seconds / 86400)}d ago`;

    return <>{label}</>;
}

// ---------------------------------------------------------------------------
// Deposit Card
// ---------------------------------------------------------------------------

function DepositCard({
    deposit,
    threshold,
    isExpanded,
    onToggle,
    currentHippiusHeight,
    blockAnchor,
}: {
    deposit: DepositView;
    threshold: number;
    isExpanded: boolean;
    onToggle: () => void;
    currentHippiusHeight: number;
    blockAnchor: BlockAnchor | null;
}) {
    const overallStatus = getDepositStatus(deposit, currentHippiusHeight);
    const isStale = currentHippiusHeight > 0 && isStaleTransaction(deposit.createdAtBlock, currentHippiusHeight);
    const cfg = statusConfig[overallStatus];
    const displayLabel = isStale && overallStatus === 'failed' && deposit.status.toLowerCase() !== 'denied' && deposit.status.toLowerCase() !== 'expired' ? 'Timed Out' : cfg.label;
    const estimatedTime = blockToTimestamp(deposit.createdAtBlock, blockAnchor);

    return (
        <div
            className={cn(
                "rounded-lg border transition-colors",
                overallStatus === "completed"
                    ? "border-green-500/30 bg-green-500/5"
                    : overallStatus === "failed"
                        ? "border-red-500/30 bg-red-500/5"
                        : overallStatus === "processing"
                            ? "border-blue-500/30 bg-blue-500/5"
                            : "border-gray-700 bg-white/[0.02]",
            )}
        >
            <button
                onClick={onToggle}
                className="w-full flex items-center justify-between px-3 py-2.5 text-left"
            >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div className={cn("flex-shrink-0", cfg.color)}>{cfg.icon}</div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                            <ArrowDownToLine className="w-3 h-3 text-blue-400 flex-shrink-0" />
                            <span className="text-sm font-semibold text-white">
                                {deposit.amountDisplay}
                            </span>
                            <span className="text-xs text-gray-500">{BRIDGE_CONFIG.tokens.alpha.symbol}</span>
                            <ArrowRight className="w-3 h-3 text-gray-600 flex-shrink-0" />
                            <span className="text-xs text-gray-400">{BRIDGE_CONFIG.tokens.hAlpha.symbol}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                            <span className={cn("px-1.5 py-0.5 text-[10px] font-medium rounded", cfg.bg, cfg.color)}>
                                {displayLabel}
                            </span>
                            <VoteProgress voteCount={deposit.voteCount} threshold={threshold} />
                            {deposit.bittensorSide && (
                                <span className="text-[10px] text-gray-500">
                                    Bittensor: <ChainStatusBadge status={deposit.bittensorSide.status === 'Requested' ? 'Locked' : deposit.bittensorSide.status} />
                                </span>
                            )}
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    {estimatedTime > 0 && (
                        <span className="text-[10px] text-gray-500 whitespace-nowrap">
                            <RelativeTime date={estimatedTime} />
                        </span>
                    )}
                    {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
                </div>
            </button>

            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        <div className="px-3 pb-3 pt-0 space-y-2 border-t border-gray-800/50">
                            <div className="flex items-center justify-between pt-2">
                                <span className="text-[10px] text-gray-500 uppercase tracking-wider">Request ID</span>
                                <span className="text-[10px] text-gray-300 font-mono">{truncId(deposit.requestId)}</span>
                            </div>
                            <div className="rounded bg-white/[0.03] p-2 space-y-1">
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-gray-500 font-medium">{BRIDGE_CONFIG.hippius.name}</span>
                                    <ChainStatusBadge status={deposit.status} />
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-gray-500">Recipient</span>
                                    <span className="text-[10px] text-gray-300 font-mono">{truncId(deposit.recipient)}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-gray-500">Block</span>
                                    <span className="text-[10px] text-gray-300 font-mono">{deposit.createdAtBlock}</span>
                                </div>
                            </div>
                            {deposit.bittensorSide && (
                                <div className="rounded bg-white/[0.03] p-2 space-y-1">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[10px] text-gray-500 font-medium">{BRIDGE_CONFIG.bittensor.name}</span>
                                        <ChainStatusBadge status={deposit.bittensorSide.status === 'Requested' ? 'Locked' : deposit.bittensorSide.status} />
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="text-[10px] text-gray-500">Sender</span>
                                        <span className="text-[10px] text-gray-300 font-mono">{truncId(deposit.bittensorSide.sender)}</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Withdrawal Card
// ---------------------------------------------------------------------------

function WithdrawalCard({
    withdrawal,
    threshold,
    isExpanded,
    onToggle,
    currentHippiusHeight,
    blockAnchor,
}: {
    withdrawal: WithdrawalView;
    threshold: number;
    isExpanded: boolean;
    onToggle: () => void;
    currentHippiusHeight: number;
    blockAnchor: BlockAnchor | null;
}) {
    const overallStatus = getWithdrawalStatus(withdrawal, currentHippiusHeight);
    const isStale = currentHippiusHeight > 0 && isStaleTransaction(withdrawal.createdAtBlock, currentHippiusHeight);
    const cfg = statusConfig[overallStatus];
    const displayLabel = isStale && overallStatus === 'failed' && withdrawal.status.toLowerCase() !== 'denied' && withdrawal.status.toLowerCase() !== 'expired' ? 'Timed Out' : cfg.label;
    const btVotes = withdrawal.bittensorSide?.voteCount ?? 0;
    const estimatedTime = blockToTimestamp(withdrawal.createdAtBlock, blockAnchor);

    return (
        <div
            className={cn(
                "rounded-lg border transition-colors",
                overallStatus === "completed"
                    ? "border-green-500/30 bg-green-500/5"
                    : overallStatus === "failed"
                        ? "border-red-500/30 bg-red-500/5"
                        : overallStatus === "processing"
                            ? "border-blue-500/30 bg-blue-500/5"
                            : "border-gray-700 bg-white/[0.02]",
            )}
        >
            <button
                onClick={onToggle}
                className="w-full flex items-center justify-between px-3 py-2.5 text-left"
            >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div className={cn("flex-shrink-0", cfg.color)}>{cfg.icon}</div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                            <ArrowUpFromLine className="w-3 h-3 text-orange-400 flex-shrink-0" />
                            <span className="text-sm font-semibold text-white">{withdrawal.amountDisplay}</span>
                            <span className="text-xs text-gray-500">{BRIDGE_CONFIG.tokens.hAlpha.symbol}</span>
                            <ArrowRight className="w-3 h-3 text-gray-600 flex-shrink-0" />
                            <span className="text-xs text-gray-400">{BRIDGE_CONFIG.tokens.alpha.symbol}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                            <span className={cn("px-1.5 py-0.5 text-[10px] font-medium rounded", cfg.bg, cfg.color)}>
                                {displayLabel}
                            </span>
                            <VoteProgress voteCount={btVotes} threshold={threshold} />
                            <span className="text-[10px] text-gray-500">
                                Hippius: <ChainStatusBadge status={
                                    withdrawal.status.toLowerCase() === 'requested' && withdrawal.bittensorSide?.status?.toLowerCase() === 'completed'
                                        ? 'Burned'
                                        : withdrawal.status
                                } />
                            </span>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    {estimatedTime > 0 && (
                        <span className="text-[10px] text-gray-500 whitespace-nowrap">
                            <RelativeTime date={estimatedTime} />
                        </span>
                    )}
                    {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
                </div>
            </button>

            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        <div className="px-3 pb-3 pt-0 space-y-2 border-t border-gray-800/50">
                            <div className="flex items-center justify-between pt-2">
                                <span className="text-[10px] text-gray-500 uppercase tracking-wider">Request ID</span>
                                <span className="text-[10px] text-gray-300 font-mono">{truncId(withdrawal.requestId)}</span>
                            </div>
                            <div className="rounded bg-white/[0.03] p-2 space-y-1">
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-gray-500 font-medium">Hippius Chain</span>
                                    <ChainStatusBadge status={
                                        withdrawal.status.toLowerCase() === 'requested' && withdrawal.bittensorSide?.status?.toLowerCase() === 'completed'
                                            ? 'Burned'
                                            : withdrawal.status
                                    } />
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-gray-500">Sender</span>
                                    <span className="text-[10px] text-gray-300 font-mono">{truncId(withdrawal.sender)}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-gray-500">Block</span>
                                    <span className="text-[10px] text-gray-300 font-mono">{withdrawal.createdAtBlock}</span>
                                </div>
                            </div>
                            {withdrawal.bittensorSide && (
                                <div className="rounded bg-white/[0.03] p-2 space-y-1">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[10px] text-gray-500 font-medium">Bittensor Chain</span>
                                        <ChainStatusBadge status={withdrawal.bittensorSide.status} />
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="text-[10px] text-gray-500">Amount</span>
                                        <span className="text-[10px] text-gray-300">{withdrawal.bittensorSide.amountDisplay} {BRIDGE_CONFIG.tokens.alpha.symbol}</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="text-[10px] text-gray-500">Votes</span>
                                        <VoteProgress voteCount={withdrawal.bittensorSide.voteCount} threshold={threshold} />
                                    </div>
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Wizard Steps
// ---------------------------------------------------------------------------

const wizardStepStateConfig: Record<
    BridgeStepState,
    { icon: React.ReactNode; color: string; bg: string }
> = {
    pending: {
        icon: <Clock className="w-3.5 h-3.5 text-gray-500" />,
        color: "text-gray-500",
        bg: "bg-gray-500/10",
    },
    active: {
        icon: <Loader2 className="w-3.5 h-3.5 text-[#9333EA] animate-spin" />,
        color: "text-[#9333EA]",
        bg: "bg-[#9333EA]/10",
    },
    done: {
        icon: <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />,
        color: "text-green-400",
        bg: "bg-green-500/10",
    },
    error: {
        icon: <XCircle className="w-3.5 h-3.5 text-red-400" />,
        color: "text-red-400",
        bg: "bg-red-500/10",
    },
};

function WizardSteps({
    steps,
    onDismiss,
}: {
    steps: BridgeStep[];
    onDismiss?: () => void;
}) {
    if (steps.length === 0) return null;

    const allDone = steps.every((s) => s.state === "done" || s.state === "error");
    const hasError = steps.some((s) => s.state === "error");

    return (
        <div
            className={cn(
                "rounded-lg border p-3 mb-1",
                hasError
                    ? "border-red-500/30 bg-red-500/5"
                    : allDone
                        ? "border-green-500/30 bg-green-500/5"
                        : "border-[#9333EA]/30 bg-[#9333EA]/5",
            )}
        >
            <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
                    Bridge Progress
                </span>
                {allDone && onDismiss && (
                    <button
                        onClick={onDismiss}
                        className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                    >
                        Dismiss
                    </button>
                )}
            </div>
            <div className="space-y-1.5">
                {steps.map((step) => {
                    const wcfg = wizardStepStateConfig[step.state];
                    return (
                        <div key={step.step} className="flex items-start gap-2">
                            <div className={cn("w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5", wcfg.bg)}>
                                {wcfg.icon}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className={cn("text-xs font-medium", wcfg.color)}>
                                    {step.step}. {step.label}
                                </p>
                                {step.detail && (
                                    <p
                                        className={cn("text-[10px] mt-0.5 leading-snug truncate", step.state === "error" ? "text-red-400" : "text-gray-500")}
                                        title={step.detail}
                                    >
                                        {step.detail}
                                    </p>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
            {allDone && !hasError && (
                <p className="text-[10px] text-gray-500 mt-2 leading-snug">
                    Transaction submitted. Guardians will process and bridge your tokens — this may take a few minutes.
                </p>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Filter Button
// ---------------------------------------------------------------------------

type FilterTab = "all" | "deposits" | "withdrawals";

function FilterButton({
    active,
    onClick,
    count,
    label,
    icon,
}: {
    active: boolean;
    onClick: () => void;
    count: number;
    label: string;
    icon?: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "px-2.5 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1.5",
                active
                    ? "bg-blue-500/20 text-blue-400"
                    : "text-gray-400 hover:text-white hover:bg-white/5",
            )}
        >
            {icon}
            {label}
            {count > 0 && (
                <span className={cn("text-[10px] tabular-nums", active ? "text-blue-400" : "text-gray-500")}>
                    {count}
                </span>
            )}
        </button>
    );
}

// ---------------------------------------------------------------------------
// Main Widget
// ---------------------------------------------------------------------------

export function BridgeStatusWidget({
    className = "",
    isBridgeInProgress = false,
    bridgeSteps = [],
    clearBridgeSteps,
    walletAddress,
    bridgeDirection: activeDirection,
}: BridgeStatusWidgetProps) {
    const [isExpanded, setIsExpanded] = React.useState(true);
    const [expandedId, setExpandedId] = React.useState<string | null>(null);
    const [activeFilter, setActiveFilter] = React.useState<FilterTab>("all");
    const [isRefreshing, setIsRefreshing] = React.useState(false);

    const cachedData = React.useMemo(
        () => (walletAddress ? getCachedTransactions(walletAddress) : null),
        [walletAddress],
    );

    const {
        data: explorerData,
        refetch,
        isLoading: isLoadingExplorer,
        isError: isExplorerError,
        error: explorerError,
    } = useQuery({
        queryKey: ["bridge-on-chain-data"],
        queryFn: fetchExplorerData,
        staleTime: 5000,
        refetchInterval: 10000,
        refetchOnWindowFocus: true,
        retry: 2,
        placeholderData: cachedData
            ? { deposits: cachedData.deposits, withdrawals: cachedData.withdrawals, stats: cachedData.stats! }
            : undefined,
    });

    const merged = React.useMemo(() => {
        if (!walletAddress || !explorerData) return null;
        return mergeAndPersist(
            walletAddress,
            explorerData.deposits,
            explorerData.withdrawals,
            explorerData.stats,
        );
    }, [walletAddress, explorerData]);

    const allDeposits: CachedDeposit[] = React.useMemo(() => {
        if (merged) return merged.deposits;
        return (explorerData?.deposits ?? []).map((d) => ({ ...d, source: 'chain' as const, cachedAt: Date.now() }));
    }, [merged, explorerData]);

    const allWithdrawals: CachedWithdrawal[] = React.useMemo(() => {
        if (merged) return merged.withdrawals;
        return (explorerData?.withdrawals ?? []).map((w) => ({ ...w, source: 'chain' as const, cachedAt: Date.now() }));
    }, [merged, explorerData]);

    const stats = explorerData?.stats ?? merged?.stats ?? cachedData?.stats ?? null;
    const threshold = stats?.approveThreshold ?? 3;
    const currentHippiusHeight = stats?.hippiusHeight ?? 0;

    const blockAnchor = useBlockAnchor(currentHippiusHeight);

    const deposits = React.useMemo(() => {
        if (!walletAddress) return [];
        const filtered = allDeposits.filter(
            (d) =>
                d.recipient.toLowerCase() === walletAddress.toLowerCase() ||
                d.bittensorSide?.sender.toLowerCase() === walletAddress.toLowerCase(),
        );
        return [...filtered].sort((a, b) => parseInt(b.createdAtBlock || '0') - parseInt(a.createdAtBlock || '0'));
    }, [allDeposits, walletAddress]);

    const withdrawals = React.useMemo(() => {
        if (!walletAddress) return [];
        const filtered = allWithdrawals.filter(
            (w) => w.sender.toLowerCase() === walletAddress.toLowerCase(),
        );
        return [...filtered].sort((a, b) => parseInt(b.createdAtBlock || '0') - parseInt(a.createdAtBlock || '0'));
    }, [allWithdrawals, walletAddress]);

    type MergedItem =
        | { kind: 'deposit'; data: CachedDeposit }
        | { kind: 'withdrawal'; data: CachedWithdrawal };

    const mergedItems: MergedItem[] = React.useMemo(() => {
        const items: MergedItem[] = [
            ...deposits.map((d): MergedItem => ({ kind: 'deposit', data: d })),
            ...withdrawals.map((w): MergedItem => ({ kind: 'withdrawal', data: w })),
        ];
        return items.sort((a, b) =>
            parseInt(b.data.createdAtBlock || '0') - parseInt(a.data.createdAtBlock || '0'),
        );
    }, [deposits, withdrawals]);

    const hasActiveWizard = bridgeSteps.length > 0;
    const wizardIsFinished =
        hasActiveWizard &&
        bridgeSteps.every((s) => s.state === "done" || s.state === "error");
    const wizardHasError =
        hasActiveWizard && bridgeSteps.some((s) => s.state === "error");

    React.useEffect(() => {
        if (!wizardIsFinished || !clearBridgeSteps) return;
        const delay = wizardHasError ? 60_000 : 5_000;
        const timer = setTimeout(() => clearBridgeSteps(), delay);
        return () => clearTimeout(timer);
    }, [wizardIsFinished, wizardHasError, clearBridgeSteps]);

    const wizardFilterTab: FilterTab | null = activeDirection === 'alpha-to-halpha'
        ? 'deposits'
        : activeDirection === 'halpha-to-alpha'
            ? 'withdrawals'
            : null;

    const depositCount = deposits.length;
    const withdrawalCount = withdrawals.length;
    const totalCount = depositCount + withdrawalCount;
    const pendingDeposits = deposits.filter(
        (d) => getDepositStatus(d, currentHippiusHeight) === 'pending' || getDepositStatus(d, currentHippiusHeight) === 'processing',
    ).length;
    const pendingWithdrawals = withdrawals.filter(
        (w) => getWithdrawalStatus(w, currentHippiusHeight) === 'pending' || getWithdrawalStatus(w, currentHippiusHeight) === 'processing',
    ).length;
    const totalPending = pendingDeposits + pendingWithdrawals;

    const handleRefresh = React.useCallback(
        async (e?: React.MouseEvent) => {
            e?.stopPropagation();
            setIsRefreshing(true);
            try {
                await refetch();
            } finally {
                setTimeout(() => setIsRefreshing(false), 500);
            }
        },
        [refetch],
    );

    if (
        totalCount === 0 &&
        !isBridgeInProgress &&
        !hasActiveWizard &&
        !isLoadingExplorer
    ) {
        return null;
    }

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0, y: 50, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 50, scale: 0.9 }}
                className={cn("fixed bottom-4 left-4 z-50", className)}
            >
                <div className="bg-[#0d0d1a] border border-gray-800 rounded-xl shadow-2xl overflow-hidden w-[420px]">
                    {/* Header */}
                    <div
                        className="flex items-center justify-between px-4 py-3 bg-[#12122a] cursor-pointer"
                        onClick={() => setIsExpanded(!isExpanded)}
                    >
                        <div className="flex items-center gap-2">
                            {(totalPending > 0 || (hasActiveWizard && !wizardIsFinished)) ? (
                                <Loader2 className="w-4 h-4 text-[#9333EA] animate-spin" />
                            ) : wizardHasError ? (
                                <XCircle className="w-4 h-4 text-red-400" />
                            ) : isExplorerError ? (
                                <AlertTriangle className="w-4 h-4 text-yellow-400" />
                            ) : (
                                <CheckCircle2 className="w-4 h-4 text-green-500" />
                            )}
                            <span className="text-sm font-medium text-white">
                                Bridge Transactions
                            </span>
                            {totalPending > 0 && (
                                <span className="px-2 py-0.5 text-xs bg-[#9333EA]/20 text-[#9333EA] rounded-full">
                                    {totalPending} pending
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleRefresh();
                                }}
                                disabled={isRefreshing}
                                className="p-1 hover:bg-white/10 rounded-full transition-colors disabled:opacity-50"
                                title="Refresh status"
                            >
                                <RefreshCw className={cn("w-4 h-4 text-gray-400", isRefreshing && "animate-spin")} />
                            </button>
                            {isExpanded ? (
                                <ChevronUp className="w-4 h-4 text-gray-400" />
                            ) : (
                                <ChevronDown className="w-4 h-4 text-gray-400" />
                            )}
                        </div>
                    </div>

                    {/* Content */}
                    <AnimatePresence>
                        {isExpanded && (
                            <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                className="overflow-hidden"
                            >
                                {/* Filter bar */}
                                <div className="px-3 pt-2 pb-1 flex items-center gap-1">
                                    <FilterButton
                                        active={activeFilter === "all"}
                                        onClick={() => setActiveFilter("all")}
                                        count={totalCount}
                                        label="All"
                                    />
                                    <FilterButton
                                        active={activeFilter === "deposits"}
                                        onClick={() => setActiveFilter("deposits")}
                                        count={depositCount}
                                        label="Deposits"
                                        icon={<ArrowDownToLine className="w-3 h-3" />}
                                    />
                                    <FilterButton
                                        active={activeFilter === "withdrawals"}
                                        onClick={() => setActiveFilter("withdrawals")}
                                        count={withdrawalCount}
                                        label="Withdrawals"
                                        icon={<ArrowUpFromLine className="w-3 h-3" />}
                                    />
                                </div>

                                {/* Transaction list */}
                                <div className="p-3 pt-1 space-y-2 max-h-[420px] overflow-y-auto">
                                    {/* Wizard steps */}
                                    {hasActiveWizard &&
                                        (activeFilter === 'all' || activeFilter === wizardFilterTab) && (
                                            <WizardSteps
                                                steps={bridgeSteps}
                                                onDismiss={wizardIsFinished ? clearBridgeSteps : undefined}
                                            />
                                        )}

                                    {/* Loading state */}
                                    {isLoadingExplorer && totalCount === 0 && !hasActiveWizard && (
                                        <div className="text-center py-6">
                                            <Loader2 className="w-5 h-5 text-[#9333EA] animate-spin mx-auto mb-2" />
                                            <p className="text-xs text-gray-500">Loading bridge data from chain...</p>
                                        </div>
                                    )}

                                    {/* Error state */}
                                    {isExplorerError && !isLoadingExplorer && totalCount === 0 && !hasActiveWizard && (
                                        <div className="text-center py-6">
                                            <AlertTriangle className="w-5 h-5 text-yellow-400 mx-auto mb-2" />
                                            <p className="text-xs text-gray-400">Could not load bridge data</p>
                                            <p className="text-[10px] text-gray-600 mt-1">
                                                {explorerError instanceof Error ? explorerError.message : 'Chain query failed'}
                                            </p>
                                            <button
                                                onClick={() => refetch()}
                                                className="mt-2 text-[10px] text-[#9333EA] hover:text-[#a855f7] transition-colors"
                                            >
                                                Retry
                                            </button>
                                        </div>
                                    )}

                                    {/* All tab */}
                                    {activeFilter === "all" &&
                                        mergedItems.map((item) =>
                                            item.kind === 'deposit' ? (
                                                <DepositCard
                                                    key={`d-${item.data.requestId}`}
                                                    deposit={item.data}
                                                    threshold={threshold}
                                                    currentHippiusHeight={currentHippiusHeight}
                                                    blockAnchor={blockAnchor}
                                                    isExpanded={expandedId === `d-${item.data.requestId}`}
                                                    onToggle={() =>
                                                        setExpandedId(
                                                            expandedId === `d-${item.data.requestId}`
                                                                ? null
                                                                : `d-${item.data.requestId}`,
                                                        )
                                                    }
                                                />
                                            ) : (
                                                <WithdrawalCard
                                                    key={`w-${item.data.requestId}`}
                                                    withdrawal={item.data}
                                                    threshold={threshold}
                                                    currentHippiusHeight={currentHippiusHeight}
                                                    blockAnchor={blockAnchor}
                                                    isExpanded={expandedId === `w-${item.data.requestId}`}
                                                    onToggle={() =>
                                                        setExpandedId(
                                                            expandedId === `w-${item.data.requestId}`
                                                                ? null
                                                                : `w-${item.data.requestId}`,
                                                        )
                                                    }
                                                />
                                            ),
                                        )}

                                    {/* Deposits tab */}
                                    {activeFilter === "deposits" &&
                                        deposits.map((d) => (
                                            <DepositCard
                                                key={`d-${d.requestId}`}
                                                deposit={d}
                                                threshold={threshold}
                                                currentHippiusHeight={currentHippiusHeight}
                                                blockAnchor={blockAnchor}
                                                isExpanded={expandedId === `d-${d.requestId}`}
                                                onToggle={() =>
                                                    setExpandedId(
                                                        expandedId === `d-${d.requestId}`
                                                            ? null
                                                            : `d-${d.requestId}`,
                                                    )
                                                }
                                            />
                                        ))}

                                    {/* Withdrawals tab */}
                                    {activeFilter === "withdrawals" &&
                                        withdrawals.map((w) => (
                                            <WithdrawalCard
                                                key={`w-${w.requestId}`}
                                                withdrawal={w}
                                                threshold={threshold}
                                                currentHippiusHeight={currentHippiusHeight}
                                                blockAnchor={blockAnchor}
                                                isExpanded={expandedId === `w-${w.requestId}`}
                                                onToggle={() =>
                                                    setExpandedId(
                                                        expandedId === `w-${w.requestId}`
                                                            ? null
                                                            : `w-${w.requestId}`,
                                                    )
                                                }
                                            />
                                        ))}

                                    {/* Empty state */}
                                    {!isLoadingExplorer &&
                                        !isExplorerError &&
                                        !hasActiveWizard && (() => {
                                            const showDeposits = activeFilter === 'all' || activeFilter === 'deposits';
                                            const showWithdrawals = activeFilter === 'all' || activeFilter === 'withdrawals';
                                            const visibleDeposits = showDeposits ? deposits.length : 0;
                                            const visibleWithdrawals = showWithdrawals ? withdrawals.length : 0;
                                            if (visibleDeposits + visibleWithdrawals > 0) return null;

                                            const message = !walletAddress
                                                ? 'Connect a wallet to view your bridge transactions'
                                                : activeFilter === 'deposits'
                                                    ? 'No deposit transactions yet. Bridge Alpha to hAlpha to see them here.'
                                                    : activeFilter === 'withdrawals'
                                                        ? 'No withdrawal transactions yet. Bridge hAlpha to Alpha to see them here.'
                                                        : 'No bridge transactions for this wallet';

                                            return (
                                                <div className="text-center py-4 text-gray-500 text-sm">
                                                    {message}
                                                </div>
                                            );
                                        })()}
                                </div>

                                {/* Footer */}
                                {stats && (
                                    <div className="px-4 py-2 bg-[#12122a] border-t border-gray-800 flex items-center justify-between">
                                        <div className="flex items-center gap-3 text-[10px] text-gray-500">
                                            <span>{BRIDGE_CONFIG.hippius.name}: {stats.hippiusHeight.toLocaleString()}</span>
                                            <span>{BRIDGE_CONFIG.bittensor.name}: {stats.bittensorHeight.toLocaleString()}</span>
                                        </div>
                                        {stats.lastPollAt && (
                                            <span className="text-[10px] text-gray-600">
                                                {new Date(stats.lastPollAt).toLocaleTimeString()}
                                            </span>
                                        )}
                                    </div>
                                )}
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </motion.div>
        </AnimatePresence>
    );
}

export default BridgeStatusWidget;
