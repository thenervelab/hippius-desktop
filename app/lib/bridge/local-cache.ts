/**
 * Bridge Transaction Local Cache
 *
 * Persists bridge transaction history to localStorage so users retain
 * a record of their transactions even if they are pruned from the chain
 * (e.g., after the cleanup TTL expires).
 *
 * Strategy:
 * - On every successful chain fetch, merge new data into the local cache.
 * - Chain data is authoritative: if an ID exists on-chain AND locally,
 *   the on-chain version wins (it may have updated status/votes).
 * - Local-only records (deleted from chain) are kept but flagged with
 *   `source: 'local'` so the UI can indicate they're historical.
 * - Entries are capped to MAX_CACHED per wallet to prevent unbounded growth.
 * - Each wallet address gets its own cache key.
 */

import type { DepositView, WithdrawalView, BridgeStats } from './service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedDeposit extends DepositView {
    /** 'chain' = fresh from chain, 'local' = only in local cache (pruned from chain) */
    source: 'chain' | 'local';
    /** Timestamp of last update (epoch ms) */
    cachedAt: number;
}

export interface CachedWithdrawal extends WithdrawalView {
    source: 'chain' | 'local';
    cachedAt: number;
}

export interface CachedBridgeData {
    deposits: CachedDeposit[];
    withdrawals: CachedWithdrawal[];
    stats: BridgeStats | null;
    /** ISO string of last successful chain fetch */
    lastChainFetchAt: string | null;
}

// Pending transaction (submitted but not yet confirmed on chain)
export interface PendingBridgeTransaction {
    id: string;
    type: 'deposit' | 'withdrawal';
    amount: string;
    walletAddress: string;
    status: 'in-progress' | 'submitted' | 'failed';
    createdAt: number;
    steps: Array<{
        step: number;
        label: string;
        state: string;
        detail?: string;
    }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = 'hippius_bridge_tx_';
const MAX_CACHED_PER_TYPE = 100;
const CACHE_VERSION = 1;

function storageKey(walletAddress: string): string {
    return `${STORAGE_PREFIX}${walletAddress.toLowerCase()}_v${CACHE_VERSION}`;
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function readCache(walletAddress: string): CachedBridgeData {
    const empty: CachedBridgeData = {
        deposits: [],
        withdrawals: [],
        stats: null,
        lastChainFetchAt: null,
    };
    if (typeof window === 'undefined') return empty;
    try {
        const raw = localStorage.getItem(storageKey(walletAddress));
        if (!raw) return empty;
        return JSON.parse(raw) as CachedBridgeData;
    } catch {
        return empty;
    }
}

function writeCache(walletAddress: string, data: CachedBridgeData): void {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(storageKey(walletAddress), JSON.stringify(data));
    } catch (e) {
        // Storage full — silently skip
        console.warn('[BridgeCache] Failed to write localStorage:', e);
    }
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

/**
 * Merge fresh on-chain data with existing local cache.
 *
 * - On-chain records overwrite local copies (authoritative).
 * - Records that exist locally but NOT on-chain are kept with `source: 'local'`.
 * - If a local record was previously 'local' but reappears on-chain, it flips back to 'chain'.
 * - Newest entries are kept; oldest pruned beyond MAX_CACHED_PER_TYPE.
 */
export function mergeAndPersist(
    walletAddress: string,
    chainDeposits: DepositView[],
    chainWithdrawals: WithdrawalView[],
    stats: BridgeStats | null,
): CachedBridgeData {
    const existing = readCache(walletAddress);
    const now = Date.now();

    // Merge deposits
    const chainDepositIds = new Set(chainDeposits.map((d) => d.requestId));
    const depositMap = new Map<string, CachedDeposit>();

    // Start with existing local-only records
    for (const d of existing.deposits) {
        if (!chainDepositIds.has(d.requestId)) {
            // This record was pruned from chain — keep as local
            depositMap.set(d.requestId, { ...d, source: 'local' });
        }
    }

    // Overlay chain data (authoritative)
    for (const d of chainDeposits) {
        depositMap.set(d.requestId, { ...d, source: 'chain', cachedAt: now });
    }

    // Merge withdrawals
    const chainWithdrawalIds = new Set(chainWithdrawals.map((w) => w.requestId));
    const withdrawalMap = new Map<string, CachedWithdrawal>();

    for (const w of existing.withdrawals) {
        if (!chainWithdrawalIds.has(w.requestId)) {
            withdrawalMap.set(w.requestId, { ...w, source: 'local' });
        }
    }

    for (const w of chainWithdrawals) {
        withdrawalMap.set(w.requestId, { ...w, source: 'chain', cachedAt: now });
    }

    // Cap to MAX_CACHED (keep most recently cached first)
    const sortByCachedAt = (a: { cachedAt: number }, b: { cachedAt: number }) =>
        b.cachedAt - a.cachedAt;

    const mergedDeposits = Array.from(depositMap.values())
        .sort(sortByCachedAt)
        .slice(0, MAX_CACHED_PER_TYPE);

    const mergedWithdrawals = Array.from(withdrawalMap.values())
        .sort(sortByCachedAt)
        .slice(0, MAX_CACHED_PER_TYPE);

    const merged: CachedBridgeData = {
        deposits: mergedDeposits,
        withdrawals: mergedWithdrawals,
        stats: stats ?? existing.stats,
        lastChainFetchAt: new Date().toISOString(),
    };

    writeCache(walletAddress, merged);
    return merged;
}

/**
 * Get cached transactions for a wallet. Returns the local cache immediately
 * (useful as placeholder data while the chain query is in-flight).
 */
export function getCachedTransactions(walletAddress: string): CachedBridgeData {
    return readCache(walletAddress);
}

/**
 * Clear the local cache for a specific wallet (e.g., on logout).
 */
export function clearCache(walletAddress: string): void {
    if (typeof window === 'undefined') return;
    try {
        localStorage.removeItem(storageKey(walletAddress));
    } catch {
        // Ignore
    }
}

// ---------------------------------------------------------------------------
// Pending Transaction Storage
// ---------------------------------------------------------------------------

const PENDING_STORAGE_KEY = 'hippius_bridge_pending_tx';

function readPendingTransactions(): PendingBridgeTransaction[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = localStorage.getItem(PENDING_STORAGE_KEY);
        if (!raw) return [];
        return JSON.parse(raw) as PendingBridgeTransaction[];
    } catch {
        return [];
    }
}

function writePendingTransactions(txs: PendingBridgeTransaction[]): void {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(txs));
    } catch (e) {
        console.warn('[BridgeCache] Failed to write pending transactions:', e);
    }
}

/**
 * Save a pending transaction to local storage
 */
export function savePendingTransaction(tx: PendingBridgeTransaction): void {
    const existing = readPendingTransactions();
    // Remove any existing pending for this wallet to avoid duplicates
    const filtered = existing.filter(t => t.walletAddress.toLowerCase() !== tx.walletAddress.toLowerCase());
    filtered.push(tx);
    writePendingTransactions(filtered);
}

/**
 * Remove pending transaction for a wallet (when confirmed on chain or dismissed)
 */
export function removePendingTransaction(walletAddress: string): void {
    const existing = readPendingTransactions();
    const filtered = existing.filter(t => t.walletAddress.toLowerCase() !== walletAddress.toLowerCase());
    writePendingTransactions(filtered);
}

/**
 * Get pending transaction for a wallet
 */
export function getPendingTransaction(walletAddress: string): PendingBridgeTransaction | null {
    const pending = readPendingTransactions();
    return pending.find(t => t.walletAddress.toLowerCase() === walletAddress.toLowerCase()) || null;
}

/**
 * Get all pending transactions
 */
export function getAllPendingTransactions(): PendingBridgeTransaction[] {
    return readPendingTransactions();
}
