import { useCallback } from 'react';
import { useWalletAuth } from '@/app/lib/wallet-auth-context';
import { useLocalWallet } from '@/app/contexts/LocalWalletContext';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { LIVE_DATA_REFRESH_MS } from '@/lib/constants';
import { resolveTxOutcome, type TxOutcome } from '@/lib/utils/txOutcome';

interface UnbondingPeriod {
    /** Raw planck amount as a decimal-digit string (full precision). */
    amount: string;
    /** Pre-formatted HIP display string from Rust `planck_to_hip`. */
    amountHip: string;
    era: number;
    remainingEras: number;
    /** Chain-precise block count until this chunk becomes withdrawable.
     *  Multiply by 6 (BABE block time) to render an "Nd Nh" countdown,
     *  matching hippius-web. `null` if the runtime didn't surface enough
     *  data to compute it; callers fall back to era count. */
    remainingBlocks?: number | null;
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
    /** True any time a fetch is in flight (initial load, manual refetch,
     *  or after a wallet switch invalidates the queryKey). Use this for
     *  card / table skeletons so the user sees a loading state when
     *  they swap wallets, instead of stale data lingering until the
     *  next tick. */
    isFetching: boolean;
    error: string | null;
}


interface StakingOperations {
    bond: (amount: string, password: string) => Promise<void>;
    bondExtra: (amount: string, password: string) => Promise<void>;
    unbond: (amount: string, password: string) => Promise<void>;
    withdrawUnbonded: (password: string) => Promise<void>;
    claimRewards: (password: string) => Promise<void>;
}

/**
 * Which account's staking state to fetch.
 *
 * - `"activeWallet"` (default): the active local wallet. Used by the
 *   wallet-page Stake/Unstake/Withdraw cards & dialogs so the figures
 *   reflect whichever wallet the user has selected in the header.
 * - `"auth"`: the auth/login account. Used by the global page header
 *   (Overview / Drive / Billing / etc.) so the stake figure stays
 *   stable as the user moves around the app and only changes wallet
 *   context inside `/wallet` itself.
 */
export type StakingAddressSource = "activeWallet" | "auth";

export const useStaking = (addressSource: StakingAddressSource = "activeWallet") => {
    const { polkadotAddress } = useWalletAuth();
    const { activeWallet } = useLocalWallet();
    const queryClient = useQueryClient();

    // Pick the address per the caller's intent. The auth address falls
    // back is intentional: while the local-wallet context is still
    // hydrating, "activeWallet" callers degrade to the auth address so
    // the card has *something* to show instead of "0".
    const address =
        addressSource === "auth"
            ? polkadotAddress
            : activeWallet?.address ?? polkadotAddress;

    const { data, isLoading, isFetching, error, refetch } = useQuery<StakingInfoResult>({
        queryKey: ['staking-info', addressSource, address],
        enabled: !!address,
        // Bonded/rewards/unbonding move every block; poll at block
        // cadence so stake screens track the chain in step with the
        // wallet balance (which shares the same constant).
        staleTime: 0,
        refetchOnWindowFocus: true,
        refetchInterval: LIVE_DATA_REFRESH_MS,
        queryFn: () => invoke<StakingInfoResult>('get_staking_info', { accountId: address }),
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
        isFetching,
        error: error ? (error instanceof Error ? error.message : 'Failed to fetch staking info') : null,
        unbondingPeriods: data?.unbondingPeriods ?? [],
    };

    const invalidate = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['staking-info'] });
        queryClient.invalidateQueries({ queryKey: ['hippius-balance'] });
    }, [queryClient]);

    // Each op invalidates BEFORE interpreting the outcome: a
    // `submittedUnconfirmed` tx may still land, so refreshing balances/staking
    // is useful regardless, and `resolveTxOutcome` then throws the right error
    // (incl. the no-retry `TxSubmittedUnconfirmedError`) for the dialog to show.
    const bond = useCallback(async (amount: string, password: string): Promise<void> => {
        const outcome = await invoke<TxOutcome>('stake_bond', { amount, password });
        invalidate();
        resolveTxOutcome(outcome);
    }, [invalidate]);

    const bondExtra = useCallback(async (amount: string, password: string): Promise<void> => {
        // stake_bond auto-detects whether to use bond or bond_extra
        const outcome = await invoke<TxOutcome>('stake_bond', { amount, password });
        invalidate();
        resolveTxOutcome(outcome);
    }, [invalidate]);

    const unbond = useCallback(async (amount: string, password: string): Promise<void> => {
        const outcome = await invoke<TxOutcome>('stake_unbond', { amount, password });
        invalidate();
        resolveTxOutcome(outcome);
    }, [invalidate]);

    const withdrawUnbonded = useCallback(async (password: string): Promise<void> => {
        const outcome = await invoke<TxOutcome>('stake_withdraw_unbonded', { password });
        invalidate();
        resolveTxOutcome(outcome);
    }, [invalidate]);

    const claimRewards = useCallback(async (password: string): Promise<void> => {
        const outcome = await invoke<TxOutcome>('stake_claim_rewards', { password });
        invalidate();
        resolveTxOutcome(outcome);
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
