/**
 * Bridge Types
 *
 * Frontend type definitions for the Alpha Bridge integration.
 *
 * All bridge business logic now lives in the Rust backend; the frontend
 * reaches it exclusively through Tauri IPC (`bridge_*` commands). These
 * types mirror the serde-camelCase shapes those commands return — amounts
 * are decimal *strings* (rao) on the wire and are converted to `bigint`
 * only where a consumer needs arithmetic (see the balance/hotkey types
 * below, populated by `useBridge`).
 */

import type { BridgeDirection, BridgeTransactionStatus } from './config';

// Re-export config types for convenience.
export type { BridgeDirection, BridgeTransactionStatus } from './config';

/* ── Wizard step (consumed by the bridge dialog) ──────────────────── */

export type BridgeStepState = 'pending' | 'active' | 'done' | 'error';

/** A single step in the in-flight bridge progress wizard. */
export interface BridgeStep {
    id: string;
    label: string;
    state: BridgeStepState;
}

/* ── Balances & hotkeys (FE-side bigint shapes) ───────────────────── */
//
// The Rust `bridge_get_balances` / `bridge_get_staked_hotkeys` commands
// return decimal *strings*; `useBridge` maps them to `bigint` here so the
// dialog can do exact rao arithmetic without float rounding.

export interface BridgeBalances {
    /** Free TAO on Bittensor, smallest unit. */
    alpha: bigint;
    /** Staked Alpha on the configured subnet (bridge source for
     *  Alpha → hAlpha; destination for the reverse). */
    alphaStake: bigint;
    /** Free hAlpha on Hippius, smallest unit. */
    hAlpha: bigint;
}

export interface StakedHotkey {
    hotkey: string;
    stake: bigint;
}

/* ── Explorer views (mirror Rust `bridge_fetch_onchain_data`) ─────── */
//
// NOTE: there is no `bittensorSide` field — the Bittensor-contract
// cross-reference was deferred. Consumers must use the unified
// `unifiedStatus` instead of recomputing a per-row status, and fall back
// to "-" / 0 where Bittensor-side detail used to appear.

/** Unified, FE-facing status already resolved by the backend. */
export type BridgeExplorerStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface DepositView {
    requestId: string;
    recipient: string;
    amount: string;
    amountDisplay: string;
    votes: string[];
    voteCount: number;
    status: string;
    /** Backend-resolved unified status — use this directly for display. */
    unifiedStatus: BridgeExplorerStatus;
    createdAtBlock: string;
    finalizedAtBlock: string | null;
}

export interface WithdrawalView {
    requestId: string;
    sender: string;
    recipient: string;
    amount: string;
    amountDisplay: string;
    status: string;
    /** Backend-resolved unified status — use this directly for display. */
    unifiedStatus: BridgeExplorerStatus;
    createdAtBlock: string;
}

export interface BridgeStats {
    totalDeposits: number;
    totalWithdrawals: number;
    pendingDeposits: number;
    pendingWithdrawals: number;
    hippiusHeight: number;
    bittensorHeight: number;
    approveThreshold: number;
    cleanupTtlBlocks: string;
    guardians: string[];
}

export interface BridgeOnChainData {
    deposits: DepositView[];
    withdrawals: WithdrawalView[];
    stats: BridgeStats;
}

/* ── Persisted transaction rows (mirror `bridge_list_transactions`) ─ */

/**
 * One row from the backend's SQLite bridge-transaction log. Powers the
 * in-flight "pending" overlay in the history table. `amount` is a rao
 * decimal string; `createdAt`/`updatedAt` are unix-ms timestamps.
 */
export interface BridgeTxRow {
    id: string;
    direction: BridgeDirection;
    status: BridgeTransactionStatus;
    amount: string;
    sender: string | null;
    recipient: string | null;
    sourceTxHash: string | null;
    depositId: string | null;
    withdrawalId: string | null;
    createdAt: number;
    updatedAt: number;
    error: string | null;
}
