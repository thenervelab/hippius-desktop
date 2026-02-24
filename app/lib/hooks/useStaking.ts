/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback } from 'react';
import { usePolkadotApi } from '@/app/lib/polkadot-api-context';
import { useActiveWalletAddress } from '@/app/lib/hooks/useActiveWalletAddress';
import { BN } from '@polkadot/util';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import type { KeyringPair } from '@polkadot/keyring/types';

interface StakingInfo {
    bonded: string;
    rewards: string;
    unbonding: string; // Amount currently unbonding
    withdrawable: string; // Amount ready to withdraw
    balance: string; // Free balance for staking
    isLoading: boolean;
    error: string | null;
    unbondingPeriods: Array<{
        amount: string;
        era: number;
        remainingEras: number;
        remainingBlocks: number;
    }>;
}

interface StakingOperations {
    bond: (amount: string, mnemonic?: string) => Promise<void>;
    bondExtra: (amount: string, mnemonic?: string) => Promise<void>;
    unbond: (amount: string, mnemonic?: string) => Promise<void>;
    withdrawUnbonded: (mnemonic?: string) => Promise<void>;
    claimRewards: (mnemonic?: string) => Promise<void>;
}

export const useStaking = () => {
    const { api, isConnected } = usePolkadotApi();
    const polkadotAddress = useActiveWalletAddress();

    const [stakingInfo, setStakingInfo] = useState<StakingInfo>({
        bonded: '0',
        rewards: '0',
        unbonding: '0',
        withdrawable: '0',
        balance: '0',
        isLoading: false,
        error: null,
        unbondingPeriods: [],
    });

    // Fetch staking information
    const fetchStakingInfo = useCallback(async () => {
        if (!api || !isConnected || !polkadotAddress) {
            console.log('[useStaking] Missing dependencies:', { api: !!api, isConnected, polkadotAddress });
            return;
        }

        setStakingInfo(prev => ({ ...prev, isLoading: true, error: null }));

        console.log('[useStaking] ====== FETCHING STAKING INFO ======');
        console.log('[useStaking] Address being queried:', polkadotAddress);

        try {
            let bondedAmount = '0';
            let unbondingAmount = '0';
            let withdrawableAmount = '0';
            const unbondingPeriods: Array<{ amount: string; era: number; remainingEras: number; remainingBlocks: number }> = [];

            // Fetch session progress for era length info
            let eraLength = 0;
            let eraProgress = 0;
            try {
                const sessionProgress = await api.derive.session.progress();
                eraLength = sessionProgress?.eraLength?.toNumber?.() ?? 0;
                eraProgress = sessionProgress?.eraProgress?.toNumber?.() ?? 0;
            } catch (e) {
                console.warn('[useStaking] Could not fetch session progress:', e);
            }

            // Primary method: Use derive API (single call for all data)
            try {
                const stakingAccount = await api.derive.staking.account(polkadotAddress);
                console.log('[useStaking] Derive API result:', {
                    hasStakingLedger: !!stakingAccount?.stakingLedger,
                    activeStake: stakingAccount?.stakingLedger?.active?.toString(),
                    redeemable: stakingAccount?.redeemable?.toString(),
                    unlockingCount: stakingAccount?.unlocking?.length,
                });

                // Bonded (active stake)
                if (stakingAccount?.stakingLedger) {
                    bondedAmount = stakingAccount.stakingLedger.active.toString();
                }

                // Redeemable = withdrawable (funds that finished unbonding)
                if (stakingAccount?.redeemable) {
                    withdrawableAmount = stakingAccount.redeemable.toString();
                }

                // Process unlocking entries for unbonding info
                if (stakingAccount?.unlocking) {
                    let totalUnbonding = new BN(0);

                    stakingAccount.unlocking.forEach((unlock: any) => {
                        const amount = unlock.value.toString();
                        const remainingEras = unlock.remainingEras?.toNumber?.() ?? 0;
                        const unlockEra = unlock.era?.toNumber?.() ?? 0;

                        // Only count as unbonding if there are remaining eras
                        // Items with remainingEras === 0 are already in redeemable
                        if (remainingEras > 0) {
                            totalUnbonding = totalUnbonding.add(new BN(amount));
                            const remainingBlocks = eraLength > 0
                                ? (remainingEras - 1) * eraLength + (eraLength - eraProgress)
                                : 0;
                            unbondingPeriods.push({
                                amount,
                                era: unlockEra,
                                remainingEras,
                                remainingBlocks: Math.max(0, remainingBlocks),
                            });
                        }
                    });

                    unbondingAmount = totalUnbonding.toString();
                }

                console.log('[useStaking] Parsed values:', {
                    bondedAmount,
                    withdrawableAmount,
                    unbondingAmount,
                    unbondingPeriods,
                });
            } catch (deriveError) {
                console.warn('[useStaking] Derive API failed, falling back to direct queries:', deriveError);

                // Fallback: Direct ledger queries
                try {
                    const bondedQuery = await api.query.staking.bonded(polkadotAddress);
                    if (bondedQuery && !(bondedQuery as any).isEmpty) {
                        const controllerAddress = (bondedQuery as any).unwrapOr(null);
                        if (controllerAddress) {
                            const ledger = await api.query.staking.ledger(controllerAddress);
                            if (ledger && (ledger as any).isSome) {
                                const stakingLedger = (ledger as any).unwrap();
                                bondedAmount = stakingLedger.active.toString();

                                // Get current era for unbonding calculation
                                const currentEra = await api.query.staking.currentEra();
                                const currentEraNumber = currentEra && !(currentEra as any).isNone
                                    ? (currentEra as any).unwrap().toNumber()
                                    : 0;

                                if (stakingLedger.unlocking) {
                                    let totalUnbonding = new BN(0);
                                    let totalWithdrawable = new BN(0);

                                    stakingLedger.unlocking.forEach((unlock: any) => {
                                        const unlockEra = unlock.era.toNumber();
                                        const amount = unlock.value.toString();
                                        const remainingEras = Math.max(0, unlockEra - currentEraNumber);

                                        if (remainingEras === 0) {
                                            totalWithdrawable = totalWithdrawable.add(new BN(amount));
                                        } else {
                                            totalUnbonding = totalUnbonding.add(new BN(amount));
                                            const remainingBlocks = eraLength > 0
                                                ? (remainingEras - 1) * eraLength + (eraLength - eraProgress)
                                                : 0;
                                            unbondingPeriods.push({
                                                amount,
                                                era: unlockEra,
                                                remainingEras,
                                                remainingBlocks: Math.max(0, remainingBlocks),
                                            });
                                        }
                                    });

                                    unbondingAmount = totalUnbonding.toString();
                                    withdrawableAmount = totalWithdrawable.toString();
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.warn('[useStaking] Direct ledger query also failed:', error);
                }
            }

            // Get free balance for staking
            let freeBalance = '0';
            try {
                const account = await api.query.system.account(polkadotAddress);
                if (account && (account as any).data) {
                    freeBalance = (account as any).data.free.toString();
                }
            } catch (error) {
                console.warn('[useStaking] Could not fetch free balance:', error);
            }

            console.log('[useStaking] Final staking info:', {
                bondedAmount,
                unbondingAmount,
                withdrawableAmount,
                freeBalance,
                unbondingPeriods
            });

            setStakingInfo({
                bonded: bondedAmount,
                rewards: '0', // Rewards are tracked separately if needed
                unbonding: unbondingAmount,
                withdrawable: withdrawableAmount,
                balance: freeBalance,
                isLoading: false,
                error: null,
                unbondingPeriods,
            });
        } catch (error) {
            console.error('[useStaking] Error fetching staking info:', error);
            setStakingInfo(prev => ({
                ...prev,
                isLoading: false,
                error: error instanceof Error ? error.message : 'Failed to fetch staking info',
            }));
        }
    }, [api, isConnected, polkadotAddress]);

    // Helper to get a signing pair from mnemonic
    const getSigningPair = useCallback(async (mnemonic?: string): Promise<KeyringPair> => {
        if (!mnemonic) {
            throw new Error('Mnemonic required for signing transaction');
        }
        await cryptoWaitReady();
        const keyring = new Keyring({ type: 'sr25519' });
        return keyring.addFromMnemonic(mnemonic);
    }, []);

    // Bond tokens (first time staking or additional staking)
    const bond = useCallback(async (amount: string, mnemonic?: string): Promise<void> => {
        if (!api || !polkadotAddress) {
            throw new Error('API or address not available');
        }

        const signingPair = await getSigningPair(mnemonic);
        const amountBN = new BN(amount);

        // Check if user has ANY existing staking ledger
        // A ledger exists if there are bonded, unbonding, OR withdrawable funds
        // Using bond() when a ledger exists will fail - must use bondExtra()
        const currentBonded = parseFloat(stakingInfo.bonded) || 0;
        const currentUnbonding = parseFloat(stakingInfo.unbonding) || 0;
        const currentWithdrawable = parseFloat(stakingInfo.withdrawable) || 0;
        const hasExistingLedger = currentBonded > 0 || currentUnbonding > 0 || currentWithdrawable > 0;

        console.log('[useStaking] Bond decision:', {
            bonded: currentBonded,
            unbonding: currentUnbonding,
            withdrawable: currentWithdrawable,
            hasExistingLedger,
            willUseBondExtra: hasExistingLedger,
        });

        let tx;
        if (hasExistingLedger) {
            // User has a staking ledger (active stake, unbonding, or withdrawable funds)
            // Must use bondExtra to add more to existing ledger
            console.log('Using bondExtra for existing staker (ledger exists)');
            tx = api.tx.staking.bondExtra(amountBN);
        } else {
            // First time staking, no existing ledger - use bond
            console.log('Using bond for new staker (no ledger)');
            tx = api.tx.staking.bond(amountBN, 'Staked');
        }

        return new Promise<void>((resolve, reject) => {
            tx.signAndSend(signingPair, (result: any) => {
                if (result.status.isInBlock) {
                    console.log('Transaction included in block');
                } else if (result.status.isFinalized) {
                    console.log('Transaction finalized');
                    fetchStakingInfo(); // Refresh staking info
                    resolve();
                } else if (result.isError) {
                    reject(new Error('Transaction failed'));
                }
            }).catch(reject);
        });
    }, [api, polkadotAddress, getSigningPair, fetchStakingInfo, stakingInfo.bonded, stakingInfo.unbonding, stakingInfo.withdrawable]);

    // Add more tokens to existing bond
    const bondExtra = useCallback(async (amount: string, mnemonic?: string): Promise<void> => {
        if (!api || !polkadotAddress) {
            throw new Error('API or address not available');
        }

        const signingPair = await getSigningPair(mnemonic);
        const amountBN = new BN(amount);

        // Check if user has any existing staking ledger (bonded, unbonding, or withdrawable)
        const currentBonded = parseFloat(stakingInfo.bonded) || 0;
        const currentUnbonding = parseFloat(stakingInfo.unbonding) || 0;
        const currentWithdrawable = parseFloat(stakingInfo.withdrawable) || 0;
        const hasExistingLedger = currentBonded > 0 || currentUnbonding > 0 || currentWithdrawable > 0;

        if (!hasExistingLedger) {
            throw new Error('No existing stake found. Use bond instead of bondExtra.');
        }

        console.log('Adding extra tokens to existing stake');
        const tx = api.tx.staking.bondExtra(amountBN);

        return new Promise<void>((resolve, reject) => {
            tx.signAndSend(signingPair, (result: any) => {
                if (result.status.isFinalized) {
                    fetchStakingInfo(); // Refresh staking info
                    resolve();
                } else if (result.isError) {
                    reject(new Error('Transaction failed'));
                }
            }).catch(reject);
        });
    }, [api, polkadotAddress, getSigningPair, fetchStakingInfo, stakingInfo.bonded, stakingInfo.unbonding, stakingInfo.withdrawable]);

    // Unbond tokens (schedule for withdrawal)
    const unbond = useCallback(async (amount: string, mnemonic?: string): Promise<void> => {
        if (!api || !polkadotAddress) {
            throw new Error('API or address not available');
        }

        const signingPair = await getSigningPair(mnemonic);
        const amountBN = new BN(amount);

        // Check if user has enough bonded tokens
        const currentBonded = new BN(stakingInfo.bonded);
        if (currentBonded.lt(amountBN)) {
            throw new Error('Insufficient bonded tokens for unbonding');
        }

        console.log('Unbonding tokens:', amount);
        const tx = api.tx.staking.unbond(amountBN);

        return new Promise<void>((resolve, reject) => {
            tx.signAndSend(signingPair, (result: any) => {
                if (result.status.isInBlock) {
                    console.log('Unbond transaction included in block');
                } else if (result.status.isFinalized) {
                    console.log('Unbond transaction finalized');
                    fetchStakingInfo(); // Refresh staking info
                    resolve();
                } else if (result.isError) {
                    reject(new Error('Unbond transaction failed'));
                }
            }).catch(reject);
        });
    }, [api, polkadotAddress, getSigningPair, fetchStakingInfo, stakingInfo.bonded]);

    // Withdraw unbonded tokens after unbonding period
    const withdrawUnbonded = useCallback(async (mnemonic?: string): Promise<void> => {
        if (!api || !polkadotAddress) {
            throw new Error('API or address not available');
        }

        const signingPair = await getSigningPair(mnemonic);

        // Get the number of slashing spans to determine the parameter
        const slashingSpans = await api.query.staking.slashingSpans(polkadotAddress);
        const numSlashingSpans = (slashingSpans as any).isSome ? (slashingSpans as any).unwrap().prior.length : 0;

        const tx = api.tx.staking.withdrawUnbonded(numSlashingSpans);

        return new Promise<void>((resolve, reject) => {
            tx.signAndSend(signingPair, (result: any) => {
                if (result.status.isFinalized) {
                    fetchStakingInfo(); // Refresh staking info
                    resolve();
                } else if (result.isError) {
                    reject(new Error('Transaction failed'));
                }
            }).catch(reject);
        });
    }, [api, polkadotAddress, getSigningPair, fetchStakingInfo]);

    // Claim staking rewards
    const claimRewards = useCallback(async (mnemonic?: string): Promise<void> => {
        if (!api || !polkadotAddress) {
            throw new Error('API or address not available');
        }

        const signingPair = await getSigningPair(mnemonic);

        // Get current era
        const currentEra = await api.query.staking.currentEra();
        if ((currentEra as any).isNone) {
            throw new Error('Current era not available');
        }

        const era = (currentEra as any).unwrap().toNumber();
        const tx = api.tx.staking.payoutStakers(polkadotAddress, era - 1); // Payout previous era

        return new Promise<void>((resolve, reject) => {
            tx.signAndSend(signingPair, (result: any) => {
                if (result.status.isFinalized) {
                    fetchStakingInfo(); // Refresh staking info
                    resolve();
                } else if (result.isError) {
                    reject(new Error('Transaction failed'));
                }
            }).catch(reject);
        });
    }, [api, polkadotAddress, getSigningPair, fetchStakingInfo]);

    // Fetch staking info on mount and when dependencies change
    useEffect(() => {
        fetchStakingInfo();
    }, [fetchStakingInfo]);

    const operations: StakingOperations = {
        bond,
        bondExtra,
        unbond,
        withdrawUnbonded,
        claimRewards,
    };

    return {
        stakingInfo,
        operations,
        refetch: fetchStakingInfo,
    };
};