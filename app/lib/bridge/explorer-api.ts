/**
 * Bridge Explorer Data
 *
 * Reads deposit and withdrawal data directly from chain storage,
 * exactly like the Guardian Explorer's poller.ts does.
 *
 * Data flow:
 * - Hippius chain: AlphaBridge.Deposits + WithdrawalRequests (pallet storage)
 * - Bittensor chain: bridge contract cross-reference (graceful)
 *
 * NO external API calls — everything comes from the chain via WebSocket.
 */

import {
    fetchBridgeDataOnChain,
    type DepositView,
    type WithdrawalView,
    type BridgeStats,
    type BridgeOnChainData,
} from './service';

// Re-export types for consumers
export type { DepositView, WithdrawalView, BridgeStats, BridgeOnChainData };

// Keep the ExplorerData alias for backward compatibility
export type ExplorerData = BridgeOnChainData;

// ---------------------------------------------------------------------------
// Data fetching — directly from chain (no API proxy)
// ---------------------------------------------------------------------------

/**
 * Fetch all bridge data directly from the Hippius + Bittensor chains.
 * Same approach as Guardian Explorer's poller.ts.
 */
export async function fetchExplorerData(): Promise<ExplorerData> {
    return fetchBridgeDataOnChain();
}

// ---------------------------------------------------------------------------
// Status helpers (for UI display)
// ---------------------------------------------------------------------------

export type BridgeExplorerStatus = 'pending' | 'processing' | 'completed' | 'failed';

// ~6 seconds per block on both chains. 30 minutes = 300 blocks.
const STALE_BLOCK_THRESHOLD = 300;

/** Map a deposit to a unified status for display */
export function getDepositStatus(deposit: DepositView, currentHippiusHeight?: number): BridgeExplorerStatus {
    const hStatus = deposit.status.toLowerCase();
    if (hStatus === 'completed') return 'completed';
    if (hStatus === 'denied' || hStatus === 'expired') return 'failed';

    // If pending and stale (>30 min), treat as failed/timed-out
    if (currentHippiusHeight && deposit.createdAtBlock) {
        const age = currentHippiusHeight - Number(deposit.createdAtBlock);
        if (age > STALE_BLOCK_THRESHOLD && hStatus !== 'completed') return 'failed';
    }

    // Pending on Hippius - check BT side
    if (deposit.bittensorSide) {
        const btStatus = deposit.bittensorSide.status.toLowerCase();
        if (btStatus === 'failed' || btStatus === 'denied') return 'failed';
        if (btStatus === 'completed') return 'processing'; // BT done, waiting for Hippius
    }
    if (deposit.voteCount > 0) return 'processing';
    return 'pending';
}

/** Map a withdrawal to a unified status for display */
export function getWithdrawalStatus(withdrawal: WithdrawalView, currentHippiusHeight?: number): BridgeExplorerStatus {
    // Check BT side first (final destination)
    if (withdrawal.bittensorSide) {
        const btStatus = withdrawal.bittensorSide.status.toLowerCase();
        if (btStatus === 'completed') return 'completed';
        if (btStatus === 'failed' || btStatus === 'denied') return 'failed';
        if (withdrawal.bittensorSide.voteCount > 0) return 'processing';
    }
    const hStatus = withdrawal.status.toLowerCase();
    if (hStatus === 'denied' || hStatus === 'expired') return 'failed';

    // If pending/requested and stale (>30 min), treat as failed/timed-out
    if (currentHippiusHeight && withdrawal.createdAtBlock) {
        const age = currentHippiusHeight - Number(withdrawal.createdAtBlock);
        if (age > STALE_BLOCK_THRESHOLD && hStatus !== 'completed') return 'failed';
    }

    if (hStatus === 'requested') return 'pending';
    return 'processing';
}

/** Check if a transaction is stale (>30 minutes old with no progress) */
export function isStaleTransaction(createdAtBlock: string, currentHeight: number): boolean {
    const age = currentHeight - Number(createdAtBlock);
    return age > STALE_BLOCK_THRESHOLD;
}

/** Truncate a hex ID for display */
export function truncId(id: string): string {
    if (id.length <= 16) return id;
    return `${id.slice(0, 8)}...${id.slice(-6)}`;
}
