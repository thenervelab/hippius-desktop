/**
 * useBridge Hook
 *
 * React hook for bridge operations between Alpha and hAlpha.
 * Provides state management, transaction tracking, and bridge operations.
 *
 * ARCHITECTURE (v3):
 * - Direct chain data fetching for transaction history (via BridgeStatusWidget)
 * - Minimal local tracking for in-flight transactions (wizard steps)
 * - Balance queries via direct polkadot-api (same approach as Explorer)
 * 
 * NOTE: Transaction history display is handled by BridgeStatusWidget using
 * direct chain queries (fetchExplorerData). This hook only provides:
 * - Bridge operation mutations (bridgeAlphaToHAlpha, bridgeHAlphaToAlpha)
 * - Balance queries
 * - Wizard step progress for in-flight operations
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
    minimumAlpha: 'bridge-minimum-alpha',
};

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

    // Local transactions only - for immediate feedback during bridge operations.
    // Transaction history display is handled by BridgeStatusWidget via direct chain queries.
    const allTransactions = useMemo(() => {
        const localAll = getLocalAllTransactions();
        const localPending = getLocalPendingTransactions();
        // Deduplicate local transactions
        const seen = new Set<string>();
        const result = [];
        for (const tx of [...localPending, ...localAll]) {
            if (!seen.has(tx.id)) {
                seen.add(tx.id);
                result.push(tx);
            }
        }
        return result;
    }, []);

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

            // Invalidate balances to refresh after successful bridge
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

            // Invalidate balances to refresh after successful bridge
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
        await refetchBalances();
    }, [refetchBalances]);

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

        // All transactions (local only - for immediate UI feedback during bridge operations)
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

export default useBridge;
