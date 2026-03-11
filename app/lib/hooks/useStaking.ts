import { useCallback } from 'react';
import { useWalletAuth } from '@/app/lib/wallet-auth-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';

interface UnbondingPeriod {
    amount: string;
    era: number;
    remainingEras: number;
}

interface StakingInfoResult {
    bonded: string;
    rewards: string;
    unbonding: string;
    withdrawable: string;
    balance: string;
    unbondingPeriods: UnbondingPeriod[];
}

interface StakingInfo extends StakingInfoResult {
    isLoading: boolean;
    error: string | null;
}

interface TxResult {
    txHash: string;
    success: boolean;
}

interface StakingOperations {
    bond: (amount: string) => Promise<void>;
    bondExtra: (amount: string) => Promise<void>;
    unbond: (amount: string) => Promise<void>;
    withdrawUnbonded: () => Promise<void>;
    claimRewards: () => Promise<void>;
}

export const useStaking = () => {
    const { polkadotAddress } = useWalletAuth();
    const queryClient = useQueryClient();

    const { data, isLoading, error, refetch } = useQuery<StakingInfoResult>({
        queryKey: ['staking-info', polkadotAddress],
        enabled: !!polkadotAddress,
        refetchInterval: 30_000,
        queryFn: () => invoke<StakingInfoResult>('get_staking_info'),
    });

    const stakingInfo: StakingInfo = {
        bonded: data?.bonded ?? '0',
        rewards: data?.rewards ?? '0',
        unbonding: data?.unbonding ?? '0',
        withdrawable: data?.withdrawable ?? '0',
        balance: data?.balance ?? '0',
        isLoading,
        error: error ? (error instanceof Error ? error.message : 'Failed to fetch staking info') : null,
        unbondingPeriods: data?.unbondingPeriods ?? [],
    };

    const invalidate = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['staking-info'] });
        queryClient.invalidateQueries({ queryKey: ['hippius-balance'] });
    }, [queryClient]);

    const bond = useCallback(async (amount: string): Promise<void> => {
        await invoke<TxResult>('stake_bond', { amount });
        invalidate();
    }, [invalidate]);

    const bondExtra = useCallback(async (amount: string): Promise<void> => {
        // stake_bond auto-detects whether to use bond or bond_extra
        await invoke<TxResult>('stake_bond', { amount });
        invalidate();
    }, [invalidate]);

    const unbond = useCallback(async (amount: string): Promise<void> => {
        await invoke<TxResult>('stake_unbond', { amount });
        invalidate();
    }, [invalidate]);

    const withdrawUnbonded = useCallback(async (): Promise<void> => {
        await invoke<TxResult>('stake_withdraw_unbonded');
        invalidate();
    }, [invalidate]);

    const claimRewards = useCallback(async (): Promise<void> => {
        await invoke<TxResult>('stake_claim_rewards');
        invalidate();
    }, [invalidate]);

    const operations: StakingOperations = {
        bond,
        bondExtra,
        unbond,
        withdrawUnbonded,
        claimRewards,
    };

    // No longer need passcode unlock for signing — keypair is in Rust AUTH_STATE.
    // If not authenticated, the Rust command will return an error.
    const needsUnlock = false;

    return {
        stakingInfo,
        operations,
        refetch,
        needsUnlock,
    };
};
