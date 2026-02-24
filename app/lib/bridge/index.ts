/**
 * Bridge Module
 * 
 * Re-exports all bridge-related functionality.
 */

// Config
export {
    BRIDGE_CONFIG,
    calculateBridgeFee,
    calculateReceivedAmount,
    formatBridgeAmount,
} from './config';

export type {
    BridgeDirection,
    BridgeTransactionStatus,
    BridgeTransaction,
} from './config';

// Types
export type {
    BridgeSigner,
    BridgeRequest,
    BridgeResult,
    GuardianAttestation,
    BridgeEvent,
    ChainBalance,
    BridgeState,
    TrackedTransaction,
    BridgeTransactionEvent,
    UseBridgeReturn,
} from './types';

// Service
export {
    initializeBridge,
    disconnectBridge,
    bridgeAlphaToHAlpha,
    bridgeHAlphaToAlpha,
    getBalances,
    getAlphaBalance,
    getHAlphaBalance,
    getAlphaStakeBalance,
    getBittensorBalances,
    getHippiusBalance,
    getStakedHotkeys,
    estimateBridgeFees,
    checkConnectionStatus,
    subscribeToTransactionUpdates,
    getMinimumAlphaTransfer,
    getMinimumHAlphaTransfer,
    alphaToHAlpha,
    hAlphaToAlpha,
    getTransaction,
    getPendingTransactions,
    getAllTransactions,
    getRecentTransactions,
    getTransactionsForAddress,
    removeLocalTransaction,
    loadTransactionsFromStorage,
    saveTransactionsToStorage,
    refreshTransactionStatus,
    clearCompletedTransactions,
    clearAllTransactions,
} from './service';

export type {
    BridgeStep,
    BridgeStepState,
    OnStepCallback,
    StakedHotkey,
    BittensorBalances,
} from './service';

// API
export {
    fetchBridgeEvents,
    fetchTransactions,
    aggregateEventsToTransactions,
} from './api';

export type {
    IndexerEvent,
    IndexerResponse,
} from './api';

// Explorer API
export {
    fetchExplorerData,
    getDepositStatus,
    getWithdrawalStatus,
    isStaleTransaction,
    truncId,
} from './explorer-api';

export type {
    ExplorerData,
    BridgeExplorerStatus,
    DepositView,
    WithdrawalView,
    BridgeStats,
    BridgeOnChainData,
} from './explorer-api';

// Local Cache
export {
    mergeAndPersist,
    getCachedTransactions,
    clearCache,
} from './local-cache';

export type {
    CachedDeposit,
    CachedWithdrawal,
    CachedBridgeData,
} from './local-cache';
