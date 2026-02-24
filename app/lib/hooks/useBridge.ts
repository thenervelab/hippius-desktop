/**
 * useBridge Hook
 *
 * React hook for bridge operations between Alpha and hAlpha.
 * Provides state management, transaction tracking, and bridge operations.
 *
 * ARCHITECTURE:
 * - API-based polling for transaction history (indexer)
 * - Minimal local tracking for in-flight transactions (until API picks them up)
 * - Balance queries via direct polkadot-api
 * - Uses local wallet keypair for signing (no extension required)
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Keyring } from '@polkadot/keyring';
import { useWalletAuth } from '@/app/lib/wallet-auth-context';
import { useActiveWalletAddress } from '@/app/lib/hooks/useActiveWalletAddress';
import {
    initializeBridge,
    disconnectBridge,
    bridgeAlphaToHAlpha,
    bridgeHAlphaToAlpha,
    getBalances,
    estimateBridgeFees,
    checkConnectionStatus,
    getMinimumAlphaTransfer,
    getMinimumHAlphaTransfer,
    getStakedHotkeys,
    getPendingTransactions as getLocalPendingTransactions,
    getAllTransactions as getLocalAllTransactions,
} from '@/app/lib/bridge/service';
import type { BridgeStep, StakedHotkey } from '@/app/lib/bridge/service';
import { fetchTransactions } from '@/app/lib/bridge/api';
import type { BridgeDirection, UseBridgeReturn, BridgeResult } from '@/app/lib/bridge/types';

// Utility function to add timeout to async operations
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
    ]);
}

const QUERY_KEYS = {
    balances: 'bridge-balances',
    connectionStatus: 'bridge-connection',
    transactions: 'bridge-transactions',
    minimumAlpha: 'bridge-minimum-alpha',
};

// Polling intervals
const ACTIVE_POLLING_INTERVAL = 15000; // 15 seconds when transactions are in progress

export function useBridge(): UseBridgeReturn {
    const { isAuthenticated } = useWalletAuth();
    const polkadotAddress = useActiveWalletAddress();
    const queryClient = useQueryClient();

    const [isInitialized, setIsInitialized] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [bridgeSteps, setBridgeSteps] = useState<BridgeStep[]>([]);

    const clearBridgeSteps = useCallback(() => setBridgeSteps([]), []);

    // Initialize bridge connections
    useEffect(() => {
        async function init() {
            if (!isAuthenticated) return;

            console.log('[useBridge] Starting bridge initialization...');
            try {
                await initializeBridge();
                setIsInitialized(true);
                setError(null);
                console.log('[useBridge] Bridge initialized successfully');
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to initialize bridge';
                setError(message);
                console.error('[useBridge] Initialization error:', err);
                setIsInitialized(false);
            }
        }

        init();

        return () => {
            disconnectBridge();
            setIsInitialized(false);
        };
    }, [isAuthenticated]);

    // Fetch transactions from the indexer API with polling
    const {
        data: apiTransactions = [],
        refetch: refetchTransactions,
    } = useQuery({
        queryKey: [QUERY_KEYS.transactions, polkadotAddress],
        queryFn: async () => {
            if (!polkadotAddress) return [];
            return fetchTransactions(polkadotAddress);
        },
        enabled: !!polkadotAddress && isAuthenticated,
        staleTime: 10000, // 10 seconds
        refetchOnWindowFocus: true,
    });

    // Poll every 15 seconds when there are pending transactions (API or local)
    const hasPendingTransactions = useMemo(() => {
        const apiPending = apiTransactions.some(tx =>
            tx.status === 'pending' || tx.status === 'confirmed' || tx.status === 'processing'
        );
        const localPending = getLocalPendingTransactions().length > 0;
        return apiPending || localPending;
    }, [apiTransactions]);

    useEffect(() => {
        if (!hasPendingTransactions || !polkadotAddress || !isAuthenticated) return;

        console.log('[useBridge] Starting 15-second polling for pending transactions');
        const interval = setInterval(() => {
            console.log('[useBridge] Polling API for transaction updates...');
            refetchTransactions();
        }, ACTIVE_POLLING_INTERVAL);

        return () => {
            console.log('[useBridge] Stopping polling - no pending transactions');
            clearInterval(interval);
        };
    }, [hasPendingTransactions, polkadotAddress, isAuthenticated, refetchTransactions]);

    // Merge API transactions with local transactions (in-flight + persisted).
    const allTransactions = useMemo(() => {
        const localAll = getLocalAllTransactions();
        const localPending = getLocalPendingTransactions();
        const apiIds = new Set(apiTransactions.map(tx => tx.id));
        // Only include local txs not yet in the API
        const uniqueLocal = localAll.filter(tx => !apiIds.has(tx.id));
        const uniquePending = localPending.filter(tx => !apiIds.has(tx.id) && !uniqueLocal.some(l => l.id === tx.id));
        return [...uniquePending, ...uniqueLocal, ...apiTransactions];
    }, [apiTransactions]);

    // Get pending (in-progress) transactions only
    const pendingTransactions = useMemo(() =>
        allTransactions.filter(tx =>
            tx.status === 'pending' ||
            tx.status === 'confirmed' ||
            tx.status === 'processing'
        ),
        [allTransactions]
    );

    // Query connection status
    const { data: connectionStatus } = useQuery({
        queryKey: [QUERY_KEYS.connectionStatus],
        queryFn: checkConnectionStatus,
        enabled: isInitialized,
        refetchInterval: 30000, // Check every 30 seconds
    });

    // Query balances - wait for bridge initialization to avoid errors
    const {
        data: balances,
        isLoading: isLoadingBalances,
        refetch: refetchBalances,
    } = useQuery({
        queryKey: [QUERY_KEYS.balances, polkadotAddress],
        queryFn: async () => {
            if (!polkadotAddress) {
                return { alpha: BigInt(0), alphaStake: BigInt(0), hAlpha: BigInt(0) };
            }

            try {
                // Add 30 second timeout to prevent hanging
                const result = await withTimeout(getBalances(polkadotAddress), 30000);
                return result;
            } catch (error) {
                console.error('[useBridge] Balance query failed:', error);
                throw error;
            }
        },
        enabled: !!polkadotAddress && isInitialized,
        refetchInterval: 30000,
        staleTime: 15000,
        retry: 3,
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
    });

    // Get minimum transfer amounts (hardcoded values from config)
    const minAlphaData = useMemo(() => {
        const minAlpha = getMinimumAlphaTransfer();
        const minHAlpha = getMinimumHAlphaTransfer();
        return {
            minAlpha,
            minHAlpha,
        };
    }, []);

    const isLoadingMinimum = false;
    const refetchMinimumAlpha = useCallback(async () => {
        // No-op since values are hardcoded
    }, []);

    // Query staked hotkeys for the active wallet
    const {
        data: stakedHotkeys = [],
        isLoading: isLoadingHotkeys,
        refetch: refetchHotkeys,
    } = useQuery({
        queryKey: ['bridge-staked-hotkeys', polkadotAddress],
        queryFn: async (): Promise<StakedHotkey[]> => {
            if (!polkadotAddress) return [];
            return getStakedHotkeys(polkadotAddress);
        },
        enabled: !!polkadotAddress && isInitialized,
        staleTime: 30000,
        refetchOnWindowFocus: true,
        retry: 2,
    });

    // Bridge Alpha to hAlpha mutation
    const bridgeToHAlphaMutation = useMutation({
        mutationFn: async ({ amount, mnemonic, hotkey }: { amount: bigint; mnemonic: string; hotkey?: string }): Promise<BridgeResult> => {
            if (!polkadotAddress) {
                throw new Error('Wallet not connected');
            }

            // Create keypair from mnemonic for signing
            const keyring = new Keyring({ type: 'sr25519' });
            const pair = keyring.addFromMnemonic(mnemonic);

            const keypair = {
                publicKey: pair.publicKey as Uint8Array,
                sign: (d: Uint8Array) => pair.sign(d) as Uint8Array,
            };

            return bridgeAlphaToHAlpha(
                {
                    direction: 'alpha-to-halpha',
                    amount,
                    senderAddress: polkadotAddress,
                    hotkey,
                    keypair,
                },
                setBridgeSteps,
            );
        },
        onSuccess: (result) => {
            console.log('[useBridge] onSuccess: result', result.success, 'bridgeTransactionId:', result.bridgeTransactionId, 'txHash:', result.txHash);

            // Trigger immediate refetch to get the transaction from API
            refetchTransactions();
            queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.balances] });
        },
        onError: (error) => {
            console.error('[useBridge] Bridge to hAlpha failed:', error);
        },
    });

    // Bridge hAlpha to Alpha mutation
    const bridgeToAlphaMutation = useMutation({
        mutationFn: async ({ amount, mnemonic }: { amount: bigint; mnemonic: string }): Promise<BridgeResult> => {
            if (!polkadotAddress) {
                throw new Error('Wallet not connected');
            }

            // Create keypair from mnemonic for signing
            const keyring = new Keyring({ type: 'sr25519' });
            const pair = keyring.addFromMnemonic(mnemonic);

            const keypair = {
                publicKey: pair.publicKey as Uint8Array,
                sign: (d: Uint8Array) => pair.sign(d) as Uint8Array,
            };

            return bridgeHAlphaToAlpha(
                {
                    direction: 'halpha-to-alpha',
                    amount,
                    senderAddress: polkadotAddress,
                    keypair,
                },
                setBridgeSteps,
            );
        },
        onSuccess: (result) => {
            console.log('[useBridge] onSuccess (hAlpha): result', result.success, 'bridgeTransactionId:', result.bridgeTransactionId);

            // Trigger immediate refetch to get the transaction from API
            refetchTransactions();
            queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.balances] });
        },
        onError: (error) => {
            console.error('[useBridge] Bridge to Alpha failed:', error);
        },
    });

    // Estimate fees
    const estimateFees = useCallback(async (amount: bigint, direction: BridgeDirection) => {
        const fees = await estimateBridgeFees(amount, direction);
        return fees.totalFee;
    }, []);

    // Get transaction status from API data
    const getTransactionStatus = useCallback(async (txId: string) => {
        const tx = allTransactions.find(t => t.id === txId);
        return tx || null;
    }, [allTransactions]);

    // Refetch all data
    const refetch = useCallback(async () => {
        await Promise.all([
            refetchBalances(),
            refetchTransactions(),
        ]);
    }, [refetchBalances, refetchTransactions]);

    // Refetch minimum amount
    const refetchMinimum = useCallback(async () => {
        await refetchMinimumAlpha();
    }, [refetchMinimumAlpha]);

    // Computed state
    const isConnected = useMemo(() => {
        return isInitialized && (connectionStatus?.bittensor || false) && (connectionStatus?.hippiusTestnet || false);
    }, [isInitialized, connectionStatus]);

    const isLoading = useMemo(() => {
        return !isInitialized || isLoadingBalances || bridgeToHAlphaMutation.isPending || bridgeToAlphaMutation.isPending;
    }, [isInitialized, isLoadingBalances, bridgeToHAlphaMutation.isPending, bridgeToAlphaMutation.isPending]);

    return {
        // State
        isLoading,
        isConnected,
        isInitializing: !isInitialized,
        error,

        // Balances
        alphaBalance: balances?.alpha ?? null,
        alphaStakeBalance: balances?.alphaStake ?? null,
        hAlphaBalance: balances?.hAlpha ?? null,

        // Minimum amounts for bridge validation
        minAlphaTransfer: minAlphaData?.minAlpha ?? null,
        minHAlphaTransfer: minAlphaData?.minHAlpha ?? null,
        isLoadingMinimum,

        // Staked hotkeys for validator selection
        stakedHotkeys,
        isLoadingHotkeys,
        refetchHotkeys,

        // Active transactions
        pendingTransactions,

        // All transactions (for history display - from API + localStorage)
        allTransactions,

        // Wizard step progress for in-flight bridge operation
        bridgeSteps,
        clearBridgeSteps,

        // Operations
        bridgeAlphaToHAlpha: bridgeToHAlphaMutation.mutateAsync,
        bridgeHAlphaToAlpha: bridgeToAlphaMutation.mutateAsync,

        // Queries
        estimateFees,
        getTransactionStatus,

        // Utilities
        refetch,
        refetchMinimum,
    };
}

/**
 * Hook for tracking a specific bridge transaction using API data
 */
export function useBridgeTransaction(txId: string | null) {
    const { allTransactions, pendingTransactions } = useBridge();

    const transaction = useMemo(() => {
        if (!txId) return null;
        return allTransactions.find(tx => tx.id === txId) ||
            pendingTransactions.find(tx => tx.id === txId) ||
            null;
    }, [txId, allTransactions, pendingTransactions]);

    return transaction;
}

export default useBridge;
