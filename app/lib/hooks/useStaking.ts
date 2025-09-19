/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback } from 'react';
import { usePolkadotApi } from '@/app/lib/polkadot-api-context';
import { useWalletAuth } from '@/app/lib/wallet-auth-context';
import { BN } from '@polkadot/util';

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
    }>;
}

interface StakingOperations {
    bond: (amount: string) => Promise<void>;
    bondExtra: (amount: string) => Promise<void>;
    unbond: (amount: string) => Promise<void>;
    withdrawUnbonded: () => Promise<void>;
    claimRewards: () => Promise<void>;
}

export const useStaking = () => {
    const { api, isConnected } = usePolkadotApi();
    const { polkadotAddress, walletManager } = useWalletAuth();
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
            return;
        }

        setStakingInfo(prev => ({ ...prev, isLoading: true, error: null }));

        try {
            // Get bonded amount - try different approaches
            let bondedAmount = '0';

            // Method 1: Try to get bonded amount directly from staking.bonded
            try {
                const bondedQuery = await api.query.staking.bonded(polkadotAddress);
                if (bondedQuery && !(bondedQuery as any).isEmpty) {
                    // If bonded, get the ledger for the controller
                    const controllerAddress = (bondedQuery as any).unwrapOr(null);
                    if (controllerAddress) {
                        const ledger = await api.query.staking.ledger(controllerAddress);
                        if (ledger && (ledger as any).isSome) {
                            const stakingLedger = (ledger as any).unwrap();
                            bondedAmount = stakingLedger.active.toString();
                        }
                    }
                }
            } catch (error) {
                console.warn('Method 1 failed:', error);
            }

            // Method 2: If Method 1 failed, try direct ledger query
            if (bondedAmount === '0') {
                try {
                    const ledger = await api.query.staking.ledger(polkadotAddress);
                    if (ledger && (ledger as any).isSome) {
                        const stakingLedger = (ledger as any).unwrap();
                        bondedAmount = stakingLedger.active.toString();
                    }
                } catch (error) {
                    console.warn('Method 2 failed:', error);
                }
            }

            // Method 3: Try using derive API
            if (bondedAmount === '0') {
                try {
                    const stakingAccount = await api.derive.staking.account(polkadotAddress);
                    if (stakingAccount && stakingAccount.stakingLedger) {
                        bondedAmount = stakingAccount.stakingLedger.active.toString();
                    }
                } catch (error) {
                    console.warn('Method 3 failed:', error);
                }
            }

            // Get pending rewards
            let rewardsAmount = '0';
            try {
                const stakingAccount = await api.derive.staking.account(polkadotAddress);
                if (stakingAccount && stakingAccount.redeemable) {
                    rewardsAmount = stakingAccount.redeemable.toString();
                }
            } catch (error) {
                console.warn('Could not fetch rewards:', error);
            }

            // Get unbonding and withdrawable amounts
            let unbondingAmount = '0';
            let withdrawableAmount = '0';
            const unbondingPeriods: Array<{ amount: string; era: number; remainingEras: number }> = [];

            try {
                // Get current era
                const currentEra = await api.query.staking.currentEra();
                const currentEraNumber = currentEra && !(currentEra as any).isNone
                    ? (currentEra as any).unwrap().toNumber()
                    : 0;

                // Method 1: Try derive API first
                try {
                    const stakingAccount = await api.derive.staking.account(polkadotAddress);
                    if (stakingAccount && stakingAccount.unlocking) {
                        let totalUnbonding = new BN(0);
                        let totalWithdrawable = new BN(0);

                        stakingAccount.unlocking.forEach((unlock: any) => {
                            const unlockEra = unlock.era.toNumber();
                            const amount = unlock.value.toString();
                            const remainingEras = Math.max(0, unlockEra - currentEraNumber);

                            if (remainingEras === 0) {
                                totalWithdrawable = totalWithdrawable.add(new BN(amount));
                            } else {
                                totalUnbonding = totalUnbonding.add(new BN(amount));
                                unbondingPeriods.push({
                                    amount,
                                    era: unlockEra,
                                    remainingEras
                                });
                            }
                        });

                        unbondingAmount = totalUnbonding.toString();
                        withdrawableAmount = totalWithdrawable.toString();
                    }
                } catch (error) {
                    console.warn('Derive API method failed, trying direct ledger:', error);

                    // Method 2: Direct ledger query
                    const ledger = await api.query.staking.ledger(polkadotAddress);
                    if (ledger && (ledger as any).isSome) {
                        const stakingLedger = (ledger as any).unwrap();
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
                                    unbondingPeriods.push({
                                        amount,
                                        era: unlockEra,
                                        remainingEras
                                    });
                                }
                            });

                            unbondingAmount = totalUnbonding.toString();
                            withdrawableAmount = totalWithdrawable.toString();
                        }
                    }
                }
            } catch (error) {
                console.warn('Could not fetch unbonding info:', error);
            }

            // Get free balance for staking
            let freeBalance = '0';
            try {
                const account = await api.query.system.account(polkadotAddress);
                if (account && (account as any).data) {
                    freeBalance = (account as any).data.free.toString();
                }
            } catch (error) {
                console.warn('Could not fetch free balance:', error);
            }

            console.log('Staking info fetched:', {
                bondedAmount,
                rewardsAmount,
                unbondingAmount,
                withdrawableAmount,
                freeBalance,
                unbondingPeriods
            });

            setStakingInfo({
                bonded: bondedAmount,
                rewards: rewardsAmount,
                unbonding: unbondingAmount,
                withdrawable: withdrawableAmount,
                balance: freeBalance,
                isLoading: false,
                error: null,
                unbondingPeriods,
            });
        } catch (error) {
            console.error('Error fetching staking info:', error);
            setStakingInfo(prev => ({
                ...prev,
                isLoading: false,
                error: error instanceof Error ? error.message : 'Failed to fetch staking info',
            }));
        }
    }, [api, isConnected, polkadotAddress]);

    // Bond tokens (first time staking or additional staking)
    const bond = useCallback(async (amount: string): Promise<void> => {
        if (!api || !polkadotAddress || !walletManager?.polkadotPair) {
            throw new Error('API, address, or wallet not available');
        }

        const amountBN = new BN(amount);

        // Check if user already has staked tokens
        const currentBonded = parseFloat(stakingInfo.bonded);

        let tx;
        if (currentBonded > 0) {
            // User already has staked tokens, use bondExtra
            console.log('Using bondExtra for existing staker');
            tx = api.tx.staking.bondExtra(amountBN);
        } else {
            // First time staking, use bond
            console.log('Using bond for new staker');
            tx = api.tx.staking.bond(amountBN, 'Staked');
        }

        return new Promise<void>((resolve, reject) => {
            tx.signAndSend(walletManager.polkadotPair, (result: any) => {
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
    }, [api, polkadotAddress, walletManager, fetchStakingInfo, stakingInfo.bonded]);

    // Add more tokens to existing bond
    const bondExtra = useCallback(async (amount: string): Promise<void> => {
        if (!api || !polkadotAddress || !walletManager?.polkadotPair) {
            throw new Error('API, address, or wallet not available');
        }

        const amountBN = new BN(amount);

        // Check if user has any bonded tokens
        const currentBonded = parseFloat(stakingInfo.bonded);
        if (currentBonded === 0) {
            throw new Error('No existing stake found. Use bond instead of bondExtra.');
        }

        console.log('Adding extra tokens to existing stake');
        const tx = api.tx.staking.bondExtra(amountBN);

        return new Promise<void>((resolve, reject) => {
            tx.signAndSend(walletManager.polkadotPair, (result: any) => {
                if (result.status.isFinalized) {
                    fetchStakingInfo(); // Refresh staking info
                    resolve();
                } else if (result.isError) {
                    reject(new Error('Transaction failed'));
                }
            }).catch(reject);
        });
    }, [api, polkadotAddress, walletManager, fetchStakingInfo, stakingInfo.bonded]);

    // Unbond tokens (schedule for withdrawal)
    const unbond = useCallback(async (amount: string): Promise<void> => {
        if (!api || !polkadotAddress || !walletManager?.polkadotPair) {
            throw new Error('API, address, or wallet not available');
        }

        const amountBN = new BN(amount);

        // Check if user has enough bonded tokens
        const currentBonded = new BN(stakingInfo.bonded);
        if (currentBonded.lt(amountBN)) {
            throw new Error('Insufficient bonded tokens for unbonding');
        }

        console.log('Unbonding tokens:', amount);
        const tx = api.tx.staking.unbond(amountBN);

        return new Promise<void>((resolve, reject) => {
            tx.signAndSend(walletManager.polkadotPair, (result: any) => {
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
    }, [api, polkadotAddress, walletManager, fetchStakingInfo, stakingInfo.bonded]);

    // Withdraw unbonded tokens after unbonding period
    const withdrawUnbonded = useCallback(async (): Promise<void> => {
        if (!api || !polkadotAddress || !walletManager?.polkadotPair) {
            throw new Error('API, address, or wallet not available');
        }

        // Get the number of slashing spans to determine the parameter
        const slashingSpans = await api.query.staking.slashingSpans(polkadotAddress);
        const numSlashingSpans = (slashingSpans as any).isSome ? (slashingSpans as any).unwrap().prior.length : 0;

        const tx = api.tx.staking.withdrawUnbonded(numSlashingSpans);

        return new Promise<void>((resolve, reject) => {
            tx.signAndSend(walletManager.polkadotPair, (result: any) => {
                if (result.status.isFinalized) {
                    fetchStakingInfo(); // Refresh staking info
                    resolve();
                } else if (result.isError) {
                    reject(new Error('Transaction failed'));
                }
            }).catch(reject);
        });
    }, [api, polkadotAddress, walletManager, fetchStakingInfo]);

    // Claim staking rewards
    const claimRewards = useCallback(async (): Promise<void> => {
        if (!api || !polkadotAddress || !walletManager?.polkadotPair) {
            throw new Error('API, address, or wallet not available');
        }

        // Get current era
        const currentEra = await api.query.staking.currentEra();
        if ((currentEra as any).isNone) {
            throw new Error('Current era not available');
        }

        const era = (currentEra as any).unwrap().toNumber();
        const tx = api.tx.staking.payoutStakers(polkadotAddress, era - 1); // Payout previous era

        return new Promise<void>((resolve, reject) => {
            tx.signAndSend(walletManager.polkadotPair, (result: any) => {
                if (result.status.isFinalized) {
                    fetchStakingInfo(); // Refresh staking info
                    resolve();
                } else if (result.isError) {
                    reject(new Error('Transaction failed'));
                }
            }).catch(reject);
        });
    }, [api, polkadotAddress, walletManager, fetchStakingInfo]);

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