import { useCallback } from 'react';
import { useWalletAuth } from '@/app/lib/wallet-auth-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { LIVE_DATA_REFRESH_MS } from '@/lib/constants';

interface UnbondingPeriod {
    /** Raw planck amount as a decimal-digit string (full precision). */
    amount: string;
    /** Pre-formatted HIP display string from Rust `planck_to_hip`. */
    amountHip: string;
    era: number;
    remainingEras: number;
}

/**
 * Every `*_hip` field is the Rust-formatted HIP display value for the
 * matching planck field. The planck strings stay the source of truth
 * for bigint math (validation, comparisons); the `*_hip` strings are
 * for rendering only. See `src-tauri/src/blockchain/convert.rs`.
 */
interface StakingInfoResult {
    bonded: string;
    bondedHip: string;
    rewards: string;
    rewardsHip: string;
    unbonding: string;
    unbondingHip: string;
    withdrawable: string;
    withdrawableHip: string;
    balance: string;
    balanceHip: string;
    availableBalance: string;
    availableBalanceHip: string;
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
    bond: (amount: string, password: string) => Promise<void>;
    bondExtra: (amount: string, password: string) => Promise<void>;
    unbond: (amount: string, password: string) => Promise<void>;
    withdrawUnbonded: (password: string) => Promise<void>;
    claimRewards: (password: string) => Promise<void>;
}

export const useStaking = () => {
    const { polkadotAddress } = useWalletAuth();
    const queryClient = useQueryClient();

    const { data, isLoading, error, refetch } = useQuery<StakingInfoResult>({
        queryKey: ['staking-info', polkadotAddress],
        enabled: !!polkadotAddress,
        // Bonded/rewards/unbonding move every block; poll at block
        // cadence so stake screens track the chain in step with the
        // wallet balance (which shares the same constant).
        staleTime: 0,
        refetchOnWindowFocus: true,
        refetchInterval: LIVE_DATA_REFRESH_MS,
        queryFn: () => invoke<StakingInfoResult>('get_staking_info'),
    });

    const stakingInfo: StakingInfo = {
        bonded: data?.bonded ?? '0',
        bondedHip: data?.bondedHip ?? '0',
        rewards: data?.rewards ?? '0',
        rewardsHip: data?.rewardsHip ?? '0',
        unbonding: data?.unbonding ?? '0',
        unbondingHip: data?.unbondingHip ?? '0',
        withdrawable: data?.withdrawable ?? '0',
        withdrawableHip: data?.withdrawableHip ?? '0',
        balance: data?.balance ?? '0',
        balanceHip: data?.balanceHip ?? '0',
        availableBalance: data?.availableBalance ?? '0',
        availableBalanceHip: data?.availableBalanceHip ?? '0',
        isLoading,
        error: error ? (error instanceof Error ? error.message : 'Failed to fetch staking info') : null,
        unbondingPeriods: data?.unbondingPeriods ?? [],
    };

    const invalidate = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['staking-info'] });
        queryClient.invalidateQueries({ queryKey: ['hippius-balance'] });
    }, [queryClient]);

    const bond = useCallback(async (amount: string, password: string): Promise<void> => {
        await invoke<TxResult>('stake_bond', { amount, password });
        invalidate();
    }, [invalidate]);

    const bondExtra = useCallback(async (amount: string, password: string): Promise<void> => {
        // stake_bond auto-detects whether to use bond or bond_extra
        await invoke<TxResult>('stake_bond', { amount, password });
        invalidate();
    }, [invalidate]);

    const unbond = useCallback(async (amount: string, password: string): Promise<void> => {
        await invoke<TxResult>('stake_unbond', { amount, password });
        invalidate();
    }, [invalidate]);

    const withdrawUnbonded = useCallback(async (password: string): Promise<void> => {
        await invoke<TxResult>('stake_withdraw_unbonded', { password });
        invalidate();
    }, [invalidate]);

    const claimRewards = useCallback(async (password: string): Promise<void> => {
        await invoke<TxResult>('stake_claim_rewards', { password });
        invalidate();
    }, [invalidate]);

    const operations: StakingOperations = {
        bond,
        bondExtra,
        unbond,
        withdrawUnbonded,
        claimRewards,
    };

    return {
        isLoading,
        stakingInfo,
        operations,
        refetch,
    };
};
