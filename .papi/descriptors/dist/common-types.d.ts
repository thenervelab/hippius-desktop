import { Enum, GetEnum, FixedSizeBinary, Binary, SS58String, FixedSizeArray, ResultPayload, TxCallData } from "polkadot-api";
type AnonymousEnum<T extends {}> = T & {
    __anonymous: true;
};
type MyTuple<T> = [T, ...T[]];
type SeparateUndefined<T> = undefined extends T ? undefined | Exclude<T, undefined> : T;
type Anonymize<T> = SeparateUndefined<T extends FixedSizeBinary<infer L> ? number extends L ? Binary : FixedSizeBinary<L> : T extends string | number | bigint | boolean | void | undefined | null | symbol | Uint8Array | Enum<any> ? T : T extends AnonymousEnum<infer V> ? Enum<V> : T extends MyTuple<any> ? {
    [K in keyof T]: T[K];
} : T extends [] ? [] : T extends FixedSizeArray<infer L, infer T> ? number extends L ? Array<T> : FixedSizeArray<L, T> : {
    [K in keyof T & string]: T[K];
}>;
export type I5sesotjlssv2d = {
    "nonce": number;
    "consumers": number;
    "providers": number;
    "sufficients": number;
    "data": Anonymize<I1q8tnt1cluu5j>;
};
export type I1q8tnt1cluu5j = {
    "free": bigint;
    "reserved": bigint;
    "frozen": bigint;
    "flags": bigint;
};
export type Iffmde3ekjedi9 = {
    "normal": Anonymize<I4q39t5hn830vp>;
    "operational": Anonymize<I4q39t5hn830vp>;
    "mandatory": Anonymize<I4q39t5hn830vp>;
};
export type I4q39t5hn830vp = {
    "ref_time": bigint;
    "proof_size": bigint;
};
export type I4mddgoa69c0a2 = Array<DigestItem>;
export type DigestItem = Enum<{
    "PreRuntime": Anonymize<I82jm9g7pufuel>;
    "Consensus": Anonymize<I82jm9g7pufuel>;
    "Seal": Anonymize<I82jm9g7pufuel>;
    "Other": Binary;
    "RuntimeEnvironmentUpdated": undefined;
}>;
export declare const DigestItem: GetEnum<DigestItem>;
export type I82jm9g7pufuel = [FixedSizeBinary<4>, Binary];
export type Idl4dgic8j220i = Array<{
    "phase": Phase;
    "event": Enum<{
        "System": Anonymize<I2lu8pqhpk1lb9>;
        "Grandpa": GrandpaEvent;
        "Balances": Anonymize<Iao8h4hv7atnq3>;
        "TransactionPayment": TransactionPaymentEvent;
        "SubtensorModule": Anonymize<Ibu2ckjkstfafe>;
        "Utility": Anonymize<I52pu5gv23r3k6>;
        "Sudo": Anonymize<Idqut36jj64f22>;
        "Multisig": Anonymize<I60q3b713p0n0u>;
        "Preimage": PreimageEvent;
        "Scheduler": Anonymize<Ienedd7ri3a5g4>;
        "Proxy": Anonymize<Icrtnu35ghu428>;
        "Registry": Anonymize<I626vh1cit09ni>;
        "Commitments": Anonymize<I5ohlg8gv4pe9g>;
        "AdminUtils": Anonymize<Ic1vmbif9o0nug>;
        "SafeMode": Anonymize<I3q8c83f5dvokp>;
        "Ethereum": Anonymize<I510u4q1qqh897>;
        "EVM": Anonymize<I9k071kk4cn1u8>;
        "BaseFee": Anonymize<I3bmatomsds8j7>;
        "Drand": Anonymize<Ibdlgbf9b95hbj>;
        "Crowdloan": Anonymize<Ifj1h07t3i0np9>;
        "Swap": Anonymize<I65ga25qerlven>;
        "Contracts": Anonymize<I211sbjvh5hjqu>;
        "MevShield": Anonymize<I28unbqdbn1vpg>;
    }>;
    "topics": Anonymize<Ic5m5lp1oioo8r>;
}>;
export type Phase = Enum<{
    "ApplyExtrinsic": number;
    "Finalization": undefined;
    "Initialization": undefined;
}>;
export declare const Phase: GetEnum<Phase>;
export type I2lu8pqhpk1lb9 = AnonymousEnum<{
    /**
     * An extrinsic completed successfully.
     */
    "ExtrinsicSuccess": Anonymize<Ia82mnkmeo2rhc>;
    /**
     * An extrinsic failed.
     */
    "ExtrinsicFailed": Anonymize<I6jv8i738ud2so>;
    /**
     * `:code` was updated.
     */
    "CodeUpdated": undefined;
    /**
     * A new account was created.
     */
    "NewAccount": Anonymize<Icbccs0ug47ilf>;
    /**
     * An account was reaped.
     */
    "KilledAccount": Anonymize<Icbccs0ug47ilf>;
    /**
     * On on-chain remark happened.
     */
    "Remarked": Anonymize<I855j4i3kr8ko1>;
    /**
     * An upgrade was authorized.
     */
    "UpgradeAuthorized": Anonymize<Ibgl04rn6nbfm6>;
    /**
     * An invalid authorized upgrade was rejected while trying to apply it.
     */
    "RejectedInvalidAuthorizedUpgrade": Anonymize<I4n7lnouhqs6pg>;
}>;
export type Ia82mnkmeo2rhc = {
    "dispatch_info": Anonymize<Ic9s8f85vjtncc>;
};
export type Ic9s8f85vjtncc = {
    "weight": Anonymize<I4q39t5hn830vp>;
    "class": DispatchClass;
    "pays_fee": Anonymize<Iehg04bj71rkd>;
};
export type DispatchClass = Enum<{
    "Normal": undefined;
    "Operational": undefined;
    "Mandatory": undefined;
}>;
export declare const DispatchClass: GetEnum<DispatchClass>;
export type Iehg04bj71rkd = AnonymousEnum<{
    "Yes": undefined;
    "No": undefined;
}>;
export type I6jv8i738ud2so = {
    "dispatch_error": Anonymize<I6orop8m3bqhqc>;
    "dispatch_info": Anonymize<Ic9s8f85vjtncc>;
};
export type I6orop8m3bqhqc = AnonymousEnum<{
    "Other": undefined;
    "CannotLookup": undefined;
    "BadOrigin": undefined;
    "Module": Enum<{
        "System": Anonymize<I5o0s7c8q1cc9b>;
        "RandomnessCollectiveFlip": undefined;
        "Timestamp": undefined;
        "Aura": undefined;
        "Grandpa": Anonymize<I7q8i0pp1gkas6>;
        "Balances": Anonymize<Idj13i7adlomht>;
        "TransactionPayment": undefined;
        "SubtensorModule": Anonymize<Ib31febi51tc1>;
        "Utility": Anonymize<I499qmubmch1cg>;
        "Sudo": Anonymize<Iaug04qjhbli00>;
        "Multisig": Anonymize<Ia76qmhhg4jvb9>;
        "Preimage": Anonymize<I4cfhml1prt4lu>;
        "Scheduler": Anonymize<If7oa8fprnilo5>;
        "Proxy": Anonymize<I7ae37ntp06co6>;
        "Registry": Anonymize<Id6jmtdau2lr6l>;
        "Commitments": Anonymize<I8a8dfn9etteh2>;
        "AdminUtils": Anonymize<I8br6rdnlvg28h>;
        "SafeMode": Anonymize<I65gapcjsc3grr>;
        "Ethereum": Anonymize<I1mp6vnoh32l4q>;
        "EVM": Anonymize<I226s9mgj51cd2>;
        "EVMChainId": undefined;
        "BaseFee": undefined;
        "Drand": Anonymize<I8veee4gumsdel>;
        "Crowdloan": Anonymize<I1ots9pukq67tt>;
        "Swap": Anonymize<I13bhbt5dau63n>;
        "Contracts": Anonymize<I2489g9rnboo1t>;
        "MevShield": Anonymize<I4ngcc5keahtro>;
    }>;
    "ConsumerRemaining": undefined;
    "NoProviders": undefined;
    "TooManyConsumers": undefined;
    "Token": TokenError;
    "Arithmetic": ArithmeticError;
    "Transactional": TransactionalError;
    "Exhausted": undefined;
    "Corruption": undefined;
    "Unavailable": undefined;
    "RootNotAllowed": undefined;
    "Trie": Enum<{
        "InvalidStateRoot": undefined;
        "IncompleteDatabase": undefined;
        "ValueAtIncompleteKey": undefined;
        "DecoderError": undefined;
        "InvalidHash": undefined;
        "DuplicateKey": undefined;
        "ExtraneousNode": undefined;
        "ExtraneousValue": undefined;
        "ExtraneousHashReference": undefined;
        "InvalidChildReference": undefined;
        "ValueMismatch": undefined;
        "IncompleteProof": undefined;
        "RootMismatch": undefined;
        "DecodeError": undefined;
    }>;
}>;
export type I5o0s7c8q1cc9b = AnonymousEnum<{
    /**
     * The name of specification does not match between the current runtime
     * and the new runtime.
     */
    "InvalidSpecName": undefined;
    /**
     * The specification version is not allowed to decrease between the current runtime
     * and the new runtime.
     */
    "SpecVersionNeedsToIncrease": undefined;
    /**
     * Failed to extract the runtime version from the new runtime.
     *
     * Either calling `Core_version` or decoding `RuntimeVersion` failed.
     */
    "FailedToExtractRuntimeVersion": undefined;
    /**
     * Suicide called when the account has non-default composite data.
     */
    "NonDefaultComposite": undefined;
    /**
     * There is a non-zero reference count preventing the account from being purged.
     */
    "NonZeroRefCount": undefined;
    /**
     * The origin filter prevent the call to be dispatched.
     */
    "CallFiltered": undefined;
    /**
     * A multi-block migration is ongoing and prevents the current code from being replaced.
     */
    "MultiBlockMigrationsOngoing": undefined;
    /**
     * No upgrade authorized.
     */
    "NothingAuthorized": undefined;
    /**
     * The submitted code is not authorized.
     */
    "Unauthorized": undefined;
}>;
export type I7q8i0pp1gkas6 = AnonymousEnum<{
    /**
     * Attempt to signal GRANDPA pause when the authority set isn't live
     * (either paused or already pending pause).
     */
    "PauseFailed": undefined;
    /**
     * Attempt to signal GRANDPA resume when the authority set isn't paused
     * (either live or already pending resume).
     */
    "ResumeFailed": undefined;
    /**
     * Attempt to signal GRANDPA change with one already pending.
     */
    "ChangePending": undefined;
    /**
     * Cannot signal forced change so soon after last.
     */
    "TooSoon": undefined;
    /**
     * A key ownership proof provided as part of an equivocation report is invalid.
     */
    "InvalidKeyOwnershipProof": undefined;
    /**
     * An equivocation proof provided as part of an equivocation report is invalid.
     */
    "InvalidEquivocationProof": undefined;
    /**
     * A given equivocation report is valid but already previously reported.
     */
    "DuplicateOffenceReport": undefined;
}>;
export type Idj13i7adlomht = AnonymousEnum<{
    /**
     * Vesting balance too high to send value.
     */
    "VestingBalance": undefined;
    /**
     * Account liquidity restrictions prevent withdrawal.
     */
    "LiquidityRestrictions": undefined;
    /**
     * Balance too low to send value.
     */
    "InsufficientBalance": undefined;
    /**
     * Value too low to create account due to existential deposit.
     */
    "ExistentialDeposit": undefined;
    /**
     * Transfer/payment would kill account.
     */
    "Expendability": undefined;
    /**
     * A vesting schedule already exists for this account.
     */
    "ExistingVestingSchedule": undefined;
    /**
     * Beneficiary account must pre-exist.
     */
    "DeadAccount": undefined;
    /**
     * Number of named reserves exceed `MaxReserves`.
     */
    "TooManyReserves": undefined;
    /**
     * Number of holds exceed `VariantCountOf<T::RuntimeHoldReason>`.
     */
    "TooManyHolds": undefined;
    /**
     * Number of freezes exceed `MaxFreezes`.
     */
    "TooManyFreezes": undefined;
    /**
     * The issuance cannot be modified since it is already deactivated.
     */
    "IssuanceDeactivated": undefined;
    /**
     * The delta cannot be zero.
     */
    "DeltaZero": undefined;
}>;
export type Ib31febi51tc1 = AnonymousEnum<{
    /**
     * The root network does not exist.
     */
    "RootNetworkDoesNotExist": undefined;
    /**
     * The user is trying to serve an axon which is not of type 4 (IPv4) or 6 (IPv6).
     */
    "InvalidIpType": undefined;
    /**
     * An invalid IP address is passed to the serve function.
     */
    "InvalidIpAddress": undefined;
    /**
     * An invalid port is passed to the serve function.
     */
    "InvalidPort": undefined;
    /**
     * The hotkey is not registered in subnet
     */
    "HotKeyNotRegisteredInSubNet": undefined;
    /**
     * The hotkey does not exists
     */
    "HotKeyAccountNotExists": undefined;
    /**
     * The hotkey is not registered in any subnet.
     */
    "HotKeyNotRegisteredInNetwork": undefined;
    /**
     * Request to stake, unstake or subscribe is made by a coldkey that is not associated with
     * the hotkey account.
     */
    "NonAssociatedColdKey": undefined;
    /**
     * DEPRECATED: Stake amount to withdraw is zero.
     * The caller does not have enought stake to perform this action.
     */
    "NotEnoughStake": undefined;
    /**
     * The caller is requesting removing more stake than there exists in the staking account.
     * See: "[remove_stake()]".
     */
    "NotEnoughStakeToWithdraw": undefined;
    /**
     * The caller is requesting to set weights but the caller has less than minimum stake
     * required to set weights (less than WeightsMinStake).
     */
    "NotEnoughStakeToSetWeights": undefined;
    /**
     * The parent hotkey doesn't have enough own stake to set childkeys.
     */
    "NotEnoughStakeToSetChildkeys": undefined;
    /**
     * The caller is requesting adding more stake than there exists in the coldkey account.
     * See: "[add_stake()]"
     */
    "NotEnoughBalanceToStake": undefined;
    /**
     * The caller is trying to add stake, but for some reason the requested amount could not be
     * withdrawn from the coldkey account.
     */
    "BalanceWithdrawalError": undefined;
    /**
     * Unsuccessfully withdraw, balance could be zero (can not make account exist) after
     * withdrawal.
     */
    "ZeroBalanceAfterWithdrawn": undefined;
    /**
     * The caller is attempting to set non-self weights without being a permitted validator.
     */
    "NeuronNoValidatorPermit": undefined;
    /**
     * The caller is attempting to set the weight keys and values but these vectors have
     * different size.
     */
    "WeightVecNotEqualSize": undefined;
    /**
     * The caller is attempting to set weights with duplicate UIDs in the weight matrix.
     */
    "DuplicateUids": undefined;
    /**
     * The caller is attempting to set weight to at least one UID that does not exist in the
     * metagraph.
     */
    "UidVecContainInvalidOne": undefined;
    /**
     * The dispatch is attempting to set weights on chain with fewer elements than are allowed.
     */
    "WeightVecLengthIsLow": undefined;
    /**
     * Number of registrations in this block exceeds the allowed number (i.e., exceeds the
     * subnet hyperparameter "max_regs_per_block").
     */
    "TooManyRegistrationsThisBlock": undefined;
    /**
     * The caller is requesting registering a neuron which already exists in the active set.
     */
    "HotKeyAlreadyRegisteredInSubNet": undefined;
    /**
     * The new hotkey is the same as old one
     */
    "NewHotKeyIsSameWithOld": undefined;
    /**
     * The supplied PoW hash block is in the future or negative.
     */
    "InvalidWorkBlock": undefined;
    /**
     * The supplied PoW hash block does not meet the network difficulty.
     */
    "InvalidDifficulty": undefined;
    /**
     * The supplied PoW hash seal does not match the supplied work.
     */
    "InvalidSeal": undefined;
    /**
     * The dispatch is attempting to set weights on chain with weight value exceeding the
     * configured max weight limit (currently `u16::MAX`).
     */
    "MaxWeightExceeded": undefined;
    /**
     * The hotkey is attempting to become a delegate when the hotkey is already a delegate.
     */
    "HotKeyAlreadyDelegate": undefined;
    /**
     * A transactor exceeded the rate limit for setting weights.
     */
    "SettingWeightsTooFast": undefined;
    /**
     * A validator is attempting to set weights from a validator with incorrect weight version.
     */
    "IncorrectWeightVersionKey": undefined;
    /**
     * An axon or prometheus serving exceeded the rate limit for a registered neuron.
     */
    "ServingRateLimitExceeded": undefined;
    /**
     * The caller is attempting to set weights with more UIDs than allowed.
     */
    "UidsLengthExceedUidsInSubNet": undefined;
    /**
     * A transactor exceeded the rate limit for add network transaction.
     */
    "NetworkTxRateLimitExceeded": undefined;
    /**
     * A transactor exceeded the rate limit for delegate transaction.
     */
    "DelegateTxRateLimitExceeded": undefined;
    /**
     * A transactor exceeded the rate limit for setting or swapping hotkey.
     */
    "HotKeySetTxRateLimitExceeded": undefined;
    /**
     * A transactor exceeded the rate limit for staking.
     */
    "StakingRateLimitExceeded": undefined;
    /**
     * Registration is disabled.
     */
    "SubNetRegistrationDisabled": undefined;
    /**
     * The number of registration attempts exceeded the allowed number in the interval.
     */
    "TooManyRegistrationsThisInterval": undefined;
    /**
     * The hotkey is required to be the origin.
     */
    "TransactorAccountShouldBeHotKey": undefined;
    /**
     * Faucet is disabled.
     */
    "FaucetDisabled": undefined;
    /**
     * Not a subnet owner.
     */
    "NotSubnetOwner": undefined;
    /**
     * Operation is not permitted on the root subnet.
     */
    "RegistrationNotPermittedOnRootSubnet": undefined;
    /**
     * A hotkey with too little stake is attempting to join the root subnet.
     */
    "StakeTooLowForRoot": undefined;
    /**
     * All subnets are in the immunity period.
     */
    "AllNetworksInImmunity": undefined;
    /**
     * Not enough balance to pay swapping hotkey.
     */
    "NotEnoughBalanceToPaySwapHotKey": undefined;
    /**
     * Netuid does not match for setting root network weights.
     */
    "NotRootSubnet": undefined;
    /**
     * Can not set weights for the root network.
     */
    "CanNotSetRootNetworkWeights": undefined;
    /**
     * No neuron ID is available.
     */
    "NoNeuronIdAvailable": undefined;
    /**
     * Delegate take is too low.
     */
    "DelegateTakeTooLow": undefined;
    /**
     * Delegate take is too high.
     */
    "DelegateTakeTooHigh": undefined;
    /**
     * No commit found for the provided hotkey+netuid combination when attempting to reveal the
     * weights.
     */
    "NoWeightsCommitFound": undefined;
    /**
     * Committed hash does not equal the hashed reveal data.
     */
    "InvalidRevealCommitHashNotMatch": undefined;
    /**
     * Attempting to call set_weights when commit/reveal is enabled
     */
    "CommitRevealEnabled": undefined;
    /**
     * Attemtping to commit/reveal weights when disabled.
     */
    "CommitRevealDisabled": undefined;
    /**
     * Attempting to set alpha high/low while disabled
     */
    "LiquidAlphaDisabled": undefined;
    /**
     * Alpha high is too low: alpha_high > 0.8
     */
    "AlphaHighTooLow": undefined;
    /**
     * Alpha low is out of range: alpha_low > 0 && alpha_low < 0.8
     */
    "AlphaLowOutOfRange": undefined;
    /**
     * The coldkey has already been swapped
     */
    "ColdKeyAlreadyAssociated": undefined;
    /**
     * The coldkey balance is not enough to pay for the swap
     */
    "NotEnoughBalanceToPaySwapColdKey": undefined;
    /**
     * Attempting to set an invalid child for a hotkey on a network.
     */
    "InvalidChild": undefined;
    /**
     * Duplicate child when setting children.
     */
    "DuplicateChild": undefined;
    /**
     * Proportion overflow when setting children.
     */
    "ProportionOverflow": undefined;
    /**
     * Too many children MAX 5.
     */
    "TooManyChildren": undefined;
    /**
     * Default transaction rate limit exceeded.
     */
    "TxRateLimitExceeded": undefined;
    /**
     * Coldkey swap announcement not found
     */
    "ColdkeySwapAnnouncementNotFound": undefined;
    /**
     * Coldkey swap too early.
     */
    "ColdkeySwapTooEarly": undefined;
    /**
     * Coldkey swap reannounced too early.
     */
    "ColdkeySwapReannouncedTooEarly": undefined;
    /**
     * The announced coldkey hash does not match the new coldkey hash.
     */
    "AnnouncedColdkeyHashDoesNotMatch": undefined;
    /**
     * Coldkey swap already disputed
     */
    "ColdkeySwapAlreadyDisputed": undefined;
    /**
     * New coldkey is hotkey
     */
    "NewColdKeyIsHotkey": undefined;
    /**
     * Childkey take is invalid.
     */
    "InvalidChildkeyTake": undefined;
    /**
     * Childkey take rate limit exceeded.
     */
    "TxChildkeyTakeRateLimitExceeded": undefined;
    /**
     * Invalid identity.
     */
    "InvalidIdentity": undefined;
    /**
     * Subnet mechanism does not exist.
     */
    "MechanismDoesNotExist": undefined;
    /**
     * Trying to unstake your lock amount.
     */
    "CannotUnstakeLock": undefined;
    /**
     * Trying to perform action on non-existent subnet.
     */
    "SubnetNotExists": undefined;
    /**
     * Maximum commit limit reached
     */
    "TooManyUnrevealedCommits": undefined;
    /**
     * Attempted to reveal weights that are expired.
     */
    "ExpiredWeightCommit": undefined;
    /**
     * Attempted to reveal weights too early.
     */
    "RevealTooEarly": undefined;
    /**
     * Attempted to batch reveal weights with mismatched vector input lenghts.
     */
    "InputLengthsUnequal": undefined;
    /**
     * A transactor exceeded the rate limit for setting weights.
     */
    "CommittingWeightsTooFast": undefined;
    /**
     * Stake amount is too low.
     */
    "AmountTooLow": undefined;
    /**
     * Not enough liquidity.
     */
    "InsufficientLiquidity": undefined;
    /**
     * Slippage is too high for the transaction.
     */
    "SlippageTooHigh": undefined;
    /**
     * Subnet disallows transfer.
     */
    "TransferDisallowed": undefined;
    /**
     * Activity cutoff is being set too low.
     */
    "ActivityCutoffTooLow": undefined;
    /**
     * Call is disabled
     */
    "CallDisabled": undefined;
    /**
     * FirstEmissionBlockNumber is already set.
     */
    "FirstEmissionBlockNumberAlreadySet": undefined;
    /**
     * need wait for more blocks to accept the start call extrinsic.
     */
    "NeedWaitingMoreBlocksToStarCall": undefined;
    /**
     * Not enough AlphaOut on the subnet to recycle
     */
    "NotEnoughAlphaOutToRecycle": undefined;
    /**
     * Cannot burn or recycle TAO from root subnet
     */
    "CannotBurnOrRecycleOnRootSubnet": undefined;
    /**
     * Public key cannot be recovered.
     */
    "UnableToRecoverPublicKey": undefined;
    /**
     * Recovered public key is invalid.
     */
    "InvalidRecoveredPublicKey": undefined;
    /**
     * SubToken disabled now
     */
    "SubtokenDisabled": undefined;
    /**
     * Too frequent hotkey swap on subnet
     */
    "HotKeySwapOnSubnetIntervalNotPassed": undefined;
    /**
     * Zero max stake amount
     */
    "ZeroMaxStakeAmount": undefined;
    /**
     * Invalid netuid duplication
     */
    "SameNetuid": undefined;
    /**
     * The caller does not have enough balance for the operation.
     */
    "InsufficientBalance": undefined;
    /**
     * Too frequent staking operations
     */
    "StakingOperationRateLimitExceeded": undefined;
    /**
     * Invalid lease beneficiary to register the leased network.
     */
    "InvalidLeaseBeneficiary": undefined;
    /**
     * Lease cannot end in the past.
     */
    "LeaseCannotEndInThePast": undefined;
    /**
     * Couldn't find the lease netuid.
     */
    "LeaseNetuidNotFound": undefined;
    /**
     * Lease does not exist.
     */
    "LeaseDoesNotExist": undefined;
    /**
     * Lease has no end block.
     */
    "LeaseHasNoEndBlock": undefined;
    /**
     * Lease has not ended.
     */
    "LeaseHasNotEnded": undefined;
    /**
     * An overflow occurred.
     */
    "Overflow": undefined;
    /**
     * Beneficiary does not own hotkey.
     */
    "BeneficiaryDoesNotOwnHotkey": undefined;
    /**
     * Expected beneficiary origin.
     */
    "ExpectedBeneficiaryOrigin": undefined;
    /**
     * Admin operation is prohibited during the protected weights window
     */
    "AdminActionProhibitedDuringWeightsWindow": undefined;
    /**
     * Symbol does not exist.
     */
    "SymbolDoesNotExist": undefined;
    /**
     * Symbol already in use.
     */
    "SymbolAlreadyInUse": undefined;
    /**
     * Incorrect commit-reveal version.
     */
    "IncorrectCommitRevealVersion": undefined;
    /**
     * Reveal period is too large.
     */
    "RevealPeriodTooLarge": undefined;
    /**
     * Reveal period is too small.
     */
    "RevealPeriodTooSmall": undefined;
    /**
     * Generic error for out-of-range parameter value
     */
    "InvalidValue": undefined;
    /**
     * Subnet limit reached & there is no eligible subnet to prune
     */
    "SubnetLimitReached": undefined;
    /**
     * Insufficient funds to meet the subnet lock cost
     */
    "CannotAffordLockCost": undefined;
    /**
     * exceeded the rate limit for associating an EVM key.
     */
    "EvmKeyAssociateRateLimitExceeded": undefined;
    /**
     * Same auto stake hotkey already set
     */
    "SameAutoStakeHotkeyAlreadySet": undefined;
    /**
     * The UID map for the subnet could not be cleared
     */
    "UidMapCouldNotBeCleared": undefined;
    /**
     * Trimming would exceed the max immune neurons percentage
     */
    "TrimmingWouldExceedMaxImmunePercentage": undefined;
    /**
     * Violating the rules of Childkey-Parentkey consistency
     */
    "ChildParentInconsistency": undefined;
    /**
     * Invalid number of root claims
     */
    "InvalidNumRootClaim": undefined;
    /**
     * Invalid value of root claim threshold
     */
    "InvalidRootClaimThreshold": undefined;
    /**
     * Exceeded subnet limit number or zero.
     */
    "InvalidSubnetNumber": undefined;
    /**
     * The maximum allowed UIDs times mechanism count should not exceed 256.
     */
    "TooManyUIDsPerMechanism": undefined;
    /**
     * Voting power tracking is not enabled for this subnet.
     */
    "VotingPowerTrackingNotEnabled": undefined;
    /**
     * Invalid voting power EMA alpha value (must be <= 10^18).
     */
    "InvalidVotingPowerEmaAlpha": undefined;
    /**
     * Unintended precision loss when unstaking alpha
     */
    "PrecisionLoss": undefined;
    /**
     * Deprecated call.
     */
    "Deprecated": undefined;
    /**
     * "Add stake and burn" exceeded the operation rate limit
     */
    "AddStakeBurnRateLimitExceeded": undefined;
}>;
export type I499qmubmch1cg = AnonymousEnum<{
    /**
     * Too many calls batched.
     */
    "TooManyCalls": undefined;
    /**
     * Bad input data for derived account ID
     */
    "InvalidDerivedAccount": undefined;
}>;
export type Iaug04qjhbli00 = AnonymousEnum<{
    /**
     * Sender must be the Sudo account.
     */
    "RequireSudo": undefined;
}>;
export type Ia76qmhhg4jvb9 = AnonymousEnum<{
    /**
     * Threshold must be 2 or greater.
     */
    "MinimumThreshold": undefined;
    /**
     * Call is already approved by this signatory.
     */
    "AlreadyApproved": undefined;
    /**
     * Call doesn't need any (more) approvals.
     */
    "NoApprovalsNeeded": undefined;
    /**
     * There are too few signatories in the list.
     */
    "TooFewSignatories": undefined;
    /**
     * There are too many signatories in the list.
     */
    "TooManySignatories": undefined;
    /**
     * The signatories were provided out of order; they should be ordered.
     */
    "SignatoriesOutOfOrder": undefined;
    /**
     * The sender was contained in the other signatories; it shouldn't be.
     */
    "SenderInSignatories": undefined;
    /**
     * Multisig operation not found in storage.
     */
    "NotFound": undefined;
    /**
     * Only the account that originally created the multisig is able to cancel it or update
     * its deposits.
     */
    "NotOwner": undefined;
    /**
     * No timepoint was given, yet the multisig operation is already underway.
     */
    "NoTimepoint": undefined;
    /**
     * A different timepoint was given to the multisig operation that is underway.
     */
    "WrongTimepoint": undefined;
    /**
     * A timepoint was given, yet no multisig operation is underway.
     */
    "UnexpectedTimepoint": undefined;
    /**
     * The maximum weight information provided was too low.
     */
    "MaxWeightTooLow": undefined;
    /**
     * The data to be stored is already stored.
     */
    "AlreadyStored": undefined;
}>;
export type I4cfhml1prt4lu = AnonymousEnum<{
    /**
     * Preimage is too large to store on-chain.
     */
    "TooBig": undefined;
    /**
     * Preimage has already been noted on-chain.
     */
    "AlreadyNoted": undefined;
    /**
     * The user is not authorized to perform this action.
     */
    "NotAuthorized": undefined;
    /**
     * The preimage cannot be removed since it has not yet been noted.
     */
    "NotNoted": undefined;
    /**
     * A preimage may not be removed when there are outstanding requests.
     */
    "Requested": undefined;
    /**
     * The preimage request cannot be removed since no outstanding requests exist.
     */
    "NotRequested": undefined;
    /**
     * More than `MAX_HASH_UPGRADE_BULK_COUNT` hashes were requested to be upgraded at once.
     */
    "TooMany": undefined;
    /**
     * Too few hashes were requested to be upgraded (i.e. zero).
     */
    "TooFew": undefined;
}>;
export type If7oa8fprnilo5 = AnonymousEnum<{
    /**
     * Failed to schedule a call
     */
    "FailedToSchedule": undefined;
    /**
     * Cannot find the scheduled call.
     */
    "NotFound": undefined;
    /**
     * Given target block number is in the past.
     */
    "TargetBlockNumberInPast": undefined;
    /**
     * Reschedule failed because it does not change scheduled time.
     */
    "RescheduleNoChange": undefined;
    /**
     * Attempt to use a non-named function on a named task.
     */
    "Named": undefined;
}>;
export type I7ae37ntp06co6 = AnonymousEnum<{
    /**
     * There are too many proxies registered or too many announcements pending.
     */
    "TooMany": undefined;
    /**
     * Proxy registration not found.
     */
    "NotFound": undefined;
    /**
     * Sender is not a proxy of the account to be proxied.
     */
    "NotProxy": undefined;
    /**
     * A call which is incompatible with the proxy type's filter was attempted.
     */
    "Unproxyable": undefined;
    /**
     * Account is already a proxy.
     */
    "Duplicate": undefined;
    /**
     * Call may not be made by proxy because it may escalate its privileges.
     */
    "NoPermission": undefined;
    /**
     * Announcement, if made at all, was made too recently.
     */
    "Unannounced": undefined;
    /**
     * Cannot add self as proxy.
     */
    "NoSelfProxy": undefined;
    /**
     * Invariant violated: deposit recomputation returned None after updating announcements.
     */
    "AnnouncementDepositInvariantViolated": undefined;
    /**
     * Failed to derive a valid account id from the provided entropy.
     */
    "InvalidDerivedAccountId": undefined;
}>;
export type Id6jmtdau2lr6l = AnonymousEnum<{
    /**
     * Account attempted to register an identity but does not meet the requirements.
     */
    "CannotRegister": undefined;
    /**
     * Account passed too many additional fields to their identity
     */
    "TooManyFieldsInIdentityInfo": undefined;
    /**
     * Account doesn't have a registered identity
     */
    "NotRegistered": undefined;
}>;
export type I8a8dfn9etteh2 = AnonymousEnum<{
    /**
     * Account passed too many additional fields to their commitment
     */
    "TooManyFieldsInCommitmentInfo": undefined;
    /**
     * Account is not allowed to make commitments to the chain
     */
    "AccountNotAllowedCommit": undefined;
    /**
     * Space Limit Exceeded for the current interval
     */
    "SpaceLimitExceeded": undefined;
    /**
     * Indicates that unreserve returned a leftover, which is unexpected.
     */
    "UnexpectedUnreserveLeftover": undefined;
}>;
export type I8br6rdnlvg28h = AnonymousEnum<{
    /**
     * The subnet does not exist, check the netuid parameter
     */
    "SubnetDoesNotExist": undefined;
    /**
     * The maximum number of subnet validators must be less than the maximum number of allowed UIDs in the subnet.
     */
    "MaxValidatorsLargerThanMaxUIds": undefined;
    /**
     * The maximum number of subnet validators must be more than the current number of UIDs already in the subnet.
     */
    "MaxAllowedUIdsLessThanCurrentUIds": undefined;
    /**
     * The maximum value for bonds moving average is reached
     */
    "BondsMovingAverageMaxReached": undefined;
    /**
     * Only root can set negative sigmoid steepness values
     */
    "NegativeSigmoidSteepness": undefined;
    /**
     * Value not in allowed bounds.
     */
    "ValueNotInBounds": undefined;
    /**
     * The minimum allowed UIDs must be less than the current number of UIDs in the subnet.
     */
    "MinAllowedUidsGreaterThanCurrentUids": undefined;
    /**
     * The minimum allowed UIDs must be less than the maximum allowed UIDs.
     */
    "MinAllowedUidsGreaterThanMaxAllowedUids": undefined;
    /**
     * The maximum allowed UIDs must be greater than the minimum allowed UIDs.
     */
    "MaxAllowedUidsLessThanMinAllowedUids": undefined;
    /**
     * The maximum allowed UIDs must be less than the default maximum allowed UIDs.
     */
    "MaxAllowedUidsGreaterThanDefaultMaxAllowedUids": undefined;
    /**
     * Bad parameter value
     */
    "InvalidValue": undefined;
}>;
export type I65gapcjsc3grr = AnonymousEnum<{
    /**
     * The safe-mode is (already or still) entered.
     */
    "Entered": undefined;
    /**
     * The safe-mode is (already or still) exited.
     */
    "Exited": undefined;
    /**
     * This functionality of the pallet is disabled by the configuration.
     */
    "NotConfigured": undefined;
    /**
     * There is no balance reserved.
     */
    "NoDeposit": undefined;
    /**
     * The account already has a deposit reserved and can therefore not enter or extend again.
     */
    "AlreadyDeposited": undefined;
    /**
     * This deposit cannot be released yet.
     */
    "CannotReleaseYet": undefined;
    /**
     * An error from the underlying `Currency`.
     */
    "CurrencyError": undefined;
}>;
export type I1mp6vnoh32l4q = AnonymousEnum<{
    /**
     * Signature is invalid.
     */
    "InvalidSignature": undefined;
    /**
     * Pre-log is present, therefore transact is not allowed.
     */
    "PreLogExists": undefined;
}>;
export type I226s9mgj51cd2 = AnonymousEnum<{
    /**
     * Not enough balance to perform action
     */
    "BalanceLow": undefined;
    /**
     * Calculating total fee overflowed
     */
    "FeeOverflow": undefined;
    /**
     * Calculating total payment overflowed
     */
    "PaymentOverflow": undefined;
    /**
     * Withdraw fee failed
     */
    "WithdrawFailed": undefined;
    /**
     * Gas price is too low.
     */
    "GasPriceTooLow": undefined;
    /**
     * Nonce is invalid
     */
    "InvalidNonce": undefined;
    /**
     * Gas limit is too low.
     */
    "GasLimitTooLow": undefined;
    /**
     * Gas limit is too high.
     */
    "GasLimitTooHigh": undefined;
    /**
     * The chain id is invalid.
     */
    "InvalidChainId": undefined;
    /**
     * the signature is invalid.
     */
    "InvalidSignature": undefined;
    /**
     * EVM reentrancy
     */
    "Reentrancy": undefined;
    /**
     * EIP-3607,
     */
    "TransactionMustComeFromEOA": undefined;
    /**
     * Undefined error.
     */
    "Undefined": undefined;
    /**
     * Origin is not allowed to perform the operation.
     */
    "NotAllowed": undefined;
    /**
     * Address not allowed to deploy contracts either via CREATE or CALL(CREATE).
     */
    "CreateOriginNotAllowed": undefined;
}>;
export type I8veee4gumsdel = AnonymousEnum<{
    /**
     * The value retrieved was `None` as no value was previously set.
     */
    "NoneValue": undefined;
    /**
     * There was an attempt to increment the value in storage over `u32::MAX`.
     */
    "StorageOverflow": undefined;
    /**
     * failed to connect to the
     */
    "DrandConnectionFailure": undefined;
    /**
     * the pulse is invalid
     */
    "UnverifiedPulse": undefined;
    /**
     * the round number did not increment
     */
    "InvalidRoundNumber": undefined;
    /**
     * the pulse could not be verified
     */
    "PulseVerificationError": undefined;
}>;
export type I1ots9pukq67tt = AnonymousEnum<{
    /**
     * The crowdloan initial deposit is too low.
     */
    "DepositTooLow": undefined;
    /**
     * The crowdloan cap is too low.
     */
    "CapTooLow": undefined;
    /**
     * The minimum contribution is too low.
     */
    "MinimumContributionTooLow": undefined;
    /**
     * The crowdloan cannot end in the past.
     */
    "CannotEndInPast": undefined;
    /**
     * The crowdloan block duration is too short.
     */
    "BlockDurationTooShort": undefined;
    /**
     * The block duration is too long.
     */
    "BlockDurationTooLong": undefined;
    /**
     * The account does not have enough balance to pay for the initial deposit/contribution.
     */
    "InsufficientBalance": undefined;
    /**
     * An overflow occurred.
     */
    "Overflow": undefined;
    /**
     * The crowdloan id is invalid.
     */
    "InvalidCrowdloanId": undefined;
    /**
     * The crowdloan cap has been fully raised.
     */
    "CapRaised": undefined;
    /**
     * The contribution period has ended.
     */
    "ContributionPeriodEnded": undefined;
    /**
     * The contribution is too low.
     */
    "ContributionTooLow": undefined;
    /**
     * The origin of this call is invalid.
     */
    "InvalidOrigin": undefined;
    /**
     * The crowdloan has already been finalized.
     */
    "AlreadyFinalized": undefined;
    /**
     * The crowdloan contribution period has not ended yet.
     */
    "ContributionPeriodNotEnded": undefined;
    /**
     * The contributor has no contribution for this crowdloan.
     */
    "NoContribution": undefined;
    /**
     * The crowdloan cap has not been raised.
     */
    "CapNotRaised": undefined;
    /**
     * An underflow occurred.
     */
    "Underflow": undefined;
    /**
     * Call to dispatch was not found in the preimage storage.
     */
    "CallUnavailable": undefined;
    /**
     * The crowdloan is not ready to be dissolved, it still has contributions.
     */
    "NotReadyToDissolve": undefined;
    /**
     * The deposit cannot be withdrawn from the crowdloan.
     */
    "DepositCannotBeWithdrawn": undefined;
    /**
     * The maximum number of contributors has been reached.
     */
    "MaxContributorsReached": undefined;
}>;
export type I13bhbt5dau63n = AnonymousEnum<{
    /**
     * The fee rate is too high
     */
    "FeeRateTooHigh": undefined;
    /**
     * The provided amount is insufficient for the swap.
     */
    "InsufficientInputAmount": undefined;
    /**
     * The provided liquidity is insufficient for the operation.
     */
    "InsufficientLiquidity": undefined;
    /**
     * The operation would exceed the price limit.
     */
    "PriceLimitExceeded": undefined;
    /**
     * The caller does not have enough balance for the operation.
     */
    "InsufficientBalance": undefined;
    /**
     * The provided tick range is invalid.
     */
    "InvalidTickRange": undefined;
    /**
     * Provided liquidity parameter is invalid (likely too small)
     */
    "InvalidLiquidityValue": undefined;
    /**
     * Reserves too low for operation.
     */
    "ReservesTooLow": undefined;
    /**
     * The subnet does not exist.
     */
    "MechanismDoesNotExist": undefined;
    /**
     * The subnet does not have subtoken enabled
     */
    "SubtokenDisabled": undefined;
    /**
     * Swap reserves are too imbalanced
     */
    "ReservesOutOfBalance": undefined;
    /**
     * The extrinsic is deprecated
     */
    "Deprecated": undefined;
}>;
export type I2489g9rnboo1t = AnonymousEnum<{
    /**
     * Invalid schedule supplied, e.g. with zero weight of a basic operation.
     */
    "InvalidSchedule": undefined;
    /**
     * Invalid combination of flags supplied to `seal_call` or `seal_delegate_call`.
     */
    "InvalidCallFlags": undefined;
    /**
     * The executed contract exhausted its gas limit.
     */
    "OutOfGas": undefined;
    /**
     * The output buffer supplied to a contract API call was too small.
     */
    "OutputBufferTooSmall": undefined;
    /**
     * Performing the requested transfer failed. Probably because there isn't enough
     * free balance in the sender's account.
     */
    "TransferFailed": undefined;
    /**
     * Performing a call was denied because the calling depth reached the limit
     * of what is specified in the schedule.
     */
    "MaxCallDepthReached": undefined;
    /**
     * No contract was found at the specified address.
     */
    "ContractNotFound": undefined;
    /**
     * The code supplied to `instantiate_with_code` exceeds the limit specified in the
     * current schedule.
     */
    "CodeTooLarge": undefined;
    /**
     * No code could be found at the supplied code hash.
     */
    "CodeNotFound": undefined;
    /**
     * No code info could be found at the supplied code hash.
     */
    "CodeInfoNotFound": undefined;
    /**
     * A buffer outside of sandbox memory was passed to a contract API function.
     */
    "OutOfBounds": undefined;
    /**
     * Input passed to a contract API function failed to decode as expected type.
     */
    "DecodingFailed": undefined;
    /**
     * Contract trapped during execution.
     */
    "ContractTrapped": undefined;
    /**
     * The size defined in `T::MaxValueSize` was exceeded.
     */
    "ValueTooLarge": undefined;
    /**
     * Termination of a contract is not allowed while the contract is already
     * on the call stack. Can be triggered by `seal_terminate`.
     */
    "TerminatedWhileReentrant": undefined;
    /**
     * `seal_call` forwarded this contracts input. It therefore is no longer available.
     */
    "InputForwarded": undefined;
    /**
     * The subject passed to `seal_random` exceeds the limit.
     */
    "RandomSubjectTooLong": undefined;
    /**
     * The amount of topics passed to `seal_deposit_events` exceeds the limit.
     */
    "TooManyTopics": undefined;
    /**
     * The chain does not provide a chain extension. Calling the chain extension results
     * in this error. Note that this usually  shouldn't happen as deploying such contracts
     * is rejected.
     */
    "NoChainExtension": undefined;
    /**
     * Failed to decode the XCM program.
     */
    "XCMDecodeFailed": undefined;
    /**
     * A contract with the same AccountId already exists.
     */
    "DuplicateContract": undefined;
    /**
     * A contract self destructed in its constructor.
     *
     * This can be triggered by a call to `seal_terminate`.
     */
    "TerminatedInConstructor": undefined;
    /**
     * A call tried to invoke a contract that is flagged as non-reentrant.
     * The only other cause is that a call from a contract into the runtime tried to call back
     * into `pallet-contracts`. This would make the whole pallet reentrant with regard to
     * contract code execution which is not supported.
     */
    "ReentranceDenied": undefined;
    /**
     * A contract attempted to invoke a state modifying API while being in read-only mode.
     */
    "StateChangeDenied": undefined;
    /**
     * Origin doesn't have enough balance to pay the required storage deposits.
     */
    "StorageDepositNotEnoughFunds": undefined;
    /**
     * More storage was created than allowed by the storage deposit limit.
     */
    "StorageDepositLimitExhausted": undefined;
    /**
     * Code removal was denied because the code is still in use by at least one contract.
     */
    "CodeInUse": undefined;
    /**
     * The contract ran to completion but decided to revert its storage changes.
     * Please note that this error is only returned from extrinsics. When called directly
     * or via RPC an `Ok` will be returned. In this case the caller needs to inspect the flags
     * to determine whether a reversion has taken place.
     */
    "ContractReverted": undefined;
    /**
     * The contract's code was found to be invalid during validation.
     *
     * The most likely cause of this is that an API was used which is not supported by the
     * node. This happens if an older node is used with a new version of ink!. Try updating
     * your node to the newest available version.
     *
     * A more detailed error can be found on the node console if debug messages are enabled
     * by supplying `-lruntime::contracts=debug`.
     */
    "CodeRejected": undefined;
    /**
     * An indeterministic code was used in a context where this is not permitted.
     */
    "Indeterministic": undefined;
    /**
     * A pending migration needs to complete before the extrinsic can be called.
     */
    "MigrationInProgress": undefined;
    /**
     * Migrate dispatch call was attempted but no migration was performed.
     */
    "NoMigrationPerformed": undefined;
    /**
     * The contract has reached its maximum number of delegate dependencies.
     */
    "MaxDelegateDependenciesReached": undefined;
    /**
     * The dependency was not found in the contract's delegate dependencies.
     */
    "DelegateDependencyNotFound": undefined;
    /**
     * The contract already depends on the given delegate dependency.
     */
    "DelegateDependencyAlreadyExists": undefined;
    /**
     * Can not add a delegate dependency to the code hash of the contract itself.
     */
    "CannotAddSelfAsDelegateDependency": undefined;
    /**
     * Can not add more data to transient storage.
     */
    "OutOfTransientStorage": undefined;
}>;
export type I4ngcc5keahtro = AnonymousEnum<{
    /**
     * A submission with the same id already exists in `Submissions`.
     */
    "SubmissionAlreadyExists": undefined;
    /**
     * The referenced submission id does not exist in `Submissions`.
     */
    "MissingSubmission": undefined;
    /**
     * The recomputed commitment does not match the stored commitment.
     */
    "CommitmentMismatch": undefined;
    /**
     * The provided signature over the payload is invalid.
     */
    "SignatureInvalid": undefined;
    /**
     * The announced ML‑KEM public key length is invalid.
     */
    "BadPublicKeyLen": undefined;
    /**
     * The MEV‑Shield key epoch for this submission has expired and is no longer accepted.
     */
    "KeyExpired": undefined;
    /**
     * The provided `key_hash` does not match the expected epoch key hash.
     */
    "KeyHashMismatch": undefined;
}>;
export type TokenError = Enum<{
    "FundsUnavailable": undefined;
    "OnlyProvider": undefined;
    "BelowMinimum": undefined;
    "CannotCreate": undefined;
    "UnknownAsset": undefined;
    "Frozen": undefined;
    "Unsupported": undefined;
    "CannotCreateHold": undefined;
    "NotExpendable": undefined;
    "Blocked": undefined;
}>;
export declare const TokenError: GetEnum<TokenError>;
export type ArithmeticError = Enum<{
    "Underflow": undefined;
    "Overflow": undefined;
    "DivisionByZero": undefined;
}>;
export declare const ArithmeticError: GetEnum<ArithmeticError>;
export type TransactionalError = Enum<{
    "LimitReached": undefined;
    "NoLayer": undefined;
}>;
export declare const TransactionalError: GetEnum<TransactionalError>;
export type Icbccs0ug47ilf = {
    "account": SS58String;
};
export type I855j4i3kr8ko1 = {
    "sender": SS58String;
    "hash": FixedSizeBinary<32>;
};
export type Ibgl04rn6nbfm6 = {
    "code_hash": FixedSizeBinary<32>;
    "check_version": boolean;
};
export type I4n7lnouhqs6pg = {
    "code_hash": FixedSizeBinary<32>;
    "error": Anonymize<I6orop8m3bqhqc>;
};
export type GrandpaEvent = Enum<{
    /**
     * New authority set has been applied.
     */
    "NewAuthorities": Anonymize<I5768ac424h061>;
    /**
     * Current authority set has been paused.
     */
    "Paused": undefined;
    /**
     * Current authority set has been resumed.
     */
    "Resumed": undefined;
}>;
export declare const GrandpaEvent: GetEnum<GrandpaEvent>;
export type I5768ac424h061 = {
    "authority_set": Anonymize<I3geksg000c171>;
};
export type I3geksg000c171 = Array<Anonymize<I5spuldj7iqfb2>>;
export type I5spuldj7iqfb2 = [FixedSizeBinary<32>, bigint];
export type Iao8h4hv7atnq3 = AnonymousEnum<{
    /**
     * An account was created with some free balance.
     */
    "Endowed": Anonymize<Icv68aq8841478>;
    /**
     * An account was removed whose balance was non-zero but below ExistentialDeposit,
     * resulting in an outright loss.
     */
    "DustLost": Anonymize<Ic262ibdoec56a>;
    /**
     * Transfer succeeded.
     */
    "Transfer": Anonymize<Iflcfm9b6nlmdd>;
    /**
     * A balance was set by root.
     */
    "BalanceSet": Anonymize<Ijrsf4mnp3eka>;
    /**
     * Some balance was reserved (moved from free to reserved).
     */
    "Reserved": Anonymize<Id5fm4p8lj5qgi>;
    /**
     * Some balance was unreserved (moved from reserved to free).
     */
    "Unreserved": Anonymize<Id5fm4p8lj5qgi>;
    /**
     * Some balance was moved from the reserve of the first account to the second account.
     * Final argument indicates the destination balance type.
     */
    "ReserveRepatriated": Anonymize<I8tjvj9uq4b7hi>;
    /**
     * Some amount was deposited (e.g. for transaction fees).
     */
    "Deposit": Anonymize<Id5fm4p8lj5qgi>;
    /**
     * Some amount was withdrawn from the account (e.g. for transaction fees).
     */
    "Withdraw": Anonymize<Id5fm4p8lj5qgi>;
    /**
     * Some amount was removed from the account (e.g. for misbehavior).
     */
    "Slashed": Anonymize<Id5fm4p8lj5qgi>;
    /**
     * Some amount was minted into an account.
     */
    "Minted": Anonymize<Id5fm4p8lj5qgi>;
    /**
     * Some amount was burned from an account.
     */
    "Burned": Anonymize<Id5fm4p8lj5qgi>;
    /**
     * Some amount was suspended from an account (it can be restored later).
     */
    "Suspended": Anonymize<Id5fm4p8lj5qgi>;
    /**
     * Some amount was restored into an account.
     */
    "Restored": Anonymize<Id5fm4p8lj5qgi>;
    /**
     * An account was upgraded.
     */
    "Upgraded": Anonymize<I4cbvqmqadhrea>;
    /**
     * Total issuance was increased by `amount`, creating a credit to be balanced.
     */
    "Issued": Anonymize<I3qt1hgg4djhgb>;
    /**
     * Total issuance was decreased by `amount`, creating a debt to be balanced.
     */
    "Rescinded": Anonymize<I3qt1hgg4djhgb>;
    /**
     * Some balance was locked.
     */
    "Locked": Anonymize<Id5fm4p8lj5qgi>;
    /**
     * Some balance was unlocked.
     */
    "Unlocked": Anonymize<Id5fm4p8lj5qgi>;
    /**
     * Some balance was frozen.
     */
    "Frozen": Anonymize<Id5fm4p8lj5qgi>;
    /**
     * Some balance was thawed.
     */
    "Thawed": Anonymize<Id5fm4p8lj5qgi>;
    /**
     * The `TotalIssuance` was forcefully changed.
     */
    "TotalIssuanceForced": Anonymize<I4fooe9dun9o0t>;
}>;
export type Icv68aq8841478 = {
    "account": SS58String;
    "free_balance": bigint;
};
export type Ic262ibdoec56a = {
    "account": SS58String;
    "amount": bigint;
};
export type Iflcfm9b6nlmdd = {
    "from": SS58String;
    "to": SS58String;
    "amount": bigint;
};
export type Ijrsf4mnp3eka = {
    "who": SS58String;
    "free": bigint;
};
export type Id5fm4p8lj5qgi = {
    "who": SS58String;
    "amount": bigint;
};
export type I8tjvj9uq4b7hi = {
    "from": SS58String;
    "to": SS58String;
    "amount": bigint;
    "destination_status": BalanceStatus;
};
export type BalanceStatus = Enum<{
    "Free": undefined;
    "Reserved": undefined;
}>;
export declare const BalanceStatus: GetEnum<BalanceStatus>;
export type I4cbvqmqadhrea = {
    "who": SS58String;
};
export type I3qt1hgg4djhgb = {
    "amount": bigint;
};
export type I4fooe9dun9o0t = {
    "old": bigint;
    "new": bigint;
};
export type TransactionPaymentEvent = Enum<{
    /**
     * A transaction fee `actual_fee`, of which `tip` was added to the minimum inclusion fee,
     * has been paid by `who`.
     */
    "TransactionFeePaid": Anonymize<Ier2cke86dqbr2>;
}>;
export declare const TransactionPaymentEvent: GetEnum<TransactionPaymentEvent>;
export type Ier2cke86dqbr2 = {
    "who": SS58String;
    "actual_fee": bigint;
    "tip": bigint;
};
export type Ibu2ckjkstfafe = AnonymousEnum<{
    /**
     * a new network is added.
     */
    "NetworkAdded": Anonymize<I9jd27rnpm8ttv>;
    /**
     * a network is removed.
     */
    "NetworkRemoved": number;
    /**
     * stake has been transferred from the a coldkey account onto the hotkey staking account.
     */
    "StakeAdded": Anonymize<Io45lnue7n40k>;
    /**
     * stake has been removed from the hotkey staking account onto the coldkey account.
     */
    "StakeRemoved": Anonymize<Io45lnue7n40k>;
    /**
     * stake has been moved from origin (hotkey, subnet ID) to destination (hotkey, subnet ID) of this amount (in TAO).
     */
    "StakeMoved": Anonymize<I83e4tgdv5ohg1>;
    /**
     * a caller successfully sets their weights on a subnetwork.
     */
    "WeightsSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * a new neuron account has been registered to the chain.
     */
    "NeuronRegistered": Anonymize<I6o6dmud53u1fj>;
    /**
     * multiple uids have been concurrently registered.
     */
    "BulkNeuronsRegistered": Anonymize<I9jd27rnpm8ttv>;
    /**
     * FIXME: Not used yet
     */
    "BulkBalancesSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * max allowed uids has been set for a subnetwork.
     */
    "MaxAllowedUidsSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * DEPRECATED: max weight limit updates are no longer supported.
     */
    "MaxWeightLimitSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * the difficulty has been set for a subnet.
     */
    "DifficultySet": Anonymize<I4ojmnsk1dchql>;
    /**
     * the adjustment interval is set for a subnet.
     */
    "AdjustmentIntervalSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * registration per interval is set for a subnet.
     */
    "RegistrationPerIntervalSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * we set max registrations per block.
     */
    "MaxRegistrationsPerBlockSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * an activity cutoff is set for a subnet.
     */
    "ActivityCutoffSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * Rho value is set.
     */
    "RhoSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * steepness of the sigmoid used to compute alpha values.
     */
    "AlphaSigmoidSteepnessSet": Anonymize<I5g2vv0ckl2m8b>;
    /**
     * Kappa is set for a subnet.
     */
    "KappaSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * minimum allowed weight is set for a subnet.
     */
    "MinAllowedWeightSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * the validator pruning length has been set.
     */
    "ValidatorPruneLenSet": Anonymize<I4ojmnsk1dchql>;
    /**
     * the scaling law power has been set for a subnet.
     */
    "ScalingLawPowerSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * weights set rate limit has been set for a subnet.
     */
    "WeightsSetRateLimitSet": Anonymize<I4ojmnsk1dchql>;
    /**
     * immunity period is set for a subnet.
     */
    "ImmunityPeriodSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * bonds moving average is set for a subnet.
     */
    "BondsMovingAverageSet": Anonymize<I4ojmnsk1dchql>;
    /**
     * bonds penalty is set for a subnet.
     */
    "BondsPenaltySet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * bonds reset is set for a subnet.
     */
    "BondsResetOnSet": Anonymize<I39p6ln31i4n46>;
    /**
     * setting the max number of allowed validators on a subnet.
     */
    "MaxAllowedValidatorsSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * the axon server information is added to the network.
     */
    "AxonServed": Anonymize<I7svnfko10tq2e>;
    /**
     * the prometheus server information is added to the network.
     */
    "PrometheusServed": Anonymize<I7svnfko10tq2e>;
    /**
     * a hotkey has become a delegate.
     */
    "DelegateAdded": Anonymize<I7svrbkiu01iec>;
    /**
     * the default take is set.
     */
    "DefaultTakeSet": number;
    /**
     * weights version key is set for a network.
     */
    "WeightsVersionKeySet": Anonymize<I4ojmnsk1dchql>;
    /**
     * setting min difficulty on a network.
     */
    "MinDifficultySet": Anonymize<I4ojmnsk1dchql>;
    /**
     * setting max difficulty on a network.
     */
    "MaxDifficultySet": Anonymize<I4ojmnsk1dchql>;
    /**
     * setting the prometheus serving rate limit.
     */
    "ServingRateLimitSet": Anonymize<I4ojmnsk1dchql>;
    /**
     * setting burn on a network.
     */
    "BurnSet": Anonymize<I4ojmnsk1dchql>;
    /**
     * setting max burn on a network.
     */
    "MaxBurnSet": Anonymize<I4ojmnsk1dchql>;
    /**
     * setting min burn on a network.
     */
    "MinBurnSet": Anonymize<I4ojmnsk1dchql>;
    /**
     * setting the transaction rate limit.
     */
    "TxRateLimitSet": bigint;
    /**
     * setting the delegate take transaction rate limit.
     */
    "TxDelegateTakeRateLimitSet": bigint;
    /**
     * setting the childkey take transaction rate limit.
     */
    "TxChildKeyTakeRateLimitSet": bigint;
    /**
     * setting the admin freeze window length (last N blocks of tempo)
     */
    "AdminFreezeWindowSet": number;
    /**
     * setting the owner hyperparameter rate limit in epochs
     */
    "OwnerHyperparamRateLimitSet": number;
    /**
     * minimum childkey take set
     */
    "MinChildKeyTakeSet": number;
    /**
     * maximum childkey take set
     */
    "MaxChildKeyTakeSet": number;
    /**
     * childkey take set
     */
    "ChildKeyTakeSet": Anonymize<I6ouflveob4eli>;
    /**
     * a sudo call is done.
     */
    "Sudid": Anonymize<I9dkdd0svp2anm>;
    /**
     * registration is allowed/disallowed for a subnet.
     */
    "RegistrationAllowed": Anonymize<I39p6ln31i4n46>;
    /**
     * POW registration is allowed/disallowed for a subnet.
     */
    "PowRegistrationAllowed": Anonymize<I39p6ln31i4n46>;
    /**
     * setting tempo on a network
     */
    "TempoSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * setting the RAO recycled for registration.
     */
    "RAORecycledForRegistrationSet": Anonymize<I4ojmnsk1dchql>;
    /**
     * min stake is set for validators to set weights.
     */
    "StakeThresholdSet": bigint;
    /**
     * setting the adjustment alpha on a subnet.
     */
    "AdjustmentAlphaSet": Anonymize<I4ojmnsk1dchql>;
    /**
     * the faucet it called on the test net.
     */
    "Faucet": Anonymize<I95l2k9b1re95f>;
    /**
     * the subnet owner cut is set.
     */
    "SubnetOwnerCutSet": number;
    /**
     * the network creation rate limit is set.
     */
    "NetworkRateLimitSet": bigint;
    /**
     * the network immunity period is set.
     */
    "NetworkImmunityPeriodSet": bigint;
    /**
     * the start call delay is set.
     */
    "StartCallDelaySet": bigint;
    /**
     * the network minimum locking cost is set.
     */
    "NetworkMinLockCostSet": bigint;
    /**
     * the maximum number of subnets is set
     */
    "SubnetLimitSet": number;
    /**
     * the lock cost reduction is set
     */
    "NetworkLockCostReductionIntervalSet": bigint;
    /**
     * the take for a delegate is decreased.
     */
    "TakeDecreased": Anonymize<I7svrbkiu01iec>;
    /**
     * the take for a delegate is increased.
     */
    "TakeIncreased": Anonymize<I7svrbkiu01iec>;
    /**
     * the hotkey is swapped
     */
    "HotkeySwapped": Anonymize<Ifkgc6cte1k96e>;
    /**
     * maximum delegate take is set by sudo/admin transaction
     */
    "MaxDelegateTakeSet": number;
    /**
     * minimum delegate take is set by sudo/admin transaction
     */
    "MinDelegateTakeSet": number;
    /**
     * A coldkey swap announcement has been made.
     */
    "ColdkeySwapAnnounced": Anonymize<I6kvs2mb8unk0t>;
    /**
     * A coldkey swap has been reset.
     */
    "ColdkeySwapReset": Anonymize<I4cbvqmqadhrea>;
    /**
     * A coldkey has been swapped.
     */
    "ColdkeySwapped": Anonymize<Idbuci3sr3i1f7>;
    /**
     * A coldkey swap has been disputed.
     */
    "ColdkeySwapDisputed": Anonymize<I375tmdui1ejfc>;
    /**
     * All balance of a hotkey has been unstaked and transferred to a new coldkey
     */
    "AllBalanceUnstakedAndTransferredToNewColdkey": Anonymize<I73drt1hl9e70v>;
    /**
     * The arbitration period has been extended
     */
    "ArbitrationPeriodExtended": Anonymize<I375tmdui1ejfc>;
    /**
     * Setting of children of a hotkey have been scheduled
     */
    "SetChildrenScheduled": Anonymize<I1dm4sip108q0g>;
    /**
     * The children of a hotkey have been set
     */
    "SetChildren": Anonymize<Iajgphfb1fka7l>;
    /**
     * The identity of a coldkey has been set
     */
    "ChainIdentitySet": SS58String;
    /**
     * The identity of a subnet has been set
     */
    "SubnetIdentitySet": number;
    /**
     * The identity of a subnet has been removed
     */
    "SubnetIdentityRemoved": number;
    /**
     * A dissolve network extrinsic scheduled.
     */
    "DissolveNetworkScheduled": Anonymize<I4hnmf90qkrer9>;
    /**
     * The coldkey swap announcement delay has been set.
     */
    "ColdkeySwapAnnouncementDelaySet": number;
    /**
     * The coldkey swap reannouncement delay has been set.
     */
    "ColdkeySwapReannouncementDelaySet": number;
    /**
     * The duration of dissolve network has been set
     */
    "DissolveNetworkScheduleDurationSet": number;
    /**
     * Commit-reveal v3 weights have been successfully committed.
     *
     * - **who**: The account ID of the user committing the weights.
     * - **netuid**: The network identifier.
     * - **commit_hash**: The hash representing the committed weights.
     */
    "CRV3WeightsCommitted": Anonymize<Ijsohbv0raf36>;
    /**
     * Weights have been successfully committed.
     *
     * - **who**: The account ID of the user committing the weights.
     * - **netuid**: The network identifier.
     * - **commit_hash**: The hash representing the committed weights.
     */
    "WeightsCommitted": Anonymize<Ijsohbv0raf36>;
    /**
     * Weights have been successfully revealed.
     *
     * - **who**: The account ID of the user revealing the weights.
     * - **netuid**: The network identifier.
     * - **commit_hash**: The hash of the revealed weights.
     */
    "WeightsRevealed": Anonymize<Ijsohbv0raf36>;
    /**
     * Weights have been successfully batch revealed.
     *
     * - **who**: The account ID of the user revealing the weights.
     * - **netuid**: The network identifier.
     * - **revealed_hashes**: A vector of hashes representing each revealed weight set.
     */
    "WeightsBatchRevealed": Anonymize<I4ga01hppthoe1>;
    /**
     * A batch of weights (or commits) have been force-set.
     *
     * - **netuids**: The netuids these weights were successfully set/committed for.
     * - **who**: The hotkey that set this batch.
     */
    "BatchWeightsCompleted": Anonymize<I4hckkcv10tcue>;
    /**
     * A batch extrinsic completed but with some errors.
     */
    "BatchCompletedWithErrors": undefined;
    /**
     * A weight set among a batch of weights failed.
     *
     * - **error**: The dispatch error emitted by the failed item.
     */
    "BatchWeightItemFailed": Anonymize<I6orop8m3bqhqc>;
    /**
     * Stake has been transferred from one coldkey to another on the same subnet.
     * Parameters:
     * (origin_coldkey, destination_coldkey, hotkey, origin_netuid, destination_netuid, amount)
     */
    "StakeTransferred": Anonymize<If2ieedn10ujdv>;
    /**
     * Stake has been swapped from one subnet to another for the same coldkey-hotkey pair.
     *
     * Parameters:
     * (coldkey, hotkey, origin_netuid, destination_netuid, amount)
     */
    "StakeSwapped": Anonymize<Iaseh340tnovdh>;
    /**
     * Event called when transfer is toggled on a subnet.
     *
     * Parameters:
     * (netuid, bool)
     */
    "TransferToggle": Anonymize<I39p6ln31i4n46>;
    /**
     * The owner hotkey for a subnet has been set.
     *
     * Parameters:
     * (netuid, new_hotkey)
     */
    "SubnetOwnerHotkeySet": Anonymize<I7svnfko10tq2e>;
    /**
     * FirstEmissionBlockNumber is set via start call extrinsic
     *
     * Parameters:
     * netuid
     * block number
     */
    "FirstEmissionBlockNumberSet": Anonymize<I4ojmnsk1dchql>;
    /**
     * Alpha has been recycled, reducing AlphaOut on a subnet.
     *
     * Parameters:
     * (coldkey, hotkey, amount, subnet_id)
     */
    "AlphaRecycled": Anonymize<I8m5umt6snnmlj>;
    /**
     * Alpha have been burned without reducing AlphaOut.
     *
     * Parameters:
     * (coldkey, hotkey, amount, subnet_id)
     */
    "AlphaBurned": Anonymize<I8m5umt6snnmlj>;
    /**
     * An EVM key has been associated with a hotkey.
     */
    "EvmKeyAssociated": Anonymize<I5aeg4u9kpsp8o>;
    /**
     * CRV3 Weights have been successfully revealed.
     *
     * - **netuid**: The network identifier.
     * - **who**: The account ID of the user revealing the weights.
     */
    "CRV3WeightsRevealed": Anonymize<I7svnfko10tq2e>;
    /**
     * Commit-Reveal periods has been successfully set.
     *
     * - **netuid**: The network identifier.
     * - **periods**: The number of epochs before the reveal.
     */
    "CommitRevealPeriodsSet": Anonymize<I4ojmnsk1dchql>;
    /**
     * Commit-Reveal has been successfully toggled.
     *
     * - **netuid**: The network identifier.
     * - **Enabled**: Is Commit-Reveal enabled.
     */
    "CommitRevealEnabled": Anonymize<I39p6ln31i4n46>;
    /**
     * the hotkey is swapped
     */
    "HotkeySwappedOnSubnet": Anonymize<I3fsv5f1boeqf3>;
    /**
     * A subnet lease has been created.
     */
    "SubnetLeaseCreated": Anonymize<Ifoov68qt28nbm>;
    /**
     * A subnet lease has been terminated.
     */
    "SubnetLeaseTerminated": Anonymize<Ib937mhlbop6j7>;
    /**
     * The symbol for a subnet has been updated.
     */
    "SymbolUpdated": Anonymize<I62rrikn5vj0p5>;
    /**
     * Commit Reveal Weights version has been updated.
     *
     * - **version**: The required version.
     */
    "CommitRevealVersionSet": number;
    /**
     * Timelocked weights have been successfully committed.
     *
     * - **who**: The account ID of the user committing the weights.
     * - **netuid**: The network identifier.
     * - **commit_hash**: The hash representing the committed weights.
     * - **reveal_round**: The round at which weights can be revealed.
     */
    "TimelockedWeightsCommitted": Anonymize<I838gqvljm75tj>;
    /**
     * Timelocked Weights have been successfully revealed.
     *
     * - **netuid**: The network identifier.
     * - **who**: The account ID of the user revealing the weights.
     */
    "TimelockedWeightsRevealed": Anonymize<I7svnfko10tq2e>;
    /**
     * Auto-staking hotkey received stake
     */
    "AutoStakeAdded": Anonymize<I1cu36qostj5d8>;
    /**
     * End-of-epoch miner incentive alpha by UID
     */
    "IncentiveAlphaEmittedToMiners": Anonymize<I4r2ptfsrl017r>;
    /**
     * The minimum allowed UIDs for a subnet have been set.
     */
    "MinAllowedUidsSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * The auto stake destination has been set.
     *
     * - **coldkey**: The account ID of the coldkey.
     * - **netuid**: The network identifier.
     * - **hotkey**: The account ID of the hotkey.
     */
    "AutoStakeDestinationSet": Anonymize<Ielglukq9ekcit>;
    /**
     * The minimum allowed non-Immune UIDs has been set.
     */
    "MinNonImmuneUidsSet": Anonymize<I9jd27rnpm8ttv>;
    /**
     * Root emissions have been claimed for a coldkey on all subnets and hotkeys.
     * Parameters:
     * (coldkey)
     */
    "RootClaimed": Anonymize<I375tmdui1ejfc>;
    /**
     * Root claim type for a coldkey has been set.
     * Parameters:
     * (coldkey, u8)
     */
    "RootClaimTypeSet": Anonymize<I1clsdhcok4nle>;
    /**
     * Voting power tracking has been enabled for a subnet.
     */
    "VotingPowerTrackingEnabled": Anonymize<I6cm4c5a1euio9>;
    /**
     * Voting power tracking has been scheduled for disabling.
     * Tracking will continue until disable_at_block, then stop and clear entries.
     */
    "VotingPowerTrackingDisableScheduled": Anonymize<Iemddv6u2buvfn>;
    /**
     * Voting power tracking has been fully disabled and entries cleared.
     */
    "VotingPowerTrackingDisabled": Anonymize<I6cm4c5a1euio9>;
    /**
     * Voting power EMA alpha has been set for a subnet.
     */
    "VotingPowerEmaAlphaSet": Anonymize<I4guv8rii4s6je>;
    /**
     * Subnet lease dividends have been distributed.
     */
    "SubnetLeaseDividendsDistributed": Anonymize<Ic149bnrif7lpr>;
    /**
     * "Add stake and burn" event: alpha token was purchased and burned.
     */
    "AddStakeBurn": Anonymize<I89dsvf7sdo4ko>;
}>;
export type I9jd27rnpm8ttv = FixedSizeArray<2, number>;
export type Io45lnue7n40k = [SS58String, SS58String, bigint, bigint, number, bigint];
export type I83e4tgdv5ohg1 = [SS58String, SS58String, number, SS58String, number, bigint];
export type I6o6dmud53u1fj = [number, number, SS58String];
export type I4ojmnsk1dchql = [number, bigint];
export type I5g2vv0ckl2m8b = [number, number];
export type I39p6ln31i4n46 = [number, boolean];
export type I7svnfko10tq2e = [number, SS58String];
export type I7svrbkiu01iec = [SS58String, SS58String, number];
export type I6ouflveob4eli = [SS58String, number];
export type I9dkdd0svp2anm = ResultPayload<undefined, Anonymize<I6orop8m3bqhqc>>;
export type I95l2k9b1re95f = [SS58String, bigint];
export type Ifkgc6cte1k96e = {
    /**
     * the account ID of coldkey
     */
    "coldkey": SS58String;
    /**
     * the account ID of old hotkey
     */
    "old_hotkey": SS58String;
    /**
     * the account ID of new hotkey
     */
    "new_hotkey": SS58String;
};
export type I6kvs2mb8unk0t = {
    /**
     * The account ID of the coldkey that made the announcement.
     */
    "who": SS58String;
    /**
     * The hash of the new coldkey.
     */
    "new_coldkey_hash": FixedSizeBinary<32>;
};
export type Idbuci3sr3i1f7 = {
    /**
     * The account ID of old coldkey.
     */
    "old_coldkey": SS58String;
    /**
     * The account ID of new coldkey.
     */
    "new_coldkey": SS58String;
};
export type I375tmdui1ejfc = {
    /**
     * The account ID of the coldkey that was disputed.
     */
    "coldkey": SS58String;
};
export type I73drt1hl9e70v = {
    /**
     * The account ID of the current coldkey
     */
    "current_coldkey": SS58String;
    /**
     * The account ID of the new coldkey
     */
    "new_coldkey": SS58String;
    /**
     * The total balance of the hotkey
     */
    "total_balance": bigint;
};
export type I1dm4sip108q0g = [SS58String, number, bigint, Anonymize<I5n8gpu725k1nu>];
export type I5n8gpu725k1nu = Array<Anonymize<I96rqo4i9p11oo>>;
export type I96rqo4i9p11oo = [bigint, SS58String];
export type Iajgphfb1fka7l = [SS58String, number, Anonymize<I5n8gpu725k1nu>];
export type I4hnmf90qkrer9 = {
    /**
     * The account ID schedule the dissolve network extrinsic
     */
    "account": SS58String;
    /**
     * network ID will be dissolved
     */
    "netuid": number;
    /**
     * extrinsic execution block number
     */
    "execution_block": number;
};
export type Ijsohbv0raf36 = [SS58String, number, FixedSizeBinary<32>];
export type I4ga01hppthoe1 = [SS58String, number, Anonymize<Ic5m5lp1oioo8r>];
export type Ic5m5lp1oioo8r = Array<FixedSizeBinary<32>>;
export type I4hckkcv10tcue = [Anonymize<Icgljjb6j82uhn>, SS58String];
export type Icgljjb6j82uhn = Array<number>;
export type If2ieedn10ujdv = [SS58String, SS58String, SS58String, number, number, bigint];
export type Iaseh340tnovdh = [SS58String, SS58String, number, number, bigint];
export type I8m5umt6snnmlj = [SS58String, SS58String, bigint, number];
export type I5aeg4u9kpsp8o = {
    /**
     * The subnet that the hotkey belongs to.
     */
    "netuid": number;
    /**
     * The hotkey associated with the EVM key.
     */
    "hotkey": SS58String;
    /**
     * The EVM key being associated with the hotkey.
     */
    "evm_key": FixedSizeBinary<20>;
    /**
     * The block where the association happened.
     */
    "block_associated": bigint;
};
export type I3fsv5f1boeqf3 = {
    /**
     * the account ID of coldkey
     */
    "coldkey": SS58String;
    /**
     * the account ID of old hotkey
     */
    "old_hotkey": SS58String;
    /**
     * the account ID of new hotkey
     */
    "new_hotkey": SS58String;
    /**
     * the subnet ID
     */
    "netuid": number;
};
export type Ifoov68qt28nbm = {
    /**
     * The beneficiary of the lease.
     */
    "beneficiary": SS58String;
    /**
     * The lease ID
     */
    "lease_id": number;
    /**
     * The subnet ID
     */
    "netuid": number;
    /**
     * The end block of the lease
     */
    "end_block"?: Anonymize<I4arjljr6dpflb>;
};
export type I4arjljr6dpflb = (number) | undefined;
export type Ib937mhlbop6j7 = {
    /**
     * The beneficiary of the lease.
     */
    "beneficiary": SS58String;
    /**
     * The subnet ID
     */
    "netuid": number;
};
export type I62rrikn5vj0p5 = {
    /**
     * The subnet ID
     */
    "netuid": number;
    /**
     * The symbol that has been updated.
     */
    "symbol": Binary;
};
export type I838gqvljm75tj = [SS58String, number, FixedSizeBinary<32>, bigint];
export type I1cu36qostj5d8 = {
    /**
     * Subnet identifier.
     */
    "netuid": number;
    /**
     * Destination account that received the auto-staked funds.
     */
    "destination": SS58String;
    /**
     * Hotkey account whose stake was auto-staked.
     */
    "hotkey": SS58String;
    /**
     * Owner (coldkey) account associated with the hotkey.
     */
    "owner": SS58String;
    /**
     * Amount of alpha auto-staked.
     */
    "incentive": bigint;
};
export type I4r2ptfsrl017r = {
    /**
     * Subnet identifier.
     */
    "netuid": number;
    /**
     * UID-indexed array of miner incentive alpha; index equals UID.
     */
    "emissions": Anonymize<Iafqnechp3omqg>;
};
export type Iafqnechp3omqg = Array<bigint>;
export type Ielglukq9ekcit = {
    /**
     * The account ID of the coldkey.
     */
    "coldkey": SS58String;
    /**
     * The network identifier.
     */
    "netuid": number;
    /**
     * The account ID of the hotkey.
     */
    "hotkey": SS58String;
};
export type I1clsdhcok4nle = {
    /**
     * Claim coldkey
     */
    "coldkey": SS58String;
    /**
     * Claim type
     */
    "root_claim_type": Anonymize<Iapm6e7vtp0l6r>;
};
export type Iapm6e7vtp0l6r = AnonymousEnum<{
    "Swap": undefined;
    "Keep": undefined;
    "KeepSubnets": Anonymize<I2t4b7068rtebl>;
}>;
export type I2t4b7068rtebl = {
    "subnets": Anonymize<Icgljjb6j82uhn>;
};
export type I6cm4c5a1euio9 = {
    /**
     * The subnet ID
     */
    "netuid": number;
};
export type Iemddv6u2buvfn = {
    /**
     * The subnet ID
     */
    "netuid": number;
    /**
     * Block at which tracking will be disabled
     */
    "disable_at_block": bigint;
};
export type I4guv8rii4s6je = {
    /**
     * The subnet ID
     */
    "netuid": number;
    /**
     * The new alpha value (u64 with 18 decimal precision)
     */
    "alpha": bigint;
};
export type Ic149bnrif7lpr = {
    /**
     * The lease ID
     */
    "lease_id": number;
    /**
     * The contributor
     */
    "contributor": SS58String;
    /**
     * The amount of alpha distributed
     */
    "alpha": bigint;
};
export type I89dsvf7sdo4ko = {
    /**
     * The subnet ID
     */
    "netuid": number;
    /**
     * hotky account ID
     */
    "hotkey": SS58String;
    /**
     * Tao provided
     */
    "amount": bigint;
    /**
     * Alpha burned
     */
    "alpha": bigint;
};
export type I52pu5gv23r3k6 = AnonymousEnum<{
    /**
     * Batch of dispatches did not complete fully. Index of first failing dispatch given, as
     * well as the error.
     */
    "BatchInterrupted": Anonymize<I5vqj6vsa4qso8>;
    /**
     * Batch of dispatches completed fully with no error.
     */
    "BatchCompleted": undefined;
    /**
     * Batch of dispatches completed but has errors.
     */
    "BatchCompletedWithErrors": undefined;
    /**
     * A single item within a Batch of dispatches has completed with no error.
     */
    "ItemCompleted": undefined;
    /**
     * A single item within a Batch of dispatches has completed with error.
     */
    "ItemFailed": Anonymize<I6s1s5tibubgjg>;
    /**
     * A call was dispatched.
     */
    "DispatchedAs": Anonymize<I2b5odcspaigh3>;
    /**
     * Main call was dispatched.
     */
    "IfElseMainSuccess": undefined;
    /**
     * The fallback call was dispatched.
     */
    "IfElseFallbackCalled": Anonymize<I6e6r73jpum7ks>;
}>;
export type I5vqj6vsa4qso8 = {
    "index": number;
    "error": Anonymize<I6orop8m3bqhqc>;
};
export type I6s1s5tibubgjg = {
    "error": Anonymize<I6orop8m3bqhqc>;
};
export type I2b5odcspaigh3 = {
    "result": Anonymize<I9dkdd0svp2anm>;
};
export type I6e6r73jpum7ks = {
    "main_error": Anonymize<I6orop8m3bqhqc>;
};
export type Idqut36jj64f22 = AnonymousEnum<{
    /**
     * A sudo call just took place.
     */
    "Sudid": Anonymize<Ic5uv6hvtb4vnp>;
    /**
     * The sudo key has been updated.
     */
    "KeyChanged": Anonymize<I5rtkmhm2dng4u>;
    /**
     * The key was permanently removed.
     */
    "KeyRemoved": undefined;
    /**
     * A [sudo_as](Pallet::sudo_as) call just took place.
     */
    "SudoAsDone": Anonymize<Ic5uv6hvtb4vnp>;
}>;
export type Ic5uv6hvtb4vnp = {
    /**
     * The result of the call made by the sudo user.
     */
    "sudo_result": Anonymize<I9dkdd0svp2anm>;
};
export type I5rtkmhm2dng4u = {
    /**
     * The old sudo key (if one was previously set).
     */
    "old"?: Anonymize<Ihfphjolmsqq1>;
    /**
     * The new sudo key (if one was set).
     */
    "new": SS58String;
};
export type Ihfphjolmsqq1 = (SS58String) | undefined;
export type I60q3b713p0n0u = AnonymousEnum<{
    /**
     * A new multisig operation has begun.
     */
    "NewMultisig": Anonymize<Iep27ialq4a7o7>;
    /**
     * A multisig operation has been approved by someone.
     */
    "MultisigApproval": Anonymize<Iasu5jvoqr43mv>;
    /**
     * A multisig operation has been executed.
     */
    "MultisigExecuted": Anonymize<Ie5vlr9k5tqqtn>;
    /**
     * A multisig operation has been cancelled.
     */
    "MultisigCancelled": Anonymize<I5qolde99acmd1>;
    /**
     * The deposit for a multisig operation has been updated/poked.
     */
    "DepositPoked": Anonymize<I8gtde5abn1g9a>;
}>;
export type Iep27ialq4a7o7 = {
    "approving": SS58String;
    "multisig": SS58String;
    "call_hash": FixedSizeBinary<32>;
};
export type Iasu5jvoqr43mv = {
    "approving": SS58String;
    "timepoint": Anonymize<Itvprrpb0nm3o>;
    "multisig": SS58String;
    "call_hash": FixedSizeBinary<32>;
};
export type Itvprrpb0nm3o = {
    "height": number;
    "index": number;
};
export type Ie5vlr9k5tqqtn = {
    "approving": SS58String;
    "timepoint": Anonymize<Itvprrpb0nm3o>;
    "multisig": SS58String;
    "call_hash": FixedSizeBinary<32>;
    "result": Anonymize<I9dkdd0svp2anm>;
};
export type I5qolde99acmd1 = {
    "cancelling": SS58String;
    "timepoint": Anonymize<Itvprrpb0nm3o>;
    "multisig": SS58String;
    "call_hash": FixedSizeBinary<32>;
};
export type I8gtde5abn1g9a = {
    "who": SS58String;
    "call_hash": FixedSizeBinary<32>;
    "old_deposit": bigint;
    "new_deposit": bigint;
};
export type PreimageEvent = Enum<{
    /**
     * A preimage has been noted.
     */
    "Noted": Anonymize<I1jm8m1rh9e20v>;
    /**
     * A preimage has been requested.
     */
    "Requested": Anonymize<I1jm8m1rh9e20v>;
    /**
     * A preimage has ben cleared.
     */
    "Cleared": Anonymize<I1jm8m1rh9e20v>;
}>;
export declare const PreimageEvent: GetEnum<PreimageEvent>;
export type I1jm8m1rh9e20v = {
    "hash": FixedSizeBinary<32>;
};
export type Ienedd7ri3a5g4 = AnonymousEnum<{
    /**
     * Scheduled some task.
     */
    "Scheduled": Anonymize<I5n4sebgkfr760>;
    /**
     * Canceled some task.
     */
    "Canceled": Anonymize<I5n4sebgkfr760>;
    /**
     * Dispatched some task.
     */
    "Dispatched": Anonymize<Ifdpmem946rhur>;
    /**
     * Set a retry configuration for some task.
     */
    "RetrySet": Anonymize<Ia3c82eadg79bj>;
    /**
     * Cancel a retry configuration for some task.
     */
    "RetryCancelled": Anonymize<Ienusoeb625ftq>;
    /**
     * The call for the provided hash was not found so the task has been aborted.
     */
    "CallUnavailable": Anonymize<Ienusoeb625ftq>;
    /**
     * The given task was unable to be renewed since the agenda is full at that block.
     */
    "PeriodicFailed": Anonymize<Ienusoeb625ftq>;
    /**
     * The given task was unable to be retried since the agenda is full at that block or there
     * was not enough weight to reschedule it.
     */
    "RetryFailed": Anonymize<Ienusoeb625ftq>;
    /**
     * The given task can never be executed since it is overweight.
     */
    "PermanentlyOverweight": Anonymize<Ienusoeb625ftq>;
    /**
     * Agenda is incomplete from `when`.
     */
    "AgendaIncomplete": Anonymize<Ibtsa3docbr9el>;
}>;
export type I5n4sebgkfr760 = {
    "when": number;
    "index": number;
};
export type Ifdpmem946rhur = {
    "task": Anonymize<I9jd27rnpm8ttv>;
    "id"?: Anonymize<I4s6vifaf8k998>;
    "result": Anonymize<I9dkdd0svp2anm>;
};
export type I4s6vifaf8k998 = (FixedSizeBinary<32>) | undefined;
export type Ia3c82eadg79bj = {
    "task": Anonymize<I9jd27rnpm8ttv>;
    "id"?: Anonymize<I4s6vifaf8k998>;
    "period": number;
    "retries": number;
};
export type Ienusoeb625ftq = {
    "task": Anonymize<I9jd27rnpm8ttv>;
    "id"?: Anonymize<I4s6vifaf8k998>;
};
export type Ibtsa3docbr9el = {
    "when": number;
};
export type Icrtnu35ghu428 = AnonymousEnum<{
    /**
     * A proxy was executed correctly, with the given.
     */
    "ProxyExecuted": Anonymize<I2b5odcspaigh3>;
    /**
     * A pure account has been created by new proxy with given
     * disambiguation index and proxy type.
     */
    "PureCreated": Anonymize<Iek6442ldi23n3>;
    /**
     * A pure proxy was killed by its spawner.
     */
    "PureKilled": Anonymize<Idpdo54rotesu2>;
    /**
     * An announcement was placed to make a call in the future.
     */
    "Announced": Anonymize<I2ur0oeqg495j8>;
    /**
     * A proxy was added.
     */
    "ProxyAdded": Anonymize<Ibco2bqthggul0>;
    /**
     * A proxy was removed.
     */
    "ProxyRemoved": Anonymize<Ibco2bqthggul0>;
    /**
     * A deposit stored for proxies or announcements was poked / updated.
     */
    "DepositPoked": Anonymize<I1bhd210c3phjj>;
}>;
export type Iek6442ldi23n3 = {
    "pure": SS58String;
    "who": SS58String;
    "proxy_type": Anonymize<I8v1041j74kmaj>;
    "disambiguation_index": number;
};
export type I8v1041j74kmaj = AnonymousEnum<{
    "Any": undefined;
    "Owner": undefined;
    "NonCritical": undefined;
    "NonTransfer": undefined;
    "Senate": undefined;
    "NonFungible": undefined;
    "Triumvirate": undefined;
    "Governance": undefined;
    "Staking": undefined;
    "Registration": undefined;
    "Transfer": undefined;
    "SmallTransfer": undefined;
    "RootWeights": undefined;
    "ChildKeys": undefined;
    "SudoUncheckedSetCode": undefined;
    "SwapHotkey": undefined;
    "SubnetLeaseBeneficiary": undefined;
    "RootClaim": undefined;
}>;
export type Idpdo54rotesu2 = {
    "pure": SS58String;
    "spawner": SS58String;
    "proxy_type": Anonymize<I8v1041j74kmaj>;
    "disambiguation_index": number;
};
export type I2ur0oeqg495j8 = {
    "real": SS58String;
    "proxy": SS58String;
    "call_hash": FixedSizeBinary<32>;
};
export type Ibco2bqthggul0 = {
    "delegator": SS58String;
    "delegatee": SS58String;
    "proxy_type": Anonymize<I8v1041j74kmaj>;
    "delay": number;
};
export type I1bhd210c3phjj = {
    "who": SS58String;
    "kind": Enum<{
        "Proxies": undefined;
        "Announcements": undefined;
    }>;
    "old_deposit": bigint;
    "new_deposit": bigint;
};
export type I626vh1cit09ni = AnonymousEnum<{
    /**
     * Emitted when a user registers an identity
     */
    "IdentitySet": Anonymize<I4cbvqmqadhrea>;
    /**
     * Emitted when a user dissolves an identity
     */
    "IdentityDissolved": Anonymize<I4cbvqmqadhrea>;
}>;
export type I5ohlg8gv4pe9g = AnonymousEnum<{
    /**
     * A commitment was set
     */
    "Commitment": Anonymize<Idcqgi2844k5he>;
    /**
     * A timelock-encrypted commitment was set
     */
    "TimelockCommitment": Anonymize<Iej2173ou338sm>;
    /**
     * A timelock-encrypted commitment was auto-revealed
     */
    "CommitmentRevealed": Anonymize<Idcqgi2844k5he>;
}>;
export type Idcqgi2844k5he = {
    /**
     * The netuid of the commitment
     */
    "netuid": number;
    /**
     * The account
     */
    "who": SS58String;
};
export type Iej2173ou338sm = {
    /**
     * The netuid of the commitment
     */
    "netuid": number;
    /**
     * The account
     */
    "who": SS58String;
    /**
     * The drand round to reveal
     */
    "reveal_round": bigint;
};
export type Ic1vmbif9o0nug = AnonymousEnum<{
    /**
     * Event emitted when a precompile operation is updated.
     */
    "PrecompileUpdated": Anonymize<I1sj8huj7of8mb>;
    /**
     * Event emitted when the Yuma3 enable is toggled.
     */
    "Yuma3EnableToggled": Anonymize<Ie31ro5s5e089f>;
    /**
     * Event emitted when Bonds Reset is toggled.
     */
    "BondsResetToggled": Anonymize<Ie31ro5s5e089f>;
}>;
export type I1sj8huj7of8mb = {
    /**
     * The type of precompile operation being updated.
     */
    "precompile_id": Anonymize<I8un1ap2r4hhbj>;
    /**
     * Indicates if the precompile operation is enabled or not.
     */
    "enabled": boolean;
};
export type I8un1ap2r4hhbj = AnonymousEnum<{
    "BalanceTransfer": undefined;
    "Staking": undefined;
    "Subnet": undefined;
    "Metagraph": undefined;
    "Neuron": undefined;
    "UidLookup": undefined;
    "Alpha": undefined;
    "Crowdloan": undefined;
    "Proxy": undefined;
    "Leasing": undefined;
    "AddressMapping": undefined;
    "VotingPower": undefined;
}>;
export type Ie31ro5s5e089f = {
    /**
     * The network identifier.
     */
    "netuid": number;
    /**
     * Indicates if the Yuma3 enable was enabled or disabled.
     */
    "enabled": boolean;
};
export type I3q8c83f5dvokp = AnonymousEnum<{
    /**
     * The safe-mode was entered until inclusively this block.
     */
    "Entered": Anonymize<I20e9ph536u7ti>;
    /**
     * The safe-mode was extended until inclusively this block.
     */
    "Extended": Anonymize<I20e9ph536u7ti>;
    /**
     * Exited the safe-mode for a specific reason.
     */
    "Exited": Anonymize<I8kcpmsh450rp>;
    /**
     * An account reserved funds for either entering or extending the safe-mode.
     */
    "DepositPlaced": Anonymize<Ic262ibdoec56a>;
    /**
     * An account had a reserve released that was reserved.
     */
    "DepositReleased": Anonymize<Ic262ibdoec56a>;
    /**
     * An account had reserve slashed that was reserved.
     */
    "DepositSlashed": Anonymize<Ic262ibdoec56a>;
    /**
     * Could not hold funds for entering or extending the safe-mode.
     *
     * This error comes from the underlying `Currency`.
     */
    "CannotDeposit": undefined;
    /**
     * Could not release funds for entering or extending the safe-mode.
     *
     * This error comes from the underlying `Currency`.
     */
    "CannotRelease": undefined;
}>;
export type I20e9ph536u7ti = {
    "until": number;
};
export type I8kcpmsh450rp = {
    "reason": Enum<{
        "Timeout": undefined;
        "Force": undefined;
    }>;
};
export type I510u4q1qqh897 = AnonymousEnum<{
    /**
     * An ethereum transaction was successfully executed.
     */
    "Executed": Anonymize<Iea4g5ovhnolus>;
}>;
export type Iea4g5ovhnolus = {
    "from": FixedSizeBinary<20>;
    "to": FixedSizeBinary<20>;
    "transaction_hash": FixedSizeBinary<32>;
    "exit_reason": Anonymize<Iag9iovb9j5ijo>;
    "extra_data": Binary;
};
export type Iag9iovb9j5ijo = AnonymousEnum<{
    "Succeed": Enum<{
        "Stopped": undefined;
        "Returned": undefined;
        "Suicided": undefined;
    }>;
    "Error": Anonymize<I5ksr7ru2gk4nh>;
    "Revert": Enum<{
        "Reverted": undefined;
    }>;
    "Fatal": Enum<{
        "NotSupported": undefined;
        "UnhandledInterrupt": undefined;
        "CallErrorAsFatal": Anonymize<I5ksr7ru2gk4nh>;
        "Other": string;
    }>;
}>;
export type I5ksr7ru2gk4nh = AnonymousEnum<{
    "StackUnderflow": undefined;
    "StackOverflow": undefined;
    "InvalidJump": undefined;
    "InvalidRange": undefined;
    "DesignatedInvalid": undefined;
    "CallTooDeep": undefined;
    "CreateCollision": undefined;
    "CreateContractLimit": undefined;
    "InvalidCode": number;
    "OutOfOffset": undefined;
    "OutOfGas": undefined;
    "OutOfFund": undefined;
    "PCUnderflow": undefined;
    "CreateEmpty": undefined;
    "Other": string;
    "MaxNonce": undefined;
}>;
export type I9k071kk4cn1u8 = AnonymousEnum<{
    /**
     * Ethereum events from contracts.
     */
    "Log": Anonymize<Ifmc9boeeia623>;
    /**
     * A contract has been created at given address.
     */
    "Created": Anonymize<Itmchvgqfl28g>;
    /**
     * A contract was attempted to be created, but the execution failed.
     */
    "CreatedFailed": Anonymize<Itmchvgqfl28g>;
    /**
     * A contract has been executed successfully with states applied.
     */
    "Executed": Anonymize<Itmchvgqfl28g>;
    /**
     * A contract has been executed with errors. States are reverted with only gas fees applied.
     */
    "ExecutedFailed": Anonymize<Itmchvgqfl28g>;
}>;
export type Ifmc9boeeia623 = {
    "log": Anonymize<I10qb03fpuk6em>;
};
export type I10qb03fpuk6em = {
    "address": FixedSizeBinary<20>;
    "topics": Anonymize<Ic5m5lp1oioo8r>;
    "data": Binary;
};
export type Itmchvgqfl28g = {
    "address": FixedSizeBinary<20>;
};
export type I3bmatomsds8j7 = AnonymousEnum<{
    "NewBaseFeePerGas": Anonymize<I7vi74gbubc8u5>;
    "BaseFeeOverflow": undefined;
    "NewElasticity": Anonymize<I3u0knmtb1ueq7>;
}>;
export type I7vi74gbubc8u5 = {
    "fee": Anonymize<I4totqt881mlti>;
};
export type I4totqt881mlti = FixedSizeArray<4, bigint>;
export type I3u0knmtb1ueq7 = {
    "elasticity": number;
};
export type Ibdlgbf9b95hbj = AnonymousEnum<{
    /**
     * Beacon Configuration has changed.
     */
    "BeaconConfigChanged": undefined;
    /**
     * Successfully set a new pulse(s).
     */
    "NewPulse": Anonymize<I5tf7b5o64mfpl>;
    /**
     * Oldest Stored Round has been set.
     */
    "SetOldestStoredRound": bigint;
}>;
export type I5tf7b5o64mfpl = {
    "rounds": Anonymize<Iafqnechp3omqg>;
};
export type Ifj1h07t3i0np9 = AnonymousEnum<{
    /**
     * A crowdloan was created.
     */
    "Created": Anonymize<If71d2q730qf6n>;
    /**
     * A contribution was made to an active crowdloan.
     */
    "Contributed": Anonymize<If0sk51c1n7ri8>;
    /**
     * A contribution was withdrawn from a failed crowdloan.
     */
    "Withdrew": Anonymize<If0sk51c1n7ri8>;
    /**
     * A refund was partially processed for a failed crowdloan.
     */
    "PartiallyRefunded": Anonymize<I5dueehi6i2dg9>;
    /**
     * A refund was fully processed for a failed crowdloan.
     */
    "AllRefunded": Anonymize<I5dueehi6i2dg9>;
    /**
     * A crowdloan was finalized, funds were transferred and the call was dispatched.
     */
    "Finalized": Anonymize<I5dueehi6i2dg9>;
    /**
     * A crowdloan was dissolved.
     */
    "Dissolved": Anonymize<I5dueehi6i2dg9>;
    /**
     * The minimum contribution was updated.
     */
    "MinContributionUpdated": Anonymize<I64ev05f6q10es>;
    /**
     * The end was updated.
     */
    "EndUpdated": Anonymize<Ikc5h15joooak>;
    /**
     * The cap was updated.
     */
    "CapUpdated": Anonymize<Ie8f436ua5fs59>;
}>;
export type If71d2q730qf6n = {
    "crowdloan_id": number;
    "creator": SS58String;
    "end": number;
    "cap": bigint;
};
export type If0sk51c1n7ri8 = {
    "crowdloan_id": number;
    "contributor": SS58String;
    "amount": bigint;
};
export type I5dueehi6i2dg9 = {
    "crowdloan_id": number;
};
export type I64ev05f6q10es = {
    "crowdloan_id": number;
    "new_min_contribution": bigint;
};
export type Ikc5h15joooak = {
    "crowdloan_id": number;
    "new_end": number;
};
export type Ie8f436ua5fs59 = {
    "crowdloan_id": number;
    "new_cap": bigint;
};
export type I65ga25qerlven = AnonymousEnum<{
    /**
     * Event emitted when the fee rate has been updated for a subnet
     */
    "FeeRateSet": Anonymize<I3mkis681qg30e>;
}>;
export type I3mkis681qg30e = {
    "netuid": number;
    "rate": number;
};
export type I211sbjvh5hjqu = AnonymousEnum<{
    /**
     * Contract deployed by address at the specified address.
     */
    "Instantiated": Anonymize<Ie5222qfrr24ek>;
    /**
     * Contract has been removed.
     *
     * # Note
     *
     * The only way for a contract to be removed and emitting this event is by calling
     * `seal_terminate`.
     */
    "Terminated": Anonymize<I28g8sphdu312k>;
    /**
     * Code with the specified hash has been stored.
     */
    "CodeStored": Anonymize<Idqbjt2c6r46t6>;
    /**
     * A custom event emitted by the contract.
     */
    "ContractEmitted": Anonymize<I853aigjva3f0t>;
    /**
     * A code with the specified hash was removed.
     */
    "CodeRemoved": Anonymize<I9uehhems5hkqm>;
    /**
     * A contract's code was updated.
     */
    "ContractCodeUpdated": Anonymize<I7q5qk4uoanhof>;
    /**
     * A contract was called either by a plain account or another contract.
     *
     * # Note
     *
     * Please keep in mind that like all events this is only emitted for successful
     * calls. This is because on failure all storage changes including events are
     * rolled back.
     */
    "Called": Anonymize<Iehpbs40l3jkit>;
    /**
     * A contract delegate called a code hash.
     *
     * # Note
     *
     * Please keep in mind that like all events this is only emitted for successful
     * calls. This is because on failure all storage changes including events are
     * rolled back.
     */
    "DelegateCalled": Anonymize<Idht9upmipvd4j>;
    /**
     * Some funds have been transferred and held as storage deposit.
     */
    "StorageDepositTransferredAndHeld": Anonymize<Iflcfm9b6nlmdd>;
    /**
     * Some storage deposit funds have been transferred and released.
     */
    "StorageDepositTransferredAndReleased": Anonymize<Iflcfm9b6nlmdd>;
}>;
export type Ie5222qfrr24ek = {
    "deployer": SS58String;
    "contract": SS58String;
};
export type I28g8sphdu312k = {
    /**
     * The contract that was terminated.
     */
    "contract": SS58String;
    /**
     * The account that received the contracts remaining balance
     */
    "beneficiary": SS58String;
};
export type Idqbjt2c6r46t6 = {
    "code_hash": FixedSizeBinary<32>;
    "deposit_held": bigint;
    "uploader": SS58String;
};
export type I853aigjva3f0t = {
    /**
     * The contract that emitted the event.
     */
    "contract": SS58String;
    /**
     * Data supplied by the contract. Metadata generated during contract compilation
     * is needed to decode it.
     */
    "data": Binary;
};
export type I9uehhems5hkqm = {
    "code_hash": FixedSizeBinary<32>;
    "deposit_released": bigint;
    "remover": SS58String;
};
export type I7q5qk4uoanhof = {
    /**
     * The contract that has been updated.
     */
    "contract": SS58String;
    /**
     * New code hash that was set for the contract.
     */
    "new_code_hash": FixedSizeBinary<32>;
    /**
     * Previous code hash of the contract.
     */
    "old_code_hash": FixedSizeBinary<32>;
};
export type Iehpbs40l3jkit = {
    /**
     * The caller of the `contract`.
     */
    "caller": Enum<{
        "Root": undefined;
        "Signed": SS58String;
    }>;
    /**
     * The contract that was called.
     */
    "contract": SS58String;
};
export type Idht9upmipvd4j = {
    /**
     * The contract that performed the delegate call and hence in whose context
     * the `code_hash` is executed.
     */
    "contract": SS58String;
    /**
     * The code hash that was delegate called.
     */
    "code_hash": FixedSizeBinary<32>;
};
export type I28unbqdbn1vpg = AnonymousEnum<{
    /**
     * Encrypted wrapper accepted.
     */
    "EncryptedSubmitted": Anonymize<Icns2sqr5hp8s3>;
    /**
     * Decrypted call executed.
     */
    "DecryptedExecuted": Anonymize<I9n4hs8p3rlkag>;
    /**
     * Decrypted execution rejected.
     */
    "DecryptedRejected": Anonymize<I9a8thrj9sk1ua>;
    /**
     * Decryption failed - validator could not decrypt the submission.
     */
    "DecryptionFailed": Anonymize<I602p6mm30elei>;
}>;
export type Icns2sqr5hp8s3 = {
    "id": FixedSizeBinary<32>;
    "who": SS58String;
};
export type I9n4hs8p3rlkag = {
    "id": FixedSizeBinary<32>;
    "signer": SS58String;
};
export type I9a8thrj9sk1ua = {
    "id": FixedSizeBinary<32>;
    "reason": {
        "post_info": {
            "actual_weight"?: Anonymize<Iasb8k6ash5mjn>;
            "pays_fee": Anonymize<Iehg04bj71rkd>;
        };
        "error": Anonymize<I6orop8m3bqhqc>;
    };
};
export type Iasb8k6ash5mjn = (Anonymize<I4q39t5hn830vp>) | undefined;
export type I602p6mm30elei = {
    "id": FixedSizeBinary<32>;
    "reason": Binary;
};
export type I95g6i7ilua7lq = Array<Anonymize<I9jd27rnpm8ttv>>;
export type Ieniouoqkq4icf = {
    "spec_version": number;
    "spec_name": string;
};
export type GrandpaStoredState = Enum<{
    "Live": undefined;
    "PendingPause": {
        "scheduled_at": number;
        "delay": number;
    };
    "Paused": undefined;
    "PendingResume": {
        "scheduled_at": number;
        "delay": number;
    };
}>;
export declare const GrandpaStoredState: GetEnum<GrandpaStoredState>;
export type I7pe2me3i3vtn9 = {
    "scheduled_at": number;
    "delay": number;
    "next_authorities": Anonymize<I3geksg000c171>;
    "forced"?: Anonymize<I4arjljr6dpflb>;
};
export type I8ds64oj6581v0 = Array<{
    "id": FixedSizeBinary<8>;
    "amount": bigint;
    "reasons": BalancesTypesReasons;
}>;
export type BalancesTypesReasons = Enum<{
    "Fee": undefined;
    "Misc": undefined;
    "All": undefined;
}>;
export declare const BalancesTypesReasons: GetEnum<BalancesTypesReasons>;
export type Ia7pdug7cdsg8g = Array<{
    "id": FixedSizeBinary<8>;
    "amount": bigint;
}>;
export type I2hnk9r4ukuj1p = Array<{
    "id": Enum<{
        "Preimage": PreimagePalletHoldReason;
        "Registry": Enum<{
            "RegistryIdentity": undefined;
        }>;
        "SafeMode": Enum<{
            "EnterOrExtend": undefined;
        }>;
        "Contracts": Enum<{
            "CodeUploadDepositReserve": undefined;
            "StorageDepositReserve": undefined;
        }>;
    }>;
    "amount": bigint;
}>;
export type PreimagePalletHoldReason = Enum<{
    "Preimage": undefined;
}>;
export declare const PreimagePalletHoldReason: GetEnum<PreimagePalletHoldReason>;
export type I9bin2jc70qt6q = Array<Anonymize<I3qt1hgg4djhgb>>;
export type TransactionPaymentReleases = Enum<{
    "V1Ancient": undefined;
    "V2": undefined;
}>;
export declare const TransactionPaymentReleases: GetEnum<TransactionPaymentReleases>;
export type Idoeu5t0dum8va = [Anonymize<I5n8gpu725k1nu>, bigint];
export type Ia2lhg7l2hilo3 = Array<SS58String>;
export type I4p5t2krb1gmvp = [number, FixedSizeBinary<32>];
export type Iabpgqcjikia83 = (Binary) | undefined;
export type I2j729bmgsdiuo = [bigint, bigint];
export type Iakavvne152v30 = AnonymousEnum<{
    "SetSNOwnerHotkey": number;
    "OwnerHyperparamUpdate": [number, Enum<{
        "Unknown": undefined;
        "ServingRateLimit": undefined;
        "MaxDifficulty": undefined;
        "AdjustmentAlpha": undefined;
        "MaxWeightLimit": undefined;
        "ImmunityPeriod": undefined;
        "MinAllowedWeights": undefined;
        "Kappa": undefined;
        "Rho": undefined;
        "ActivityCutoff": undefined;
        "PowRegistrationAllowed": undefined;
        "MinBurn": undefined;
        "MaxBurn": undefined;
        "BondsMovingAverage": undefined;
        "BondsPenalty": undefined;
        "CommitRevealEnabled": undefined;
        "LiquidAlphaEnabled": undefined;
        "AlphaValues": undefined;
        "WeightCommitInterval": undefined;
        "TransferEnabled": undefined;
        "AlphaSigmoidSteepness": undefined;
        "Yuma3Enabled": undefined;
        "BondsResetEnabled": undefined;
        "ImmuneNeuronLimit": undefined;
        "RecycleOrBurn": undefined;
        "MaxAllowedUids": undefined;
    }>];
    "NetworkLastRegistered": undefined;
    "LastTxBlock": SS58String;
    "LastTxBlockChildKeyTake": SS58String;
    "LastTxBlockDelegateTake": SS58String;
    "AddStakeBurn": number;
}>;
export type Ib9tptuv3cggfs = AnonymousEnum<{
    "Burn": undefined;
    "Recycle": undefined;
}>;
export type I4h6ivgjtd51lv = Array<[SS58String, bigint, bigint]>;
export type I9eir063evtfb6 = Array<boolean>;
export type Ibc83gdj8hi3rc = {
    "block": bigint;
    "version": number;
    "ip": bigint;
    "port": number;
    "ip_type": number;
    "protocol": number;
    "placeholder1": number;
    "placeholder2": number;
};
export type I9lpjucl20l82d = {
    "public_key": Binary;
    "algorithm": number;
};
export type Iaap7oohdmr1sb = {
    "block": bigint;
    "version": number;
    "ip": bigint;
    "port": number;
    "ip_type": number;
};
export type Ifjlj958aeheic = {
    "name": Binary;
    "url": Binary;
    "github_repo": Binary;
    "image": Binary;
    "discord": Binary;
    "description": Binary;
    "additional": Binary;
};
export type I4tc54pa558g5n = {
    "subnet_name": Binary;
    "github_repo": Binary;
    "subnet_contact": Binary;
    "subnet_url": Binary;
    "discord": Binary;
    "description": Binary;
    "logo_url": Binary;
    "additional": Binary;
};
export type Id32h28hjj1tch = [SS58String, number, number];
export type Icrrf4uohj5gb0 = Array<[FixedSizeBinary<32>, bigint, bigint, bigint]>;
export type I76jd8kl1mtn5g = Array<[SS58String, bigint, Binary, bigint]>;
export type I4jqk5si14p5oi = Array<[SS58String, Binary, bigint]>;
export type I2na29tt2afp0j = FixedSizeArray<2, SS58String>;
export type If9jidduiuq7vv = Array<Anonymize<I4ojmnsk1dchql>>;
export type I2brm5b9jij1st = [number, SS58String, SS58String];
export type I7tof95tckt2r = [FixedSizeBinary<20>, bigint];
export type Ieruonr5pk2d7h = {
    "beneficiary": SS58String;
    "coldkey": SS58String;
    "hotkey": SS58String;
    "emissions_share": number;
    "end_block"?: Anonymize<I4arjljr6dpflb>;
    "netuid": number;
    "cost": bigint;
};
export type Iag146hmjgqfgj = {
    "when": Anonymize<Itvprrpb0nm3o>;
    "deposit": bigint;
    "depositor": SS58String;
    "approvals": Anonymize<Ia2lhg7l2hilo3>;
};
export type I8uo3fpd3bcc6f = [SS58String, FixedSizeBinary<32>];
export type PreimageOldRequestStatus = Enum<{
    "Unrequested": {
        "deposit": Anonymize<I95l2k9b1re95f>;
        "len": number;
    };
    "Requested": {
        "deposit"?: Anonymize<I92hdo1clkbp4g>;
        "count": number;
        "len"?: Anonymize<I4arjljr6dpflb>;
    };
}>;
export declare const PreimageOldRequestStatus: GetEnum<PreimageOldRequestStatus>;
export type I92hdo1clkbp4g = (Anonymize<I95l2k9b1re95f>) | undefined;
export type PreimageRequestStatus = Enum<{
    "Unrequested": {
        "ticket": Anonymize<I95l2k9b1re95f>;
        "len": number;
    };
    "Requested": {
        "maybe_ticket"?: Anonymize<I92hdo1clkbp4g>;
        "count": number;
        "maybe_len"?: Anonymize<I4arjljr6dpflb>;
    };
}>;
export declare const PreimageRequestStatus: GetEnum<PreimageRequestStatus>;
export type I4pact7n2e9a0i = [FixedSizeBinary<32>, number];
export type I11tetbe8ces3o = Array<({
    "maybe_id"?: Anonymize<I4s6vifaf8k998>;
    "priority": number;
    "call": PreimagesBounded;
    "maybe_periodic"?: Anonymize<Iep7au1720bm0e>;
    "origin": Anonymize<I32es0rp64745v>;
}) | undefined>;
export type PreimagesBounded = Enum<{
    "Legacy": Anonymize<I1jm8m1rh9e20v>;
    "Inline": Binary;
    "Lookup": {
        "hash": FixedSizeBinary<32>;
        "len": number;
    };
}>;
export declare const PreimagesBounded: GetEnum<PreimagesBounded>;
export type Iep7au1720bm0e = (Anonymize<I9jd27rnpm8ttv>) | undefined;
export type I32es0rp64745v = AnonymousEnum<{
    "system": Enum<{
        "Root": undefined;
        "Signed": SS58String;
        "None": undefined;
        "Authorized": undefined;
    }>;
    "Ethereum": Anonymize<I9hp9au9bfqil7>;
}>;
export type I9hp9au9bfqil7 = AnonymousEnum<{
    "EthereumTransaction": FixedSizeBinary<20>;
}>;
export type I56u24ncejr5kt = {
    "total_retries": number;
    "remaining": number;
    "period": number;
};
export type I6tqrno2gaos08 = [Array<{
    "delegate": SS58String;
    "proxy_type": Anonymize<I8v1041j74kmaj>;
    "delay": number;
}>, bigint];
export type I9p9lq3rej5bhc = [Array<{
    "real": SS58String;
    "call_hash": FixedSizeBinary<32>;
    "height": number;
}>, bigint];
export type Ib6u9l1gtc5l4t = {
    "deposit": bigint;
    "info": Anonymize<Ifiu33afi2n7qs>;
};
export type Ifiu33afi2n7qs = {
    "additional": Array<FixedSizeArray<2, Anonymize<I2fomq92gvvqhc>>>;
    "display": Anonymize<I2fomq92gvvqhc>;
    "legal": Anonymize<I2fomq92gvvqhc>;
    "web": Anonymize<I2fomq92gvvqhc>;
    "riot": Anonymize<I2fomq92gvvqhc>;
    "email": Anonymize<I2fomq92gvvqhc>;
    "pgp_fingerprint"?: Anonymize<If7b8240vgt2q5>;
    "image": Anonymize<I2fomq92gvvqhc>;
    "twitter": Anonymize<I2fomq92gvvqhc>;
};
export type I2fomq92gvvqhc = AnonymousEnum<{
    "None": undefined;
    "Raw0": undefined;
    "Raw1": number;
    "Raw2": FixedSizeBinary<2>;
    "Raw3": FixedSizeBinary<3>;
    "Raw4": FixedSizeBinary<4>;
    "Raw5": FixedSizeBinary<5>;
    "Raw6": FixedSizeBinary<6>;
    "Raw7": FixedSizeBinary<7>;
    "Raw8": FixedSizeBinary<8>;
    "Raw9": FixedSizeBinary<9>;
    "Raw10": FixedSizeBinary<10>;
    "Raw11": FixedSizeBinary<11>;
    "Raw12": FixedSizeBinary<12>;
    "Raw13": FixedSizeBinary<13>;
    "Raw14": FixedSizeBinary<14>;
    "Raw15": FixedSizeBinary<15>;
    "Raw16": FixedSizeBinary<16>;
    "Raw17": FixedSizeBinary<17>;
    "Raw18": FixedSizeBinary<18>;
    "Raw19": FixedSizeBinary<19>;
    "Raw20": FixedSizeBinary<20>;
    "Raw21": FixedSizeBinary<21>;
    "Raw22": FixedSizeBinary<22>;
    "Raw23": FixedSizeBinary<23>;
    "Raw24": FixedSizeBinary<24>;
    "Raw25": FixedSizeBinary<25>;
    "Raw26": FixedSizeBinary<26>;
    "Raw27": FixedSizeBinary<27>;
    "Raw28": FixedSizeBinary<28>;
    "Raw29": FixedSizeBinary<29>;
    "Raw30": FixedSizeBinary<30>;
    "Raw31": FixedSizeBinary<31>;
    "Raw32": FixedSizeBinary<32>;
    "Raw33": FixedSizeBinary<33>;
    "Raw34": FixedSizeBinary<34>;
    "Raw35": FixedSizeBinary<35>;
    "Raw36": FixedSizeBinary<36>;
    "Raw37": FixedSizeBinary<37>;
    "Raw38": FixedSizeBinary<38>;
    "Raw39": FixedSizeBinary<39>;
    "Raw40": FixedSizeBinary<40>;
    "Raw41": FixedSizeBinary<41>;
    "Raw42": FixedSizeBinary<42>;
    "Raw43": FixedSizeBinary<43>;
    "Raw44": FixedSizeBinary<44>;
    "Raw45": FixedSizeBinary<45>;
    "Raw46": FixedSizeBinary<46>;
    "Raw47": FixedSizeBinary<47>;
    "Raw48": FixedSizeBinary<48>;
    "Raw49": FixedSizeBinary<49>;
    "Raw50": FixedSizeBinary<50>;
    "Raw51": FixedSizeBinary<51>;
    "Raw52": FixedSizeBinary<52>;
    "Raw53": FixedSizeBinary<53>;
    "Raw54": FixedSizeBinary<54>;
    "Raw55": FixedSizeBinary<55>;
    "Raw56": FixedSizeBinary<56>;
    "Raw57": FixedSizeBinary<57>;
    "Raw58": FixedSizeBinary<58>;
    "Raw59": FixedSizeBinary<59>;
    "Raw60": FixedSizeBinary<60>;
    "Raw61": FixedSizeBinary<61>;
    "Raw62": FixedSizeBinary<62>;
    "Raw63": FixedSizeBinary<63>;
    "Raw64": FixedSizeBinary<64>;
    "BlakeTwo256": FixedSizeBinary<32>;
    "Sha256": FixedSizeBinary<32>;
    "Keccak256": FixedSizeBinary<32>;
    "ShaThree256": FixedSizeBinary<32>;
}>;
export type If7b8240vgt2q5 = (FixedSizeBinary<20>) | undefined;
export type I7nkl7ntqohel8 = Array<Anonymize<I7svnfko10tq2e>>;
export type I3m6d7ohcp5n4v = {
    "deposit": bigint;
    "block": number;
    "info": Anonymize<I4122t6tpcniur>;
};
export type I4122t6tpcniur = Array<Enum<{
    "None": undefined;
    "Raw0": undefined;
    "Raw1": number;
    "Raw2": FixedSizeBinary<2>;
    "Raw3": FixedSizeBinary<3>;
    "Raw4": FixedSizeBinary<4>;
    "Raw5": FixedSizeBinary<5>;
    "Raw6": FixedSizeBinary<6>;
    "Raw7": FixedSizeBinary<7>;
    "Raw8": FixedSizeBinary<8>;
    "Raw9": FixedSizeBinary<9>;
    "Raw10": FixedSizeBinary<10>;
    "Raw11": FixedSizeBinary<11>;
    "Raw12": FixedSizeBinary<12>;
    "Raw13": FixedSizeBinary<13>;
    "Raw14": FixedSizeBinary<14>;
    "Raw15": FixedSizeBinary<15>;
    "Raw16": FixedSizeBinary<16>;
    "Raw17": FixedSizeBinary<17>;
    "Raw18": FixedSizeBinary<18>;
    "Raw19": FixedSizeBinary<19>;
    "Raw20": FixedSizeBinary<20>;
    "Raw21": FixedSizeBinary<21>;
    "Raw22": FixedSizeBinary<22>;
    "Raw23": FixedSizeBinary<23>;
    "Raw24": FixedSizeBinary<24>;
    "Raw25": FixedSizeBinary<25>;
    "Raw26": FixedSizeBinary<26>;
    "Raw27": FixedSizeBinary<27>;
    "Raw28": FixedSizeBinary<28>;
    "Raw29": FixedSizeBinary<29>;
    "Raw30": FixedSizeBinary<30>;
    "Raw31": FixedSizeBinary<31>;
    "Raw32": FixedSizeBinary<32>;
    "Raw33": FixedSizeBinary<33>;
    "Raw34": FixedSizeBinary<34>;
    "Raw35": FixedSizeBinary<35>;
    "Raw36": FixedSizeBinary<36>;
    "Raw37": FixedSizeBinary<37>;
    "Raw38": FixedSizeBinary<38>;
    "Raw39": FixedSizeBinary<39>;
    "Raw40": FixedSizeBinary<40>;
    "Raw41": FixedSizeBinary<41>;
    "Raw42": FixedSizeBinary<42>;
    "Raw43": FixedSizeBinary<43>;
    "Raw44": FixedSizeBinary<44>;
    "Raw45": FixedSizeBinary<45>;
    "Raw46": FixedSizeBinary<46>;
    "Raw47": FixedSizeBinary<47>;
    "Raw48": FixedSizeBinary<48>;
    "Raw49": FixedSizeBinary<49>;
    "Raw50": FixedSizeBinary<50>;
    "Raw51": FixedSizeBinary<51>;
    "Raw52": FixedSizeBinary<52>;
    "Raw53": FixedSizeBinary<53>;
    "Raw54": FixedSizeBinary<54>;
    "Raw55": FixedSizeBinary<55>;
    "Raw56": FixedSizeBinary<56>;
    "Raw57": FixedSizeBinary<57>;
    "Raw58": FixedSizeBinary<58>;
    "Raw59": FixedSizeBinary<59>;
    "Raw60": FixedSizeBinary<60>;
    "Raw61": FixedSizeBinary<61>;
    "Raw62": FixedSizeBinary<62>;
    "Raw63": FixedSizeBinary<63>;
    "Raw64": FixedSizeBinary<64>;
    "Raw65": FixedSizeBinary<65>;
    "Raw66": FixedSizeBinary<66>;
    "Raw67": FixedSizeBinary<67>;
    "Raw68": FixedSizeBinary<68>;
    "Raw69": FixedSizeBinary<69>;
    "Raw70": FixedSizeBinary<70>;
    "Raw71": FixedSizeBinary<71>;
    "Raw72": FixedSizeBinary<72>;
    "Raw73": FixedSizeBinary<73>;
    "Raw74": FixedSizeBinary<74>;
    "Raw75": FixedSizeBinary<75>;
    "Raw76": FixedSizeBinary<76>;
    "Raw77": FixedSizeBinary<77>;
    "Raw78": FixedSizeBinary<78>;
    "Raw79": FixedSizeBinary<79>;
    "Raw80": FixedSizeBinary<80>;
    "Raw81": FixedSizeBinary<81>;
    "Raw82": FixedSizeBinary<82>;
    "Raw83": FixedSizeBinary<83>;
    "Raw84": FixedSizeBinary<84>;
    "Raw85": FixedSizeBinary<85>;
    "Raw86": FixedSizeBinary<86>;
    "Raw87": FixedSizeBinary<87>;
    "Raw88": FixedSizeBinary<88>;
    "Raw89": FixedSizeBinary<89>;
    "Raw90": FixedSizeBinary<90>;
    "Raw91": FixedSizeBinary<91>;
    "Raw92": FixedSizeBinary<92>;
    "Raw93": FixedSizeBinary<93>;
    "Raw94": FixedSizeBinary<94>;
    "Raw95": FixedSizeBinary<95>;
    "Raw96": FixedSizeBinary<96>;
    "Raw97": FixedSizeBinary<97>;
    "Raw98": FixedSizeBinary<98>;
    "Raw99": FixedSizeBinary<99>;
    "Raw100": FixedSizeBinary<100>;
    "Raw101": FixedSizeBinary<101>;
    "Raw102": FixedSizeBinary<102>;
    "Raw103": FixedSizeBinary<103>;
    "Raw104": FixedSizeBinary<104>;
    "Raw105": FixedSizeBinary<105>;
    "Raw106": FixedSizeBinary<106>;
    "Raw107": FixedSizeBinary<107>;
    "Raw108": FixedSizeBinary<108>;
    "Raw109": FixedSizeBinary<109>;
    "Raw110": FixedSizeBinary<110>;
    "Raw111": FixedSizeBinary<111>;
    "Raw112": FixedSizeBinary<112>;
    "Raw113": FixedSizeBinary<113>;
    "Raw114": FixedSizeBinary<114>;
    "Raw115": FixedSizeBinary<115>;
    "Raw116": FixedSizeBinary<116>;
    "Raw117": FixedSizeBinary<117>;
    "Raw118": FixedSizeBinary<118>;
    "Raw119": FixedSizeBinary<119>;
    "Raw120": FixedSizeBinary<120>;
    "Raw121": FixedSizeBinary<121>;
    "Raw122": FixedSizeBinary<122>;
    "Raw123": FixedSizeBinary<123>;
    "Raw124": FixedSizeBinary<124>;
    "Raw125": FixedSizeBinary<125>;
    "Raw126": FixedSizeBinary<126>;
    "Raw127": FixedSizeBinary<127>;
    "Raw128": FixedSizeBinary<128>;
    "BlakeTwo256": FixedSizeBinary<32>;
    "Sha256": FixedSizeBinary<32>;
    "Keccak256": FixedSizeBinary<32>;
    "ShaThree256": FixedSizeBinary<32>;
    "TimelockEncrypted": {
        "encrypted": Binary;
        "reveal_round": bigint;
    };
    "ResetBondsFlag": undefined;
    "BigRaw": Binary;
}>>;
export type Ib9pv5dg6upo6t = Array<[Binary, bigint]>;
export type I27ub49plcvb4c = {
    "last_epoch": bigint;
    "used_space": bigint;
};
export type Ic3l568el19b24 = [Anonymize<Ibjuap2vk03rp6>, Anonymize<Ifoernv5r40rfc>, Anonymize<Ideko6oeomboa6>];
export type Ibjuap2vk03rp6 = AnonymousEnum<{
    "Legacy": Anonymize<I22u79j4u5as1p>;
    "EIP2930": {
        "chain_id": bigint;
        "nonce": Anonymize<I4totqt881mlti>;
        "gas_price": Anonymize<I4totqt881mlti>;
        "gas_limit": Anonymize<I4totqt881mlti>;
        "action": Anonymize<I2do93a3gr3ege>;
        "value": Anonymize<I4totqt881mlti>;
        "input": Binary;
        "access_list": Anonymize<Ieap15h2pjii9u>;
        "signature": Anonymize<I9veufneid0sta>;
    };
    "EIP1559": {
        "chain_id": bigint;
        "nonce": Anonymize<I4totqt881mlti>;
        "max_priority_fee_per_gas": Anonymize<I4totqt881mlti>;
        "max_fee_per_gas": Anonymize<I4totqt881mlti>;
        "gas_limit": Anonymize<I4totqt881mlti>;
        "action": Anonymize<I2do93a3gr3ege>;
        "value": Anonymize<I4totqt881mlti>;
        "input": Binary;
        "access_list": Anonymize<Ieap15h2pjii9u>;
        "signature": Anonymize<I9veufneid0sta>;
    };
    "EIP7702": {
        "chain_id": bigint;
        "nonce": Anonymize<I4totqt881mlti>;
        "max_priority_fee_per_gas": Anonymize<I4totqt881mlti>;
        "max_fee_per_gas": Anonymize<I4totqt881mlti>;
        "gas_limit": Anonymize<I4totqt881mlti>;
        "destination": Anonymize<I2do93a3gr3ege>;
        "value": Anonymize<I4totqt881mlti>;
        "data": Binary;
        "access_list": Anonymize<Ieap15h2pjii9u>;
        "authorization_list": Anonymize<Idg0qi60379vnh>;
        "signature": Anonymize<I9veufneid0sta>;
    };
}>;
export type I22u79j4u5as1p = {
    "nonce": Anonymize<I4totqt881mlti>;
    "gas_price": Anonymize<I4totqt881mlti>;
    "gas_limit": Anonymize<I4totqt881mlti>;
    "action": Anonymize<I2do93a3gr3ege>;
    "value": Anonymize<I4totqt881mlti>;
    "input": Binary;
    "signature": {
        "v": bigint;
        "r": FixedSizeBinary<32>;
        "s": FixedSizeBinary<32>;
    };
};
export type I2do93a3gr3ege = AnonymousEnum<{
    "Call": FixedSizeBinary<20>;
    "Create": undefined;
}>;
export type Ieap15h2pjii9u = Array<{
    "address": FixedSizeBinary<20>;
    "storage_keys": Anonymize<Ic5m5lp1oioo8r>;
}>;
export type I9veufneid0sta = {
    "odd_y_parity": boolean;
    "r": FixedSizeBinary<32>;
    "s": FixedSizeBinary<32>;
};
export type Idg0qi60379vnh = Array<{
    "chain_id": bigint;
    "address": FixedSizeBinary<20>;
    "nonce": Anonymize<I4totqt881mlti>;
    "signature": Anonymize<I9veufneid0sta>;
}>;
export type Ifoernv5r40rfc = {
    "transaction_hash": FixedSizeBinary<32>;
    "transaction_index": number;
    "from": FixedSizeBinary<20>;
    "to"?: Anonymize<If7b8240vgt2q5>;
    "contract_address"?: Anonymize<If7b8240vgt2q5>;
    "logs": Anonymize<Ids7ng2qsv7snu>;
    "logs_bloom": FixedSizeBinary<256>;
};
export type Ids7ng2qsv7snu = Array<Anonymize<I10qb03fpuk6em>>;
export type Ideko6oeomboa6 = AnonymousEnum<{
    "Legacy": Anonymize<I16nm875k0bak5>;
    "EIP2930": Anonymize<I16nm875k0bak5>;
    "EIP1559": Anonymize<I16nm875k0bak5>;
    "EIP7702": Anonymize<I16nm875k0bak5>;
}>;
export type I16nm875k0bak5 = {
    "status_code": number;
    "used_gas": Anonymize<I4totqt881mlti>;
    "logs_bloom": FixedSizeBinary<256>;
    "logs": Anonymize<Ids7ng2qsv7snu>;
};
export type Ib0hfhkohlekcj = {
    "header": Anonymize<I4v962mnhj6j6r>;
    "transactions": Anonymize<Ie30stbbeaul1o>;
    "ommers": Anonymize<I78ffku0ve5fgm>;
};
export type I4v962mnhj6j6r = {
    "parent_hash": FixedSizeBinary<32>;
    "ommers_hash": FixedSizeBinary<32>;
    "beneficiary": FixedSizeBinary<20>;
    "state_root": FixedSizeBinary<32>;
    "transactions_root": FixedSizeBinary<32>;
    "receipts_root": FixedSizeBinary<32>;
    "logs_bloom": FixedSizeBinary<256>;
    "difficulty": Anonymize<I4totqt881mlti>;
    "number": Anonymize<I4totqt881mlti>;
    "gas_limit": Anonymize<I4totqt881mlti>;
    "gas_used": Anonymize<I4totqt881mlti>;
    "timestamp": bigint;
    "extra_data": Binary;
    "mix_hash": FixedSizeBinary<32>;
    "nonce": FixedSizeBinary<8>;
};
export type Ie30stbbeaul1o = Array<Anonymize<Ibjuap2vk03rp6>>;
export type I78ffku0ve5fgm = Array<Anonymize<I4v962mnhj6j6r>>;
export type I32lgu058i52q9 = Array<Anonymize<Ideko6oeomboa6>>;
export type Ie7atdsih6q14b = Array<Anonymize<Ifoernv5r40rfc>>;
export type I7jidl7qnnq87c = {
    "size": bigint;
    "hash": FixedSizeBinary<32>;
};
export type I82cps8ng2jtug = [FixedSizeBinary<20>, FixedSizeBinary<32>];
export type I4gqmlq9k6jlk3 = Array<FixedSizeBinary<20>>;
export type I494mq1ertfc9k = {
    "public_key": Binary;
    "period": number;
    "genesis_time": number;
    "hash": Binary;
    "group_hash": Binary;
    "scheme_id": Binary;
    "metadata": Binary;
};
export type Ialchst9lgd11u = {
    "round": bigint;
    "randomness": Binary;
    "signature": Binary;
};
export type If0p9hvn3kegj1 = {
    "creator": SS58String;
    "deposit": bigint;
    "min_contribution": bigint;
    "end": number;
    "cap": bigint;
    "funds_account": SS58String;
    "raised": bigint;
    "target_address"?: Anonymize<Ihfphjolmsqq1>;
    "call"?: (PreimagesBounded) | undefined;
    "finalized": boolean;
    "contributors_count": number;
};
export type I5kulbesqc1h1t = {
    "owner": SS58String;
    "deposit": bigint;
    "refcount": bigint;
    "determinism": Anonymize<I2dfliekq1ed7e>;
    "code_len": number;
};
export type I2dfliekq1ed7e = AnonymousEnum<{
    "Enforced": undefined;
    "Relaxed": undefined;
}>;
export type I36dvimehsh2tm = {
    "trie_id": Binary;
    "code_hash": FixedSizeBinary<32>;
    "storage_bytes": number;
    "storage_items": number;
    "storage_byte_deposit": bigint;
    "storage_item_deposit": bigint;
    "storage_base_deposit": bigint;
    "delegate_dependencies": Anonymize<I3geksg000c171>;
};
export type I8t4pajubp34g3 = {
    "insert_counter": number;
    "delete_counter": number;
};
export type Ifdiflqufkknl8 = {
    "author": SS58String;
    "commitment": FixedSizeBinary<32>;
    "ciphertext": Binary;
    "submitted_in": number;
};
export type In7a38730s6qs = {
    "base_block": Anonymize<I4q39t5hn830vp>;
    "max_block": Anonymize<I4q39t5hn830vp>;
    "per_class": {
        "normal": {
            "base_extrinsic": Anonymize<I4q39t5hn830vp>;
            "max_extrinsic"?: Anonymize<Iasb8k6ash5mjn>;
            "max_total"?: Anonymize<Iasb8k6ash5mjn>;
            "reserved"?: Anonymize<Iasb8k6ash5mjn>;
        };
        "operational": {
            "base_extrinsic": Anonymize<I4q39t5hn830vp>;
            "max_extrinsic"?: Anonymize<Iasb8k6ash5mjn>;
            "max_total"?: Anonymize<Iasb8k6ash5mjn>;
            "reserved"?: Anonymize<Iasb8k6ash5mjn>;
        };
        "mandatory": {
            "base_extrinsic": Anonymize<I4q39t5hn830vp>;
            "max_extrinsic"?: Anonymize<Iasb8k6ash5mjn>;
            "max_total"?: Anonymize<Iasb8k6ash5mjn>;
            "reserved"?: Anonymize<Iasb8k6ash5mjn>;
        };
    };
};
export type If15el53dd76v9 = {
    "normal": number;
    "operational": number;
    "mandatory": number;
};
export type I9s0ave7t0vnrk = {
    "read": bigint;
    "write": bigint;
};
export type I4fo08joqmcqnm = {
    "spec_name": string;
    "impl_name": string;
    "authoring_version": number;
    "spec_version": number;
    "impl_version": number;
    "apis": Anonymize<Ic9hg6pp5pkea5>;
    "transaction_version": number;
    "system_version": number;
};
export type Ic9hg6pp5pkea5 = Array<[FixedSizeBinary<8>, number]>;
export type I35p85j063s0il = (bigint) | undefined;
export type Ijc5n210o8bbf = {
    "limits": {
        "event_topics": number;
        "memory_pages": number;
        "subject_len": number;
        "payload_len": number;
        "runtime_memory": number;
        "validator_runtime_memory": number;
        "event_ref_time": bigint;
    };
    "instruction_weights": number;
};
export type I3m5sq54sjdlso = {};
export type Iekve0i6djpd9f = AnonymousEnum<{
    /**
     * Make some on-chain remark.
     *
     * Can be executed by every `origin`.
     */
    "remark": Anonymize<I8ofcg5rbj0g2c>;
    /**
     * Set the number of pages in the WebAssembly environment's heap.
     */
    "set_heap_pages": Anonymize<I4adgbll7gku4i>;
    /**
     * Set the new runtime code.
     */
    "set_code": Anonymize<I6pjjpfvhvcfru>;
    /**
     * Set the new runtime code without doing any checks of the given `code`.
     *
     * Note that runtime upgrades will not run if this is called with a not-increasing spec
     * version!
     */
    "set_code_without_checks": Anonymize<I6pjjpfvhvcfru>;
    /**
     * Set some items of storage.
     */
    "set_storage": Anonymize<I9pj91mj79qekl>;
    /**
     * Kill some items from storage.
     */
    "kill_storage": Anonymize<I39uah9nss64h9>;
    /**
     * Kill all storage items with a key that starts with the given prefix.
     *
     * **NOTE:** We rely on the Root origin to provide us the number of subkeys under
     * the prefix we are removing to accurately calculate the weight of this function.
     */
    "kill_prefix": Anonymize<Ik64dknsq7k08>;
    /**
     * Make some on-chain remark and emit event.
     */
    "remark_with_event": Anonymize<I8ofcg5rbj0g2c>;
    /**
     * Authorize an upgrade to a given `code_hash` for the runtime. The runtime can be supplied
     * later.
     *
     * This call requires Root origin.
     */
    "authorize_upgrade": Anonymize<Ib51vk42m1po4n>;
    /**
     * Authorize an upgrade to a given `code_hash` for the runtime. The runtime can be supplied
     * later.
     *
     * WARNING: This authorizes an upgrade that will take place without any safety checks, for
     * example that the spec name remains the same and that the version number increases. Not
     * recommended for normal use. Use `authorize_upgrade` instead.
     *
     * This call requires Root origin.
     */
    "authorize_upgrade_without_checks": Anonymize<Ib51vk42m1po4n>;
    /**
     * Provide the preimage (runtime binary) `code` for an upgrade that has been authorized.
     *
     * If the authorization required a version check, this call will ensure the spec name
     * remains unchanged and that the spec version has increased.
     *
     * Depending on the runtime's `OnSetCode` configuration, this function may directly apply
     * the new `code` in the same block or attempt to schedule the upgrade.
     *
     * All origins are allowed.
     */
    "apply_authorized_upgrade": Anonymize<I6pjjpfvhvcfru>;
}>;
export type I8ofcg5rbj0g2c = {
    "remark": Binary;
};
export type I4adgbll7gku4i = {
    "pages": bigint;
};
export type I6pjjpfvhvcfru = {
    "code": Binary;
};
export type I9pj91mj79qekl = {
    "items": Anonymize<I6pi5ou8r1hblk>;
};
export type I6pi5ou8r1hblk = Array<Anonymize<Idkbvh6dahk1v7>>;
export type Idkbvh6dahk1v7 = FixedSizeArray<2, Binary>;
export type I39uah9nss64h9 = {
    "keys": Anonymize<Itom7fk49o0c9>;
};
export type Itom7fk49o0c9 = Array<Binary>;
export type Ik64dknsq7k08 = {
    "prefix": Binary;
    "subkeys": number;
};
export type Ib51vk42m1po4n = {
    "code_hash": FixedSizeBinary<32>;
};
export type I7d75gqfg6jh9c = AnonymousEnum<{
    /**
     * Set the current time.
     *
     * This call should be invoked exactly once per block. It will panic at the finalization
     * phase, if this call hasn't been invoked by that time.
     *
     * The timestamp should be greater than the previous one by the amount specified by
     * [`Config::MinimumPeriod`].
     *
     * The dispatch origin for this call must be _None_.
     *
     * This dispatch class is _Mandatory_ to ensure it gets executed in the block. Be aware
     * that changing the complexity of this call could result exhausting the resources in a
     * block to execute any other calls.
     *
     * ## Complexity
     * - `O(1)` (Note that implementations of `OnTimestampSet` must also be `O(1)`)
     * - 1 storage read and 1 storage mutation (codec `O(1)` because of `DidUpdate::take` in
     * `on_finalize`)
     * - 1 event handler `on_timestamp_set`. Must be `O(1)`.
     */
    "set": Anonymize<Idcr6u6361oad9>;
}>;
export type Idcr6u6361oad9 = {
    "now": bigint;
};
export type Ibck9ekr2i96uj = AnonymousEnum<{
    /**
     * Report voter equivocation/misbehavior. This method will verify the
     * equivocation proof and validate the given key ownership proof
     * against the extracted offender. If both are valid, the offence
     * will be reported.
     */
    "report_equivocation": Anonymize<I3a5kuu5t5jj3g>;
    /**
     * Report voter equivocation/misbehavior. This method will verify the
     * equivocation proof and validate the given key ownership proof
     * against the extracted offender. If both are valid, the offence
     * will be reported.
     *
     * This extrinsic must be called unsigned and it is expected that only
     * block authors will call it (validated in `ValidateUnsigned`), as such
     * if the block author is defined it will be defined as the equivocation
     * reporter.
     */
    "report_equivocation_unsigned": Anonymize<I3a5kuu5t5jj3g>;
    /**
     * Note that the current authority set of the GRANDPA finality gadget has stalled.
     *
     * This will trigger a forced authority set change at the beginning of the next session, to
     * be enacted `delay` blocks after that. The `delay` should be high enough to safely assume
     * that the block signalling the forced change will not be re-orged e.g. 1000 blocks.
     * The block production rate (which may be slowed down because of finality lagging) should
     * be taken into account when choosing the `delay`. The GRANDPA voters based on the new
     * authority will start voting on top of `best_finalized_block_number` for new finalized
     * blocks. `best_finalized_block_number` should be the highest of the latest finalized
     * block of all validators of the new authority set.
     *
     * Only callable by root.
     */
    "note_stalled": Anonymize<I2hviml3snvhhn>;
}>;
export type I3a5kuu5t5jj3g = {
    "equivocation_proof": Anonymize<I9puqgoda8ofk4>;
};
export type I9puqgoda8ofk4 = {
    "set_id": bigint;
    "equivocation": GrandpaEquivocation;
};
export type GrandpaEquivocation = Enum<{
    "Prevote": {
        "round_number": bigint;
        "identity": FixedSizeBinary<32>;
        "first": [{
            "target_hash": FixedSizeBinary<32>;
            "target_number": number;
        }, FixedSizeBinary<64>];
        "second": [{
            "target_hash": FixedSizeBinary<32>;
            "target_number": number;
        }, FixedSizeBinary<64>];
    };
    "Precommit": {
        "round_number": bigint;
        "identity": FixedSizeBinary<32>;
        "first": [{
            "target_hash": FixedSizeBinary<32>;
            "target_number": number;
        }, FixedSizeBinary<64>];
        "second": [{
            "target_hash": FixedSizeBinary<32>;
            "target_number": number;
        }, FixedSizeBinary<64>];
    };
}>;
export declare const GrandpaEquivocation: GetEnum<GrandpaEquivocation>;
export type I2hviml3snvhhn = {
    "delay": number;
    "best_finalized_block_number": number;
};
export type I9svldsp29mh87 = AnonymousEnum<{
    /**
     * Transfer some liquid free balance to another account.
     *
     * `transfer_allow_death` will set the `FreeBalance` of the sender and receiver.
     * If the sender's account is below the existential deposit as a result
     * of the transfer, the account will be reaped.
     *
     * The dispatch origin for this call must be `Signed` by the transactor.
     */
    "transfer_allow_death": Anonymize<I4ktuaksf5i1gk>;
    /**
     * Exactly as `transfer_allow_death`, except the origin must be root and the source account
     * may be specified.
     */
    "force_transfer": Anonymize<I9bqtpv2ii35mp>;
    /**
     * Same as the [`transfer_allow_death`] call, but with a check that the transfer will not
     * kill the origin account.
     *
     * 99% of the time you want [`transfer_allow_death`] instead.
     *
     * [`transfer_allow_death`]: struct.Pallet.html#method.transfer
     */
    "transfer_keep_alive": Anonymize<I4ktuaksf5i1gk>;
    /**
     * Transfer the entire transferable balance from the caller account.
     *
     * NOTE: This function only attempts to transfer _transferable_ balances. This means that
     * any locked, reserved, or existential deposits (when `keep_alive` is `true`), will not be
     * transferred by this function. To ensure that this function results in a killed account,
     * you might need to prepare the account by removing any reference counters, storage
     * deposits, etc...
     *
     * The dispatch origin of this call must be Signed.
     *
     * - `dest`: The recipient of the transfer.
     * - `keep_alive`: A boolean to determine if the `transfer_all` operation should send all
     * of the funds the account has, causing the sender account to be killed (false), or
     * transfer everything except at least the existential deposit, which will guarantee to
     * keep the sender account alive (true).
     */
    "transfer_all": Anonymize<I9j7pagd6d4bda>;
    /**
     * Unreserve some balance from a user by force.
     *
     * Can only be called by ROOT.
     */
    "force_unreserve": Anonymize<I2h9pmio37r7fb>;
    /**
     * Upgrade a specified account.
     *
     * - `origin`: Must be `Signed`.
     * - `who`: The account to be upgraded.
     *
     * This will waive the transaction fee if at least all but 10% of the accounts needed to
     * be upgraded. (We let some not have to be upgraded just in order to allow for the
     * possibility of churn).
     */
    "upgrade_accounts": Anonymize<Ibmr18suc9ikh9>;
    /**
     * Set the regular balance of a given account.
     *
     * The dispatch origin for this call is `root`.
     */
    "force_set_balance": Anonymize<I9iq22t0burs89>;
    /**
     * Adjust the total issuance in a saturating way.
     *
     * Can only be called by root and always needs a positive `delta`.
     *
     * # Example
     */
    "force_adjust_total_issuance": Anonymize<I5u8olqbbvfnvf>;
    /**
     * Burn the specified liquid free balance from the origin account.
     *
     * If the origin's account ends up below the existential deposit as a result
     * of the burn and `keep_alive` is false, the account will be reaped.
     *
     * Unlike sending funds to a _burn_ address, which merely makes the funds inaccessible,
     * this `burn` operation will reduce total issuance by the amount _burned_.
     */
    "burn": Anonymize<I5utcetro501ir>;
}>;
export type I4ktuaksf5i1gk = {
    "dest": MultiAddress;
    "value": bigint;
};
export type MultiAddress = Enum<{
    "Id": SS58String;
    "Index": undefined;
    "Raw": Binary;
    "Address32": FixedSizeBinary<32>;
    "Address20": FixedSizeBinary<20>;
}>;
export declare const MultiAddress: GetEnum<MultiAddress>;
export type I9bqtpv2ii35mp = {
    "source": MultiAddress;
    "dest": MultiAddress;
    "value": bigint;
};
export type I9j7pagd6d4bda = {
    "dest": MultiAddress;
    "keep_alive": boolean;
};
export type I2h9pmio37r7fb = {
    "who": MultiAddress;
    "amount": bigint;
};
export type Ibmr18suc9ikh9 = {
    "who": Anonymize<Ia2lhg7l2hilo3>;
};
export type I9iq22t0burs89 = {
    "who": MultiAddress;
    "new_free": bigint;
};
export type I5u8olqbbvfnvf = {
    "direction": BalancesAdjustmentDirection;
    "delta": bigint;
};
export type BalancesAdjustmentDirection = Enum<{
    "Increase": undefined;
    "Decrease": undefined;
}>;
export declare const BalancesAdjustmentDirection: GetEnum<BalancesAdjustmentDirection>;
export type I5utcetro501ir = {
    "value": bigint;
    "keep_alive": boolean;
};
export type I5cgnbuovlct77 = AnonymousEnum<{
    /**
     * --- Sets the caller weights for the incentive mechanism. The call can be
     * made from the hotkey account so is potentially insecure, however, the damage
     * of changing weights is minimal if caught early. This function includes all the
     * checks that the passed weights meet the requirements. Stored as u16s they represent
     * rational values in the range [0,1] which sum to 1 and can be interpreted as
     * probabilities. The specific weights determine how inflation propagates outward
     * from this peer.
     *
     * Note: The 16 bit integers weights should represent 1.0 as the max u16.
     * However, the function normalizes all integers to u16_max anyway. This means that if the sum of all
     * elements is larger or smaller than the amount of elements * u16_max, all elements
     * will be corrected for this deviation.
     *
     * # Args:
     * * `origin`: (<T as frame_system::Config>Origin):
     * - The caller, a hotkey who wishes to set their weights.
     *
     * * `netuid` (u16):
     * - The network uid we are setting these weights on.
     *
     * * `dests` (Vec<u16>):
     * - The edge endpoint for the weight, i.e. j for w_ij.
     *
     * * 'weights' (Vec<u16>):
     * - The u16 integer encoded weights. Interpreted as rational
     * values in the range [0,1]. They must sum to in32::MAX.
     *
     * * 'version_key' ( u64 ):
     * - The network version key to check if the validator is up to date.
     *
     * # Event:
     * * WeightsSet;
     * - On successfully setting the weights on chain.
     *
     * # Raises:
     * * 'MechanismDoesNotExist':
     * - Attempting to set weights on a non-existent network.
     *
     * * 'NotRegistered':
     * - Attempting to set weights from a non registered account.
     *
     * * 'WeightVecNotEqualSize':
     * - Attempting to set weights with uids not of same length.
     *
     * * 'DuplicateUids':
     * - Attempting to set weights with duplicate uids.
     *
     * * 'UidsLengthExceedUidsInSubNet':
     * - Attempting to set weights above the max allowed uids.
     *
     * * 'UidVecContainInvalidOne':
     * - Attempting to set weights with invalid uids.
     *
     * * 'WeightVecLengthIsLow':
     * - Attempting to set weights with fewer weights than min.
     *
     * * 'MaxWeightExceeded':
     * - Attempting to set weights with max value exceeding limit.
     */
    "set_weights": Anonymize<Icv6ofu4lqekr4>;
    /**
     * --- Sets the caller weights for the incentive mechanism for mechanisms. The call
     * can be made from the hotkey account so is potentially insecure, however, the damage
     * of changing weights is minimal if caught early. This function includes all the
     * checks that the passed weights meet the requirements. Stored as u16s they represent
     * rational values in the range [0,1] which sum to 1 and can be interpreted as
     * probabilities. The specific weights determine how inflation propagates outward
     * from this peer.
     *
     * Note: The 16 bit integers weights should represent 1.0 as the max u16.
     * However, the function normalizes all integers to u16_max anyway. This means that if the sum of all
     * elements is larger or smaller than the amount of elements * u16_max, all elements
     * will be corrected for this deviation.
     *
     * # Args:
     * * `origin`: (<T as frame_system::Config>Origin):
     * - The caller, a hotkey who wishes to set their weights.
     *
     * * `netuid` (u16):
     * - The network uid we are setting these weights on.
     *
     * * `mecid` (`u8`):
     * - The u8 mechnism identifier.
     *
     * * `dests` (Vec<u16>):
     * - The edge endpoint for the weight, i.e. j for w_ij.
     *
     * * 'weights' (Vec<u16>):
     * - The u16 integer encoded weights. Interpreted as rational
     * values in the range [0,1]. They must sum to in32::MAX.
     *
     * * 'version_key' ( u64 ):
     * - The network version key to check if the validator is up to date.
     *
     * # Event:
     * * WeightsSet;
     * - On successfully setting the weights on chain.
     *
     * # Raises:
     * * 'MechanismDoesNotExist':
     * - Attempting to set weights on a non-existent network.
     *
     * * 'NotRegistered':
     * - Attempting to set weights from a non registered account.
     *
     * * 'WeightVecNotEqualSize':
     * - Attempting to set weights with uids not of same length.
     *
     * * 'DuplicateUids':
     * - Attempting to set weights with duplicate uids.
     *
     * * 'UidsLengthExceedUidsInSubNet':
     * - Attempting to set weights above the max allowed uids.
     *
     * * 'UidVecContainInvalidOne':
     * - Attempting to set weights with invalid uids.
     *
     * * 'WeightVecLengthIsLow':
     * - Attempting to set weights with fewer weights than min.
     *
     * * 'MaxWeightExceeded':
     * - Attempting to set weights with max value exceeding limit.
     */
    "set_mechanism_weights": Anonymize<I48embv0n659kj>;
    /**
     * --- Allows a hotkey to set weights for multiple netuids as a batch.
     *
     * # Args:
     * * `origin`: (<T as frame_system::Config>Origin):
     * - The caller, a hotkey who wishes to set their weights.
     *
     * * `netuids` (Vec<Compact<u16>>):
     * - The network uids we are setting these weights on.
     *
     * * `weights` (Vec<Vec<(Compact<u16>, Compact<u16>)>):
     * - The weights to set for each network. [(uid, weight), ...]
     *
     * * `version_keys` (Vec<Compact<u64>>):
     * - The network version keys to check if the validator is up to date.
     *
     * # Event:
     * * WeightsSet;
     * - On successfully setting the weights on chain.
     * * BatchWeightsCompleted;
     * - On success of the batch.
     * * BatchCompletedWithErrors;
     * - On failure of any of the weights in the batch.
     * * BatchWeightItemFailed;
     * - On failure for each failed item in the batch.
     *
     */
    "batch_set_weights": Anonymize<I8l6dbd18t5aja>;
    /**
     * ---- Used to commit a hash of your weight values to later be revealed.
     *
     * # Args:
     * * `origin`: (`<T as frame_system::Config>::RuntimeOrigin`):
     * - The signature of the committing hotkey.
     *
     * * `netuid` (`u16`):
     * - The u16 network identifier.
     *
     * * `commit_hash` (`H256`):
     * - The hash representing the committed weights.
     *
     * # Raises:
     * * `CommitRevealDisabled`:
     * - Attempting to commit when the commit-reveal mechanism is disabled.
     *
     * * `TooManyUnrevealedCommits`:
     * - Attempting to commit when the user has more than the allowed limit of unrevealed commits.
     *
     */
    "commit_weights": Anonymize<I513du23unvan>;
    /**
     * ---- Used to commit a hash of your weight values to later be revealed for mechanisms.
     *
     * # Args:
     * * `origin`: (`<T as frame_system::Config>::RuntimeOrigin`):
     * - The signature of the committing hotkey.
     *
     * * `netuid` (`u16`):
     * - The u16 network identifier.
     *
     * * `mecid` (`u8`):
     * - The u8 mechanism identifier.
     *
     * * `commit_hash` (`H256`):
     * - The hash representing the committed weights.
     *
     * # Raises:
     * * `CommitRevealDisabled`:
     * - Attempting to commit when the commit-reveal mechanism is disabled.
     *
     * * `TooManyUnrevealedCommits`:
     * - Attempting to commit when the user has more than the allowed limit of unrevealed commits.
     *
     */
    "commit_mechanism_weights": Anonymize<I36o6oho99gjm8>;
    /**
     * --- Allows a hotkey to commit weight hashes for multiple netuids as a batch.
     *
     * # Args:
     * * `origin`: (<T as frame_system::Config>Origin):
     * - The caller, a hotkey who wishes to set their weights.
     *
     * * `netuids` (Vec<Compact<u16>>):
     * - The network uids we are setting these weights on.
     *
     * * `commit_hashes` (Vec<H256>):
     * - The commit hashes to commit.
     *
     * # Event:
     * * WeightsSet;
     * - On successfully setting the weights on chain.
     * * BatchWeightsCompleted;
     * - On success of the batch.
     * * BatchCompletedWithErrors;
     * - On failure of any of the weights in the batch.
     * * BatchWeightItemFailed;
     * - On failure for each failed item in the batch.
     *
     */
    "batch_commit_weights": Anonymize<If3mvus4cmnb7l>;
    /**
     * ---- Used to reveal the weights for a previously committed hash.
     *
     * # Args:
     * * `origin`: (`<T as frame_system::Config>::RuntimeOrigin`):
     * - The signature of the revealing hotkey.
     *
     * * `netuid` (`u16`):
     * - The u16 network identifier.
     *
     * * `uids` (`Vec<u16>`):
     * - The uids for the weights being revealed.
     *
     * * `values` (`Vec<u16>`):
     * - The values of the weights being revealed.
     *
     * * `salt` (`Vec<u16>`):
     * - The salt used to generate the commit hash.
     *
     * * `version_key` (`u64`):
     * - The network version key.
     *
     * # Raises:
     * * `CommitRevealDisabled`:
     * - Attempting to reveal weights when the commit-reveal mechanism is disabled.
     *
     * * `NoWeightsCommitFound`:
     * - Attempting to reveal weights without an existing commit.
     *
     * * `ExpiredWeightCommit`:
     * - Attempting to reveal a weight commit that has expired.
     *
     * * `RevealTooEarly`:
     * - Attempting to reveal weights outside the valid reveal period.
     *
     * * `InvalidRevealCommitHashNotMatch`:
     * - The revealed hash does not match any committed hash.
     *
     */
    "reveal_weights": Anonymize<I3qrhi1ua10nnf>;
    /**
     * ---- Used to reveal the weights for a previously committed hash for mechanisms.
     *
     * # Args:
     * * `origin`: (`<T as frame_system::Config>::RuntimeOrigin`):
     * - The signature of the revealing hotkey.
     *
     * * `netuid` (`u16`):
     * - The u16 network identifier.
     *
     * * `mecid` (`u8`):
     * - The u8 mechanism identifier.
     *
     * * `uids` (`Vec<u16>`):
     * - The uids for the weights being revealed.
     *
     * * `values` (`Vec<u16>`):
     * - The values of the weights being revealed.
     *
     * * `salt` (`Vec<u16>`):
     * - The salt used to generate the commit hash.
     *
     * * `version_key` (`u64`):
     * - The network version key.
     *
     * # Raises:
     * * `CommitRevealDisabled`:
     * - Attempting to reveal weights when the commit-reveal mechanism is disabled.
     *
     * * `NoWeightsCommitFound`:
     * - Attempting to reveal weights without an existing commit.
     *
     * * `ExpiredWeightCommit`:
     * - Attempting to reveal a weight commit that has expired.
     *
     * * `RevealTooEarly`:
     * - Attempting to reveal weights outside the valid reveal period.
     *
     * * `InvalidRevealCommitHashNotMatch`:
     * - The revealed hash does not match any committed hash.
     *
     */
    "reveal_mechanism_weights": Anonymize<I2hpc4ev2drsf2>;
    /**
     * ---- Used to commit encrypted commit-reveal v3 weight values to later be revealed.
     *
     * # Args:
     * * `origin`: (`<T as frame_system::Config>::RuntimeOrigin`):
     * - The committing hotkey.
     *
     * * `netuid` (`u16`):
     * - The u16 network identifier.
     *
     * * `commit` (`Vec<u8>`):
     * - The encrypted compressed commit.
     * The steps for this are:
     * 1. Instantiate [`WeightsTlockPayload`]
     * 2. Serialize it using the `parity_scale_codec::Encode` trait
     * 3. Encrypt it following the steps (here)[https://github.com/ideal-lab5/tle/blob/f8e6019f0fb02c380ebfa6b30efb61786dede07b/timelock/src/tlock.rs#L283-L336]
     * to produce a [`TLECiphertext<TinyBLS381>`] type.
     * 4. Serialize and compress using the `ark-serialize` `CanonicalSerialize` trait.
     *
     * * reveal_round (`u64`):
     * - The drand reveal round which will be avaliable during epoch `n+1` from the current
     * epoch.
     *
     * # Raises:
     * * `CommitRevealV3Disabled`:
     * - Attempting to commit when the commit-reveal mechanism is disabled.
     *
     * * `TooManyUnrevealedCommits`:
     * - Attempting to commit when the user has more than the allowed limit of unrevealed commits.
     *
     * ---- Used to commit encrypted commit-reveal v3 weight values to later be revealed for mechanisms.
     *
     * # Args:
     * * `origin`: (`<T as frame_system::Config>::RuntimeOrigin`):
     * - The committing hotkey.
     *
     * * `netuid` (`u16`):
     * - The u16 network identifier.
     *
     * * `mecid` (`u8`):
     * - The u8 mechanism identifier.
     *
     * * `commit` (`Vec<u8>`):
     * - The encrypted compressed commit.
     * The steps for this are:
     * 1. Instantiate [`WeightsTlockPayload`]
     * 2. Serialize it using the `parity_scale_codec::Encode` trait
     * 3. Encrypt it following the steps (here)[https://github.com/ideal-lab5/tle/blob/f8e6019f0fb02c380ebfa6b30efb61786dede07b/timelock/src/tlock.rs#L283-L336]
     * to produce a [`TLECiphertext<TinyBLS381>`] type.
     * 4. Serialize and compress using the `ark-serialize` `CanonicalSerialize` trait.
     *
     * * reveal_round (`u64`):
     * - The drand reveal round which will be avaliable during epoch `n+1` from the current
     * epoch.
     *
     * # Raises:
     * * `CommitRevealV3Disabled`:
     * - Attempting to commit when the commit-reveal mechanism is disabled.
     *
     * * `TooManyUnrevealedCommits`:
     * - Attempting to commit when the user has more than the allowed limit of unrevealed commits.
     *
     */
    "commit_crv3_mechanism_weights": Anonymize<I73q6qh9ckhm04>;
    /**
     * ---- The implementation for batch revealing committed weights.
     *
     * # Args:
     * * `origin`: (`<T as frame_system::Config>::RuntimeOrigin`):
     * - The signature of the revealing hotkey.
     *
     * * `netuid` (`u16`):
     * - The u16 network identifier.
     *
     * * `uids_list` (`Vec<Vec<u16>>`):
     * - A list of uids for each set of weights being revealed.
     *
     * * `values_list` (`Vec<Vec<u16>>`):
     * - A list of values for each set of weights being revealed.
     *
     * * `salts_list` (`Vec<Vec<u16>>`):
     * - A list of salts used to generate the commit hashes.
     *
     * * `version_keys` (`Vec<u64>`):
     * - A list of network version keys.
     *
     * # Raises:
     * * `CommitRevealDisabled`:
     * - Attempting to reveal weights when the commit-reveal mechanism is disabled.
     *
     * * `NoWeightsCommitFound`:
     * - Attempting to reveal weights without an existing commit.
     *
     * * `ExpiredWeightCommit`:
     * - Attempting to reveal a weight commit that has expired.
     *
     * * `RevealTooEarly`:
     * - Attempting to reveal weights outside the valid reveal period.
     *
     * * `InvalidRevealCommitHashNotMatch`:
     * - The revealed hash does not match any committed hash.
     *
     * * `InvalidInputLengths`:
     * - The input vectors are of mismatched lengths.
     */
    "batch_reveal_weights": Anonymize<Idia8cmqvul6et>;
    /**
     * --- Allows delegates to decrease its take value.
     *
     * # Args:
     * * 'origin': (<T as frame_system::Config>::Origin):
     * - The signature of the caller's coldkey.
     *
     * * 'hotkey' (T::AccountId):
     * - The hotkey we are delegating (must be owned by the coldkey.)
     *
     * * 'netuid' (u16):
     * - Subnet ID to decrease take for
     *
     * * 'take' (u16):
     * - The new stake proportion that this hotkey takes from delegations.
     * The new value can be between 0 and 11_796 and should be strictly
     * lower than the previous value. It T is the new value (rational number),
     * the the parameter is calculated as [65535 * T]. For example, 1% would be
     * [0.01 * 65535] = [655.35] = 655
     *
     * # Event:
     * * TakeDecreased;
     * - On successfully setting a decreased take for this hotkey.
     *
     * # Raises:
     * * 'NotRegistered':
     * - The hotkey we are delegating is not registered on the network.
     *
     * * 'NonAssociatedColdKey':
     * - The hotkey we are delegating is not owned by the calling coldkey.
     *
     * * 'DelegateTakeTooLow':
     * - The delegate is setting a take which is not lower than the previous.
     *
     */
    "decrease_take": Anonymize<Idardmhchnv8aa>;
    /**
     * --- Allows delegates to increase its take value. This call is rate-limited.
     *
     * # Args:
     * * 'origin': (<T as frame_system::Config>::Origin):
     * - The signature of the caller's coldkey.
     *
     * * 'hotkey' (T::AccountId):
     * - The hotkey we are delegating (must be owned by the coldkey.)
     *
     * * 'take' (u16):
     * - The new stake proportion that this hotkey takes from delegations.
     * The new value can be between 0 and 11_796 and should be strictly
     * greater than the previous value. T is the new value (rational number),
     * the the parameter is calculated as [65535 * T]. For example, 1% would be
     * [0.01 * 65535] = [655.35] = 655
     *
     * # Event:
     * * TakeIncreased;
     * - On successfully setting a increased take for this hotkey.
     *
     * # Raises:
     * * 'NotRegistered':
     * - The hotkey we are delegating is not registered on the network.
     *
     * * 'NonAssociatedColdKey':
     * - The hotkey we are delegating is not owned by the calling coldkey.
     *
     * * 'DelegateTakeTooHigh':
     * - The delegate is setting a take which is not greater than the previous.
     *
     */
    "increase_take": Anonymize<Idardmhchnv8aa>;
    /**
     * --- Adds stake to a hotkey. The call is made from a coldkey account.
     * This delegates stake to the hotkey.
     *
     * Note: the coldkey account may own the hotkey, in which case they are
     * delegating to themselves.
     *
     * # Args:
     * * 'origin': (<T as frame_system::Config>Origin):
     * - The signature of the caller's coldkey.
     *
     * * 'hotkey' (T::AccountId):
     * - The associated hotkey account.
     *
     * * 'netuid' (u16):
     * - Subnetwork UID
     *
     * * 'amount_staked' (u64):
     * - The amount of stake to be added to the hotkey staking account.
     *
     * # Event:
     * * StakeAdded;
     * - On the successfully adding stake to a global account.
     *
     * # Raises:
     * * 'NotEnoughBalanceToStake':
     * - Not enough balance on the coldkey to add onto the global account.
     *
     * * 'NonAssociatedColdKey':
     * - The calling coldkey is not associated with this hotkey.
     *
     * * 'BalanceWithdrawalError':
     * - Errors stemming from transaction pallet.
     *
     */
    "add_stake": Anonymize<Icud5m8j0nlgtj>;
    /**
     * Remove stake from the staking account. The call must be made
     * from the coldkey account attached to the neuron metadata. Only this key
     * has permission to make staking and unstaking requests.
     *
     * # Args:
     * * 'origin': (<T as frame_system::Config>Origin):
     * - The signature of the caller's coldkey.
     *
     * * 'hotkey' (T::AccountId):
     * - The associated hotkey account.
     *
     * * 'netuid' (u16):
     * - Subnetwork UID
     *
     * * 'amount_unstaked' (u64):
     * - The amount of stake to be added to the hotkey staking account.
     *
     * # Event:
     * * StakeRemoved;
     * - On the successfully removing stake from the hotkey account.
     *
     * # Raises:
     * * 'NotRegistered':
     * - Thrown if the account we are attempting to unstake from is non existent.
     *
     * * 'NonAssociatedColdKey':
     * - Thrown if the coldkey does not own the hotkey we are unstaking from.
     *
     * * 'NotEnoughStakeToWithdraw':
     * - Thrown if there is not enough stake on the hotkey to withdwraw this amount.
     *
     */
    "remove_stake": Anonymize<I850u7ir5o34um>;
    /**
     * Serves or updates axon /prometheus information for the neuron associated with the caller. If the caller is
     * already registered the metadata is updated. If the caller is not registered this call throws NotRegistered.
     *
     * # Args:
     * * 'origin': (<T as frame_system::Config>Origin):
     * - The signature of the caller.
     *
     * * 'netuid' (u16):
     * - The u16 network identifier.
     *
     * * 'version' (u64):
     * - The bittensor version identifier.
     *
     * * 'ip' (u64):
     * - The endpoint ip information as a u128 encoded integer.
     *
     * * 'port' (u16):
     * - The endpoint port information as a u16 encoded integer.
     *
     * * 'ip_type' (u8):
     * - The endpoint ip version as a u8, 4 or 6.
     *
     * * 'protocol' (u8):
     * - UDP:1 or TCP:0
     *
     * * 'placeholder1' (u8):
     * - Placeholder for further extra params.
     *
     * * 'placeholder2' (u8):
     * - Placeholder for further extra params.
     *
     * # Event:
     * * AxonServed;
     * - On successfully serving the axon info.
     *
     * # Raises:
     * * 'MechanismDoesNotExist':
     * - Attempting to set weights on a non-existent network.
     *
     * * 'NotRegistered':
     * - Attempting to set weights from a non registered account.
     *
     * * 'InvalidIpType':
     * - The ip type is not 4 or 6.
     *
     * * 'InvalidIpAddress':
     * - The numerically encoded ip address does not resolve to a proper ip.
     *
     * * 'ServingRateLimitExceeded':
     * - Attempting to set prometheus information withing the rate limit min.
     *
     */
    "serve_axon": Anonymize<Ica88a899k1afk>;
    /**
     * Same as `serve_axon` but takes a certificate as an extra optional argument.
     * Serves or updates axon /prometheus information for the neuron associated with the caller. If the caller is
     * already registered the metadata is updated. If the caller is not registered this call throws NotRegistered.
     *
     * # Args:
     * * 'origin': (<T as frame_system::Config>Origin):
     * - The signature of the caller.
     *
     * * 'netuid' (u16):
     * - The u16 network identifier.
     *
     * * 'version' (u64):
     * - The bittensor version identifier.
     *
     * * 'ip' (u64):
     * - The endpoint ip information as a u128 encoded integer.
     *
     * * 'port' (u16):
     * - The endpoint port information as a u16 encoded integer.
     *
     * * 'ip_type' (u8):
     * - The endpoint ip version as a u8, 4 or 6.
     *
     * * 'protocol' (u8):
     * - UDP:1 or TCP:0
     *
     * * 'placeholder1' (u8):
     * - Placeholder for further extra params.
     *
     * * 'placeholder2' (u8):
     * - Placeholder for further extra params.
     *
     * * 'certificate' (Vec<u8>):
     * - TLS certificate for inter neuron communitation.
     *
     * # Event:
     * * AxonServed;
     * - On successfully serving the axon info.
     *
     * # Raises:
     * * 'MechanismDoesNotExist':
     * - Attempting to set weights on a non-existent network.
     *
     * * 'NotRegistered':
     * - Attempting to set weights from a non registered account.
     *
     * * 'InvalidIpType':
     * - The ip type is not 4 or 6.
     *
     * * 'InvalidIpAddress':
     * - The numerically encoded ip address does not resolve to a proper ip.
     *
     * * 'ServingRateLimitExceeded':
     * - Attempting to set prometheus information withing the rate limit min.
     *
     */
    "serve_axon_tls": Anonymize<I4tfn6eb3ekqt2>;
    /**
     * ---- Set prometheus information for the neuron.
     * # Args:
     * * 'origin': (<T as frame_system::Config>Origin):
     * - The signature of the calling hotkey.
     *
     * * 'netuid' (u16):
     * - The u16 network identifier.
     *
     * * 'version' (u16):
     * -  The bittensor version identifier.
     *
     * * 'ip' (u128):
     * - The prometheus ip information as a u128 encoded integer.
     *
     * * 'port' (u16):
     * - The prometheus port information as a u16 encoded integer.
     *
     * * 'ip_type' (u8):
     * - The ip type v4 or v6.
     *
     */
    "serve_prometheus": Anonymize<Ia5r6mm7trbg6a>;
    /**
     * ---- Registers a new neuron to the subnetwork.
     *
     * # Args:
     * * 'origin': (<T as frame_system::Config>Origin):
     * - The signature of the calling hotkey.
     *
     * * 'netuid' (u16):
     * - The u16 network identifier.
     *
     * * 'block_number' ( u64 ):
     * - Block hash used to prove work done.
     *
     * * 'nonce' ( u64 ):
     * - Positive integer nonce used in POW.
     *
     * * 'work' ( Vec<u8> ):
     * - Vector encoded bytes representing work done.
     *
     * * 'hotkey' ( T::AccountId ):
     * - Hotkey to be registered to the network.
     *
     * * 'coldkey' ( T::AccountId ):
     * - Associated coldkey account.
     *
     * # Event:
     * * NeuronRegistered;
     * - On successfully registering a uid to a neuron slot on a subnetwork.
     *
     * # Raises:
     * * 'MechanismDoesNotExist':
     * - Attempting to register to a non existent network.
     *
     * * 'TooManyRegistrationsThisBlock':
     * - This registration exceeds the total allowed on this network this block.
     *
     * * 'HotKeyAlreadyRegisteredInSubNet':
     * - The hotkey is already registered on this network.
     *
     * * 'InvalidWorkBlock':
     * - The work has been performed on a stale, future, or non existent block.
     *
     * * 'InvalidDifficulty':
     * - The work does not match the difficulty.
     *
     * * 'InvalidSeal':
     * - The seal is incorrect.
     *
     */
    "register": Anonymize<I27gr0ss2ikvqh>;
    /**
     * Register the hotkey to root network
     */
    "root_register": Anonymize<Ie7hipi75c7vn0>;
    /**
     * User register a new subnetwork via burning token
     */
    "burned_register": Anonymize<I7f38r2vt6r9k1>;
    /**
     * The extrinsic for user to change its hotkey in subnet or all subnets.
     */
    "swap_hotkey": Anonymize<I6b53cjq4m9nsr>;
    /**
     * Performs an arbitrary coldkey swap for any coldkey.
     *
     * Only callable by root as it doesn't require an announcement and can be used to swap any coldkey.
     */
    "swap_coldkey": Anonymize<I216fvnrl9nq6l>;
    /**
     * Sets the childkey take for a given hotkey.
     *
     * This function allows a coldkey to set the childkey take for a given hotkey.
     * The childkey take determines the proportion of stake that the hotkey keeps for itself
     * when distributing stake to its children.
     *
     * # Arguments:
     * * `origin` (<T as frame_system::Config>::RuntimeOrigin):
     * - The signature of the calling coldkey. Setting childkey take can only be done by the coldkey.
     *
     * * `hotkey` (T::AccountId):
     * - The hotkey for which the childkey take will be set.
     *
     * * `take` (u16):
     * - The new childkey take value. This is a percentage represented as a value between 0 and 10000,
     * where 10000 represents 100%.
     *
     * # Events:
     * * `ChildkeyTakeSet`:
     * - On successfully setting the childkey take for a hotkey.
     *
     * # Errors:
     * * `NonAssociatedColdKey`:
     * - The coldkey does not own the hotkey.
     * * `InvalidChildkeyTake`:
     * - The provided take value is invalid (greater than the maximum allowed take).
     * * `TxChildkeyTakeRateLimitExceeded`:
     * - The rate limit for changing childkey take has been exceeded.
     *
     */
    "set_childkey_take": Anonymize<I9n4d52k0luroe>;
    /**
     * Sets the transaction rate limit for changing childkey take.
     *
     * This function can only be called by the root origin.
     *
     * # Arguments:
     * * `origin` - The origin of the call, must be root.
     * * `tx_rate_limit` - The new rate limit in blocks.
     *
     * # Errors:
     * * `BadOrigin` - If the origin is not root.
     *
     */
    "sudo_set_tx_childkey_take_rate_limit": Anonymize<I3gk6eeddm0hsd>;
    /**
     * Sets the minimum allowed childkey take.
     *
     * This function can only be called by the root origin.
     *
     * # Arguments:
     * * `origin` - The origin of the call, must be root.
     * * `take` - The new minimum childkey take value.
     *
     * # Errors:
     * * `BadOrigin` - If the origin is not root.
     *
     */
    "sudo_set_min_childkey_take": Anonymize<I6ue7qc27uhiev>;
    /**
     * Sets the maximum allowed childkey take.
     *
     * This function can only be called by the root origin.
     *
     * # Arguments:
     * * `origin` - The origin of the call, must be root.
     * * `take` - The new maximum childkey take value.
     *
     * # Errors:
     * * `BadOrigin` - If the origin is not root.
     *
     */
    "sudo_set_max_childkey_take": Anonymize<I6ue7qc27uhiev>;
    /**
     * User register a new subnetwork
     */
    "register_network": Anonymize<Ie7hipi75c7vn0>;
    /**
     * Remove a user's subnetwork
     * The caller must be the owner of the network
     */
    "dissolve_network": Anonymize<I30l38oi9ed9dj>;
    /**
     * Set a single child for a given hotkey on a specified network.
     *
     * This function allows a coldkey to set a single child for a given hotkey on a specified network.
     * The proportion of the hotkey's stake to be allocated to the child is also specified.
     *
     * # Arguments:
     * * `origin` (<T as frame_system::Config>::RuntimeOrigin):
     * - The signature of the calling coldkey. Setting a hotkey child can only be done by the coldkey.
     *
     * * `hotkey` (T::AccountId):
     * - The hotkey which will be assigned the child.
     *
     * * `child` (T::AccountId):
     * - The child which will be assigned to the hotkey.
     *
     * * `netuid` (u16):
     * - The u16 network identifier where the childkey will exist.
     *
     * * `proportion` (u64):
     * - Proportion of the hotkey's stake to be given to the child, the value must be u64 normalized.
     *
     * # Events:
     * * `ChildAddedSingular`:
     * - On successfully registering a child to a hotkey.
     *
     * # Errors:
     * * `MechanismDoesNotExist`:
     * - Attempting to register to a non-existent network.
     * * `RegistrationNotPermittedOnRootSubnet`:
     * - Attempting to register a child on the root network.
     * * `NonAssociatedColdKey`:
     * - The coldkey does not own the hotkey or the child is the same as the hotkey.
     * * `HotKeyAccountNotExists`:
     * - The hotkey account does not exist.
     *
     * # Detailed Explanation of Checks:
     * 1. **Signature Verification**: Ensures that the caller has signed the transaction, verifying the coldkey.
     * 2. **Root Network Check**: Ensures that the delegation is not on the root network, as child hotkeys are not valid on the root.
     * 3. **Network Existence Check**: Ensures that the specified network exists.
     * 4. **Ownership Verification**: Ensures that the coldkey owns the hotkey.
     * 5. **Hotkey Account Existence Check**: Ensures that the hotkey account already exists.
     * 6. **Child-Hotkey Distinction**: Ensures that the child is not the same as the hotkey.
     * 7. **Old Children Cleanup**: Removes the hotkey from the parent list of its old children.
     * 8. **New Children Assignment**: Assigns the new child to the hotkey and updates the parent list for the new child.
     */
    "set_children": Anonymize<Ifj9gf4ekq9snm>;
    /**
     * Schedules a coldkey swap operation to be executed at a future block.
     *
     * WARNING: This function is deprecated, please migrate to `announce_coldkey_swap`/`coldkey_swap`
     */
    "schedule_swap_coldkey": Anonymize<If2k69ql8jgivj>;
    /**
     * ---- Set prometheus information for the neuron.
     * # Args:
     * * 'origin': (<T as frame_system::Config>Origin):
     * - The signature of the calling hotkey.
     *
     * * 'netuid' (u16):
     * - The u16 network identifier.
     *
     * * 'version' (u16):
     * -  The bittensor version identifier.
     *
     * * 'ip' (u128):
     * - The prometheus ip information as a u128 encoded integer.
     *
     * * 'port' (u16):
     * - The prometheus port information as a u16 encoded integer.
     *
     * * 'ip_type' (u8):
     * - The ip type v4 or v6.
     *
     */
    "set_identity": Anonymize<Ifjlj958aeheic>;
    /**
     * ---- Set the identity information for a subnet.
     * # Args:
     * * `origin` - (<T as frame_system::Config>::Origin):
     * - The signature of the calling coldkey, which must be the owner of the subnet.
     *
     * * `netuid` (u16):
     * - The unique network identifier of the subnet.
     *
     * * `subnet_name` (Vec<u8>):
     * - The name of the subnet.
     *
     * * `github_repo` (Vec<u8>):
     * - The GitHub repository associated with the subnet identity.
     *
     * * `subnet_contact` (Vec<u8>):
     * - The contact information for the subnet.
     */
    "set_subnet_identity": Anonymize<I4378ieh1uba9u>;
    /**
     * User register a new subnetwork
     */
    "register_network_with_identity": Anonymize<I8e6f7r9dtk9c1>;
    /**
     * ---- The implementation for the extrinsic unstake_all: Removes all stake from a hotkey account across all subnets and adds it onto a coldkey.
     *
     * # Args:
     * * `origin` - (<T as frame_system::Config>::Origin):
     * - The signature of the caller's coldkey.
     *
     * * `hotkey` (T::AccountId):
     * - The associated hotkey account.
     *
     * # Event:
     * * StakeRemoved;
     * - On the successfully removing stake from the hotkey account.
     *
     * # Raises:
     * * `NotRegistered`:
     * - Thrown if the account we are attempting to unstake from is non existent.
     *
     * * `NonAssociatedColdKey`:
     * - Thrown if the coldkey does not own the hotkey we are unstaking from.
     *
     * * `NotEnoughStakeToWithdraw`:
     * - Thrown if there is not enough stake on the hotkey to withdraw this amount.
     *
     * * `TxRateLimitExceeded`:
     * - Thrown if key has hit transaction rate limit
     */
    "unstake_all": Anonymize<Ie7hipi75c7vn0>;
    /**
     * ---- The implementation for the extrinsic unstake_all: Removes all stake from a hotkey account across all subnets and adds it onto a coldkey.
     *
     * # Args:
     * * `origin` - (<T as frame_system::Config>::Origin):
     * - The signature of the caller's coldkey.
     *
     * * `hotkey` (T::AccountId):
     * - The associated hotkey account.
     *
     * # Event:
     * * StakeRemoved;
     * - On the successfully removing stake from the hotkey account.
     *
     * # Raises:
     * * `NotRegistered`:
     * - Thrown if the account we are attempting to unstake from is non existent.
     *
     * * `NonAssociatedColdKey`:
     * - Thrown if the coldkey does not own the hotkey we are unstaking from.
     *
     * * `NotEnoughStakeToWithdraw`:
     * - Thrown if there is not enough stake on the hotkey to withdraw this amount.
     *
     * * `TxRateLimitExceeded`:
     * - Thrown if key has hit transaction rate limit
     */
    "unstake_all_alpha": Anonymize<Ie7hipi75c7vn0>;
    /**
     * ---- The implementation for the extrinsic move_stake: Moves specified amount of stake from a hotkey to another across subnets.
     *
     * # Args:
     * * `origin` - (<T as frame_system::Config>::Origin):
     * - The signature of the caller's coldkey.
     *
     * * `origin_hotkey` (T::AccountId):
     * - The hotkey account to move stake from.
     *
     * * `destination_hotkey` (T::AccountId):
     * - The hotkey account to move stake to.
     *
     * * `origin_netuid` (T::AccountId):
     * - The subnet ID to move stake from.
     *
     * * `destination_netuid` (T::AccountId):
     * - The subnet ID to move stake to.
     *
     * * `alpha_amount` (T::AccountId):
     * - The alpha stake amount to move.
     *
     */
    "move_stake": Anonymize<I9d117ni3tprb>;
    /**
     * Transfers a specified amount of stake from one coldkey to another, optionally across subnets,
     * while keeping the same hotkey.
     *
     * # Arguments
     * * `origin` - The origin of the transaction, which must be signed by the `origin_coldkey`.
     * * `destination_coldkey` - The coldkey to which the stake is transferred.
     * * `hotkey` - The hotkey associated with the stake.
     * * `origin_netuid` - The network/subnet ID to move stake from.
     * * `destination_netuid` - The network/subnet ID to move stake to (for cross-subnet transfer).
     * * `alpha_amount` - The amount of stake to transfer.
     *
     * # Errors
     * Returns an error if:
     * * The origin is not signed by the correct coldkey.
     * * Either subnet does not exist.
     * * The hotkey does not exist.
     * * There is insufficient stake on `(origin_coldkey, hotkey, origin_netuid)`.
     * * The transfer amount is below the minimum stake requirement.
     *
     * # Events
     * May emit a `StakeTransferred` event on success.
     */
    "transfer_stake": Anonymize<I340k0hbj1hc6r>;
    /**
     * Swaps a specified amount of stake from one subnet to another, while keeping the same coldkey and hotkey.
     *
     * # Arguments
     * * `origin` - The origin of the transaction, which must be signed by the coldkey that owns the `hotkey`.
     * * `hotkey` - The hotkey whose stake is being swapped.
     * * `origin_netuid` - The network/subnet ID from which stake is removed.
     * * `destination_netuid` - The network/subnet ID to which stake is added.
     * * `alpha_amount` - The amount of stake to swap.
     *
     * # Errors
     * Returns an error if:
     * * The transaction is not signed by the correct coldkey (i.e., `coldkey_owns_hotkey` fails).
     * * Either `origin_netuid` or `destination_netuid` does not exist.
     * * The hotkey does not exist.
     * * There is insufficient stake on `(coldkey, hotkey, origin_netuid)`.
     * * The swap amount is below the minimum stake requirement.
     *
     * # Events
     * May emit a `StakeSwapped` event on success.
     */
    "swap_stake": Anonymize<Ibapoov2fa817a>;
    /**
     * --- Adds stake to a hotkey on a subnet with a price limit.
     * This extrinsic allows to specify the limit price for alpha token
     * at which or better (lower) the staking should execute.
     *
     * In case if slippage occurs and the price shall move beyond the limit
     * price, the staking order may execute only partially or not execute
     * at all.
     *
     * # Args:
     * * 'origin': (<T as frame_system::Config>Origin):
     * - The signature of the caller's coldkey.
     *
     * * 'hotkey' (T::AccountId):
     * - The associated hotkey account.
     *
     * * 'netuid' (u16):
     * - Subnetwork UID
     *
     * * 'amount_staked' (u64):
     * - The amount of stake to be added to the hotkey staking account.
     *
     * * 'limit_price' (u64):
     * - The limit price expressed in units of RAO per one Alpha.
     *
     * * 'allow_partial' (bool):
     * - Allows partial execution of the amount. If set to false, this becomes
     * fill or kill type or order.
     *
     * # Event:
     * * StakeAdded;
     * - On the successfully adding stake to a global account.
     *
     * # Raises:
     * * 'NotEnoughBalanceToStake':
     * - Not enough balance on the coldkey to add onto the global account.
     *
     * * 'NonAssociatedColdKey':
     * - The calling coldkey is not associated with this hotkey.
     *
     * * 'BalanceWithdrawalError':
     * - Errors stemming from transaction pallet.
     *
     */
    "add_stake_limit": Anonymize<I2eon60c4gde7f>;
    /**
     * --- Removes stake from a hotkey on a subnet with a price limit.
     * This extrinsic allows to specify the limit price for alpha token
     * at which or better (higher) the staking should execute.
     *
     * In case if slippage occurs and the price shall move beyond the limit
     * price, the staking order may execute only partially or not execute
     * at all.
     *
     * # Args:
     * * 'origin': (<T as frame_system::Config>Origin):
     * - The signature of the caller's coldkey.
     *
     * * 'hotkey' (T::AccountId):
     * - The associated hotkey account.
     *
     * * 'netuid' (u16):
     * - Subnetwork UID
     *
     * * 'amount_unstaked' (u64):
     * - The amount of stake to be added to the hotkey staking account.
     *
     * * 'limit_price' (u64):
     * - The limit price expressed in units of RAO per one Alpha.
     *
     * * 'allow_partial' (bool):
     * - Allows partial execution of the amount. If set to false, this becomes
     * fill or kill type or order.
     *
     * # Event:
     * * StakeRemoved;
     * - On the successfully removing stake from the hotkey account.
     *
     * # Raises:
     * * 'NotRegistered':
     * - Thrown if the account we are attempting to unstake from is non existent.
     *
     * * 'NonAssociatedColdKey':
     * - Thrown if the coldkey does not own the hotkey we are unstaking from.
     *
     * * 'NotEnoughStakeToWithdraw':
     * - Thrown if there is not enough stake on the hotkey to withdwraw this amount.
     *
     */
    "remove_stake_limit": Anonymize<I7egr0053sjpci>;
    /**
     * Swaps a specified amount of stake from one subnet to another, while keeping the same coldkey and hotkey.
     *
     * # Arguments
     * * `origin` - The origin of the transaction, which must be signed by the coldkey that owns the `hotkey`.
     * * `hotkey` - The hotkey whose stake is being swapped.
     * * `origin_netuid` - The network/subnet ID from which stake is removed.
     * * `destination_netuid` - The network/subnet ID to which stake is added.
     * * `alpha_amount` - The amount of stake to swap.
     * * `limit_price` - The limit price expressed in units of RAO per one Alpha.
     * * `allow_partial` - Allows partial execution of the amount. If set to false, this becomes fill or kill type or order.
     *
     * # Errors
     * Returns an error if:
     * * The transaction is not signed by the correct coldkey (i.e., `coldkey_owns_hotkey` fails).
     * * Either `origin_netuid` or `destination_netuid` does not exist.
     * * The hotkey does not exist.
     * * There is insufficient stake on `(coldkey, hotkey, origin_netuid)`.
     * * The swap amount is below the minimum stake requirement.
     *
     * # Events
     * May emit a `StakeSwapped` event on success.
     */
    "swap_stake_limit": Anonymize<I6r22p9usi2mkl>;
    /**
     * Attempts to associate a hotkey with a coldkey.
     *
     * # Arguments
     * * `origin` - The origin of the transaction, which must be signed by the coldkey that owns the `hotkey`.
     * * `hotkey` - The hotkey to associate with the coldkey.
     *
     * # Note
     * Will charge based on the weight even if the hotkey is already associated with a coldkey.
     */
    "try_associate_hotkey": Anonymize<Ie7hipi75c7vn0>;
    /**
     * Initiates a call on a subnet.
     *
     * # Arguments
     * * `origin` - The origin of the call, which must be signed by the subnet owner.
     * * `netuid` - The unique identifier of the subnet on which the call is being initiated.
     *
     * # Events
     * Emits a `FirstEmissionBlockNumberSet` event on success.
     */
    "start_call": Anonymize<I6cm4c5a1euio9>;
    /**
     * Attempts to associate a hotkey with an EVM key.
     *
     * The signature will be checked to see if the recovered public key matches the `evm_key` provided.
     *
     * The EVM key is expected to sign the message according to this formula to produce the signature:
     * ```text
     * keccak_256(hotkey ++ keccak_256(block_number))
     * ```
     *
     * # Arguments
     * * `origin` - The origin of the transaction, which must be signed by the `hotkey`.
     * * `netuid` - The netuid that the `hotkey` belongs to.
     * * `evm_key` - The EVM key to associate with the `hotkey`.
     * * `block_number` - The block number used in the `signature`.
     * * `signature` - A signed message by the `evm_key` containing the `hotkey` and the hashed `block_number`.
     *
     * # Errors
     * Returns an error if:
     * * The transaction is not signed.
     * * The hotkey does not belong to the subnet identified by the netuid.
     * * The EVM key cannot be recovered from the signature.
     * * The EVM key recovered from the signature does not match the given EVM key.
     *
     * # Events
     * May emit a `EvmKeyAssociated` event on success
     */
    "associate_evm_key": Anonymize<I96k3nrdjfd63k>;
    /**
     * Recycles alpha from a cold/hot key pair, reducing AlphaOut on a subnet
     *
     * # Arguments
     * * `origin` - The origin of the call (must be signed by the coldkey)
     * * `hotkey` - The hotkey account
     * * `amount` - The amount of alpha to recycle
     * * `netuid` - The subnet ID
     *
     * # Events
     * Emits a `TokensRecycled` event on success.
     */
    "recycle_alpha": Anonymize<Ibg3cp8vjl5u55>;
    /**
     * Burns alpha from a cold/hot key pair without reducing `AlphaOut`
     *
     * # Arguments
     * * `origin` - The origin of the call (must be signed by the coldkey)
     * * `hotkey` - The hotkey account
     * * `amount` - The amount of alpha to burn
     * * `netuid` - The subnet ID
     *
     * # Events
     * Emits a `TokensBurned` event on success.
     */
    "burn_alpha": Anonymize<Ibg3cp8vjl5u55>;
    /**
     * Sets the pending childkey cooldown (in blocks). Root only.
     */
    "set_pending_childkey_cooldown": Anonymize<Ibtu1gfmdnou5k>;
    /**
     * Removes all stake from a hotkey on a subnet with a price limit.
     * This extrinsic allows to specify the limit price for alpha token
     * at which or better (higher) the staking should execute.
     * Without limit_price it remove all the stake similar to `remove_stake` extrinsic
     */
    "remove_stake_full_limit": Anonymize<Iaoomvri5btde>;
    /**
     * Register a new leased network.
     *
     * The crowdloan's contributions are used to compute the share of the emissions that the contributors
     * will receive as dividends.
     *
     * The leftover cap is refunded to the contributors and the beneficiary.
     *
     * # Args:
     * * `origin` - (<T as frame_system::Config>::Origin):
     * - The signature of the caller's coldkey.
     *
     * * `emissions_share` (Percent):
     * - The share of the emissions that the contributors will receive as dividends.
     *
     * * `end_block` (Option<BlockNumberFor<T>>):
     * - The block at which the lease will end. If not defined, the lease is perpetual.
     */
    "register_leased_network": Anonymize<Ic80igo4eds6rq>;
    /**
     * Terminate a lease.
     *
     * The beneficiary can terminate the lease after the end block has passed and get the subnet ownership.
     * The subnet is transferred to the beneficiary and the lease is removed from storage.
     *
     * **The hotkey must be owned by the beneficiary coldkey.**
     *
     * # Args:
     * * `origin` - (<T as frame_system::Config>::Origin):
     * - The signature of the caller's coldkey.
     *
     * * `lease_id` (LeaseId):
     * - The ID of the lease to terminate.
     *
     * * `hotkey` (T::AccountId):
     * - The hotkey of the beneficiary to mark as subnet owner hotkey.
     */
    "terminate_lease": Anonymize<Iflrm8un6aibtn>;
    /**
     * Updates the symbol for a subnet.
     *
     * # Arguments
     * * `origin` - The origin of the call, which must be the subnet owner or root.
     * * `netuid` - The unique identifier of the subnet on which the symbol is being set.
     * * `symbol` - The symbol to set for the subnet.
     *
     * # Errors
     * Returns an error if:
     * * The transaction is not signed by the subnet owner.
     * * The symbol does not exist.
     * * The symbol is already in use by another subnet.
     *
     * # Events
     * Emits a `SymbolUpdated` event on success.
     */
    "update_symbol": Anonymize<I62rrikn5vj0p5>;
    /**
     * ---- Used to commit timelock encrypted commit-reveal weight values to later be revealed.
     *
     * # Args:
     * * `origin`: (`<T as frame_system::Config>::RuntimeOrigin`):
     * - The committing hotkey.
     *
     * * `netuid` (`u16`):
     * - The u16 network identifier.
     *
     * * `commit` (`Vec<u8>`):
     * - The encrypted compressed commit.
     * The steps for this are:
     * 1. Instantiate [`WeightsTlockPayload`]
     * 2. Serialize it using the `parity_scale_codec::Encode` trait
     * 3. Encrypt it following the steps (here)[https://github.com/ideal-lab5/tle/blob/f8e6019f0fb02c380ebfa6b30efb61786dede07b/timelock/src/tlock.rs#L283-L336]
     * to produce a [`TLECiphertext<TinyBLS381>`] type.
     * 4. Serialize and compress using the `ark-serialize` `CanonicalSerialize` trait.
     *
     * * reveal_round (`u64`):
     * - The drand reveal round which will be avaliable during epoch `n+1` from the current
     * epoch.
     *
     * * commit_reveal_version (`u16`):
     * - The client (bittensor-drand) version
     */
    "commit_timelocked_weights": Anonymize<Ietm4rjshhu7sf>;
    /**
     * Set the autostake destination hotkey for a coldkey.
     *
     * The caller selects a hotkey where all future rewards
     * will be automatically staked.
     *
     * # Args:
     * * `origin` - (<T as frame_system::Config>::Origin):
     * - The signature of the caller's coldkey.
     *
     * * `hotkey` (T::AccountId):
     * - The hotkey account to designate as the autostake destination.
     */
    "set_coldkey_auto_stake_hotkey": Anonymize<I7f38r2vt6r9k1>;
    /**
     * ---- Used to commit timelock encrypted commit-reveal weight values to later be revealed for
     * a mechanism.
     *
     * # Args:
     * * `origin`: (`<T as frame_system::Config>::RuntimeOrigin`):
     * - The committing hotkey.
     *
     * * `netuid` (`u16`):
     * - The u16 network identifier.
     *
     * * `mecid` (`u8`):
     * - The u8 mechanism identifier.
     *
     * * `commit` (`Vec<u8>`):
     * - The encrypted compressed commit.
     * The steps for this are:
     * 1. Instantiate [`WeightsTlockPayload`]
     * 2. Serialize it using the `parity_scale_codec::Encode` trait
     * 3. Encrypt it following the steps (here)[https://github.com/ideal-lab5/tle/blob/f8e6019f0fb02c380ebfa6b30efb61786dede07b/timelock/src/tlock.rs#L283-L336]
     * to produce a [`TLECiphertext<TinyBLS381>`] type.
     * 4. Serialize and compress using the `ark-serialize` `CanonicalSerialize` trait.
     *
     * * reveal_round (`u64`):
     * - The drand reveal round which will be avaliable during epoch `n+1` from the current
     * epoch.
     *
     * * commit_reveal_version (`u16`):
     * - The client (bittensor-drand) version
     */
    "commit_timelocked_mechanism_weights": Anonymize<I1v9m3ms1elitm>;
    /**
     * Remove a subnetwork
     * The caller must be root
     */
    "root_dissolve_network": Anonymize<I6cm4c5a1euio9>;
    /**
     * --- Claims the root emissions for a coldkey.
     * # Args:
     * * 'origin': (<T as frame_system::Config>Origin):
     * - The signature of the caller's coldkey.
     *
     * # Event:
     * * RootClaimed;
     * - On the successfully claiming the root emissions for a coldkey.
     *
     * # Raises:
     *
     */
    "claim_root": Anonymize<I2t4b7068rtebl>;
    /**
     * --- Sets the root claim type for the coldkey.
     * # Args:
     * * 'origin': (<T as frame_system::Config>Origin):
     * - The signature of the caller's coldkey.
     *
     * # Event:
     * * RootClaimTypeSet;
     * - On the successfully setting the root claim type for the coldkey.
     *
     */
    "set_root_claim_type": Anonymize<I7a99hd3nbic2l>;
    /**
     * --- Sets root claim number (sudo extrinsic). Zero disables auto-claim.
     */
    "sudo_set_num_root_claims": Anonymize<Ie8hpsm3jhsvo3>;
    /**
     * --- Sets root claim threshold for subnet (sudo or owner origin).
     */
    "sudo_set_root_claim_threshold": Anonymize<Ifcj247vgfdg56>;
    /**
     * Announces a coldkey swap using BlakeTwo256 hash of the new coldkey.
     *
     * This is required before the coldkey swap can be performed
     * after the delay period.
     *
     * It can be reannounced after a delay of `ColdkeySwapReannouncementDelay` following
     * the first valid execution block of the original announcement.
     *
     * The dispatch origin of this call must be the original coldkey that made the announcement.
     *
     * - `new_coldkey_hash`: The hash of the new coldkey using BlakeTwo256.
     *
     * The `ColdkeySwapAnnounced` event is emitted on successful announcement.
     *
     */
    "announce_coldkey_swap": Anonymize<Ic21uicfit5vcu>;
    /**
     * Performs a coldkey swap if an announcement has been made.
     *
     * The dispatch origin of this call must be the original coldkey that made the announcement.
     *
     * - `new_coldkey`: The new coldkey to swap to. The BlakeTwo256 hash of the new coldkey must be
     * the same as the announced coldkey hash.
     *
     * The `ColdkeySwapped` event is emitted on successful swap.
     */
    "swap_coldkey_announced": Anonymize<If2k69ql8jgivj>;
    /**
     * Dispute a coldkey swap.
     *
     * This will prevent any further actions on the coldkey swap
     * until triumvirate step in to resolve the issue.
     *
     * - `coldkey`: The coldkey to dispute the swap for.
     *
     */
    "dispute_coldkey_swap": undefined;
    /**
     * Reset a coldkey swap by clearing the announcement and dispute status.
     *
     * The dispatch origin of this call must be root.
     *
     * - `coldkey`: The coldkey to reset the swap for.
     *
     */
    "reset_coldkey_swap": Anonymize<I375tmdui1ejfc>;
    /**
     * Enables voting power tracking for a subnet.
     *
     * This function can be called by the subnet owner or root.
     * When enabled, voting power EMA is updated every epoch for all validators.
     * Voting power starts at 0 and increases over epochs.
     *
     * # Arguments:
     * * `origin` - The origin of the call, must be subnet owner or root.
     * * `netuid` - The subnet to enable voting power tracking for.
     *
     * # Errors:
     * * `SubnetNotExist` - If the subnet does not exist.
     * * `NotSubnetOwner` - If the caller is not the subnet owner or root.
     */
    "enable_voting_power_tracking": Anonymize<I6cm4c5a1euio9>;
    /**
     * Schedules disabling of voting power tracking for a subnet.
     *
     * This function can be called by the subnet owner or root.
     * Voting power tracking will continue for 14 days (grace period) after this call,
     * then automatically disable and clear all VotingPower entries for the subnet.
     *
     * # Arguments:
     * * `origin` - The origin of the call, must be subnet owner or root.
     * * `netuid` - The subnet to schedule disabling voting power tracking for.
     *
     * # Errors:
     * * `SubnetNotExist` - If the subnet does not exist.
     * * `NotSubnetOwner` - If the caller is not the subnet owner or root.
     * * `VotingPowerTrackingNotEnabled` - If voting power tracking is not enabled.
     */
    "disable_voting_power_tracking": Anonymize<I6cm4c5a1euio9>;
    /**
     * Sets the EMA alpha value for voting power calculation on a subnet.
     *
     * This function can only be called by root (sudo).
     * Higher alpha = faster response to stake changes.
     * Alpha is stored as u64 with 18 decimal precision (1.0 = 10^18).
     *
     * # Arguments:
     * * `origin` - The origin of the call, must be root.
     * * `netuid` - The subnet to set the alpha for.
     * * `alpha` - The new alpha value (u64 with 18 decimal precision).
     *
     * # Errors:
     * * `BadOrigin` - If the origin is not root.
     * * `SubnetNotExist` - If the subnet does not exist.
     * * `InvalidVotingPowerEmaAlpha` - If alpha is greater than 10^18 (1.0).
     */
    "sudo_set_voting_power_ema_alpha": Anonymize<I4guv8rii4s6je>;
    /**
     * --- The extrinsic is a combination of add_stake(add_stake_limit) and burn_alpha. We buy
     * alpha token first and immediately burn the acquired amount of alpha (aka Subnet buyback).
     */
    "add_stake_burn": Anonymize<I2t2h3sjr2mdj0>;
}>;
export type Icv6ofu4lqekr4 = {
    "netuid": number;
    "dests": Anonymize<Icgljjb6j82uhn>;
    "weights": Anonymize<Icgljjb6j82uhn>;
    "version_key": bigint;
};
export type I48embv0n659kj = {
    "netuid": number;
    "mecid": number;
    "dests": Anonymize<Icgljjb6j82uhn>;
    "weights": Anonymize<Icgljjb6j82uhn>;
    "version_key": bigint;
};
export type I8l6dbd18t5aja = {
    "netuids": Anonymize<Icgljjb6j82uhn>;
    "weights": Array<Anonymize<I95g6i7ilua7lq>>;
    "version_keys": Anonymize<Iafqnechp3omqg>;
};
export type I513du23unvan = {
    "netuid": number;
    "commit_hash": FixedSizeBinary<32>;
};
export type I36o6oho99gjm8 = {
    "netuid": number;
    "mecid": number;
    "commit_hash": FixedSizeBinary<32>;
};
export type If3mvus4cmnb7l = {
    "netuids": Anonymize<Icgljjb6j82uhn>;
    "commit_hashes": Anonymize<Ic5m5lp1oioo8r>;
};
export type I3qrhi1ua10nnf = {
    "netuid": number;
    "uids": Anonymize<Icgljjb6j82uhn>;
    "values": Anonymize<Icgljjb6j82uhn>;
    "salt": Anonymize<Icgljjb6j82uhn>;
    "version_key": bigint;
};
export type I2hpc4ev2drsf2 = {
    "netuid": number;
    "mecid": number;
    "uids": Anonymize<Icgljjb6j82uhn>;
    "values": Anonymize<Icgljjb6j82uhn>;
    "salt": Anonymize<Icgljjb6j82uhn>;
    "version_key": bigint;
};
export type I73q6qh9ckhm04 = {
    "netuid": number;
    "mecid": number;
    "commit": Binary;
    "reveal_round": bigint;
};
export type Idia8cmqvul6et = {
    "netuid": number;
    "uids_list": Array<Anonymize<Icgljjb6j82uhn>>;
    "values_list": Array<Anonymize<Icgljjb6j82uhn>>;
    "salts_list": Array<Anonymize<Icgljjb6j82uhn>>;
    "version_keys": Anonymize<Iafqnechp3omqg>;
};
export type Idardmhchnv8aa = {
    "hotkey": SS58String;
    "take": number;
};
export type Icud5m8j0nlgtj = {
    "hotkey": SS58String;
    "netuid": number;
    "amount_staked": bigint;
};
export type I850u7ir5o34um = {
    "hotkey": SS58String;
    "netuid": number;
    "amount_unstaked": bigint;
};
export type Ica88a899k1afk = {
    "netuid": number;
    "version": number;
    "ip": bigint;
    "port": number;
    "ip_type": number;
    "protocol": number;
    "placeholder1": number;
    "placeholder2": number;
};
export type I4tfn6eb3ekqt2 = {
    "netuid": number;
    "version": number;
    "ip": bigint;
    "port": number;
    "ip_type": number;
    "protocol": number;
    "placeholder1": number;
    "placeholder2": number;
    "certificate": Binary;
};
export type Ia5r6mm7trbg6a = {
    "netuid": number;
    "version": number;
    "ip": bigint;
    "port": number;
    "ip_type": number;
};
export type I27gr0ss2ikvqh = {
    "netuid": number;
    "block_number": bigint;
    "nonce": bigint;
    "work": Binary;
    "hotkey": SS58String;
    "coldkey": SS58String;
};
export type Ie7hipi75c7vn0 = {
    "hotkey": SS58String;
};
export type I7f38r2vt6r9k1 = {
    "netuid": number;
    "hotkey": SS58String;
};
export type I6b53cjq4m9nsr = {
    "hotkey": SS58String;
    "new_hotkey": SS58String;
    "netuid"?: Anonymize<I4arjljr6dpflb>;
};
export type I216fvnrl9nq6l = {
    "old_coldkey": SS58String;
    "new_coldkey": SS58String;
    "swap_cost": bigint;
};
export type I9n4d52k0luroe = {
    "hotkey": SS58String;
    "netuid": number;
    "take": number;
};
export type I3gk6eeddm0hsd = {
    "tx_rate_limit": bigint;
};
export type I6ue7qc27uhiev = {
    "take": number;
};
export type I30l38oi9ed9dj = {
    "coldkey": SS58String;
    "netuid": number;
};
export type Ifj9gf4ekq9snm = {
    "hotkey": SS58String;
    "netuid": number;
    "children": Anonymize<I5n8gpu725k1nu>;
};
export type If2k69ql8jgivj = {
    "new_coldkey": SS58String;
};
export type I4378ieh1uba9u = {
    "netuid": number;
    "subnet_name": Binary;
    "github_repo": Binary;
    "subnet_contact": Binary;
    "subnet_url": Binary;
    "discord": Binary;
    "description": Binary;
    "logo_url": Binary;
    "additional": Binary;
};
export type I8e6f7r9dtk9c1 = {
    "hotkey": SS58String;
    "identity"?: Anonymize<I3m38saj8mvtpv>;
};
export type I3m38saj8mvtpv = (Anonymize<I4tc54pa558g5n>) | undefined;
export type I9d117ni3tprb = {
    "origin_hotkey": SS58String;
    "destination_hotkey": SS58String;
    "origin_netuid": number;
    "destination_netuid": number;
    "alpha_amount": bigint;
};
export type I340k0hbj1hc6r = {
    "destination_coldkey": SS58String;
    "hotkey": SS58String;
    "origin_netuid": number;
    "destination_netuid": number;
    "alpha_amount": bigint;
};
export type Ibapoov2fa817a = {
    "hotkey": SS58String;
    "origin_netuid": number;
    "destination_netuid": number;
    "alpha_amount": bigint;
};
export type I2eon60c4gde7f = {
    "hotkey": SS58String;
    "netuid": number;
    "amount_staked": bigint;
    "limit_price": bigint;
    "allow_partial": boolean;
};
export type I7egr0053sjpci = {
    "hotkey": SS58String;
    "netuid": number;
    "amount_unstaked": bigint;
    "limit_price": bigint;
    "allow_partial": boolean;
};
export type I6r22p9usi2mkl = {
    "hotkey": SS58String;
    "origin_netuid": number;
    "destination_netuid": number;
    "alpha_amount": bigint;
    "limit_price": bigint;
    "allow_partial": boolean;
};
export type I96k3nrdjfd63k = {
    "netuid": number;
    "evm_key": FixedSizeBinary<20>;
    "block_number": bigint;
    "signature": FixedSizeBinary<65>;
};
export type Ibg3cp8vjl5u55 = {
    "hotkey": SS58String;
    "amount": bigint;
    "netuid": number;
};
export type Ibtu1gfmdnou5k = {
    "cooldown": bigint;
};
export type Iaoomvri5btde = {
    "hotkey": SS58String;
    "netuid": number;
    "limit_price"?: Anonymize<I35p85j063s0il>;
};
export type Ic80igo4eds6rq = {
    "emissions_share": number;
    "end_block"?: Anonymize<I4arjljr6dpflb>;
};
export type Iflrm8un6aibtn = {
    "lease_id": number;
    "hotkey": SS58String;
};
export type Ietm4rjshhu7sf = {
    "netuid": number;
    "commit": Binary;
    "reveal_round": bigint;
    "commit_reveal_version": number;
};
export type I1v9m3ms1elitm = {
    "netuid": number;
    "mecid": number;
    "commit": Binary;
    "reveal_round": bigint;
    "commit_reveal_version": number;
};
export type I7a99hd3nbic2l = {
    "new_root_claim_type": Anonymize<Iapm6e7vtp0l6r>;
};
export type Ie8hpsm3jhsvo3 = {
    "new_value": bigint;
};
export type Ifcj247vgfdg56 = {
    "netuid": number;
    "new_value": bigint;
};
export type Ic21uicfit5vcu = {
    "new_coldkey_hash": FixedSizeBinary<32>;
};
export type I2t2h3sjr2mdj0 = {
    "hotkey": SS58String;
    "netuid": number;
    "amount": bigint;
    "limit"?: Anonymize<I35p85j063s0il>;
};
export type I3g440un09hrpf = AnonymousEnum<{
    /**
     * Send a batch of dispatch calls.
     *
     * May be called from any origin except `None`.
     *
     * - `calls`: The calls to be dispatched from the same origin. The number of call must not
     * exceed the constant: `batched_calls_limit` (available in constant metadata).
     *
     * If origin is root then the calls are dispatched without checking origin filter. (This
     * includes bypassing `frame_system::Config::BaseCallFilter`).
     *
     * ## Complexity
     * - O(C) where C is the number of calls to be batched.
     *
     * This will return `Ok` in all circumstances. To determine the success of the batch, an
     * event is deposited. If a call failed and the batch was interrupted, then the
     * `BatchInterrupted` event is deposited, along with the number of successful calls made
     * and the error of the failed call. If all were successful, then the `BatchCompleted`
     * event is deposited.
     */
    "batch": Anonymize<I8dv6qj04g67f6>;
    /**
     * Send a call through an indexed pseudonym of the sender.
     *
     * Filter from origin are passed along. The call will be dispatched with an origin which
     * use the same filter as the origin of this call.
     *
     * NOTE: If you need to ensure that any account-based filtering is not honored (i.e.
     * because you expect `proxy` to have been used prior in the call stack and you do not want
     * the call restrictions to apply to any sub-accounts), then use `as_multi_threshold_1`
     * in the Multisig pallet instead.
     *
     * NOTE: Prior to version *12, this was called `as_limited_sub`.
     *
     * The dispatch origin for this call must be _Signed_.
     */
    "as_derivative": Anonymize<Idrqhfmcqj6s9k>;
    /**
     * Send a batch of dispatch calls and atomically execute them.
     * The whole transaction will rollback and fail if any of the calls failed.
     *
     * May be called from any origin except `None`.
     *
     * - `calls`: The calls to be dispatched from the same origin. The number of call must not
     * exceed the constant: `batched_calls_limit` (available in constant metadata).
     *
     * If origin is root then the calls are dispatched without checking origin filter. (This
     * includes bypassing `frame_system::Config::BaseCallFilter`).
     *
     * ## Complexity
     * - O(C) where C is the number of calls to be batched.
     */
    "batch_all": Anonymize<I8dv6qj04g67f6>;
    /**
     * Dispatches a function call with a provided origin.
     *
     * The dispatch origin for this call must be _Root_.
     *
     * ## Complexity
     * - O(1).
     */
    "dispatch_as": Anonymize<I4o3j3biuetmn6>;
    /**
     * Send a batch of dispatch calls.
     * Unlike `batch`, it allows errors and won't interrupt.
     *
     * May be called from any origin except `None`.
     *
     * - `calls`: The calls to be dispatched from the same origin. The number of call must not
     * exceed the constant: `batched_calls_limit` (available in constant metadata).
     *
     * If origin is root then the calls are dispatch without checking origin filter. (This
     * includes bypassing `frame_system::Config::BaseCallFilter`).
     *
     * ## Complexity
     * - O(C) where C is the number of calls to be batched.
     */
    "force_batch": Anonymize<I8dv6qj04g67f6>;
    /**
     * Dispatch a function call with a specified weight.
     *
     * This function does not check the weight of the call, and instead allows the
     * Root origin to specify the weight of the call.
     *
     * The dispatch origin for this call must be _Root_.
     */
    "with_weight": Anonymize<I77jh18qf00h3j>;
    /**
     * Dispatch a fallback call in the event the main call fails to execute.
     * May be called from any origin except `None`.
     *
     * This function first attempts to dispatch the `main` call.
     * If the `main` call fails, the `fallback` is attemted.
     * if the fallback is successfully dispatched, the weights of both calls
     * are accumulated and an event containing the main call error is deposited.
     *
     * In the event of a fallback failure the whole call fails
     * with the weights returned.
     *
     * - `main`: The main call to be dispatched. This is the primary action to execute.
     * - `fallback`: The fallback call to be dispatched in case the `main` call fails.
     *
     * ## Dispatch Logic
     * - If the origin is `root`, both the main and fallback calls are executed without
     * applying any origin filters.
     * - If the origin is not `root`, the origin filter is applied to both the `main` and
     * `fallback` calls.
     *
     * ## Use Case
     * - Some use cases might involve submitting a `batch` type call in either main, fallback
     * or both.
     */
    "if_else": Anonymize<Idtnqq2a4jl0f4>;
    /**
     * Dispatches a function call with a provided origin.
     *
     * Almost the same as [`Pallet::dispatch_as`] but forwards any error of the inner call.
     *
     * The dispatch origin for this call must be _Root_.
     */
    "dispatch_as_fallible": Anonymize<I4o3j3biuetmn6>;
}>;
export type I8dv6qj04g67f6 = {
    "calls": Array<TxCallData>;
};
export type Idrqhfmcqj6s9k = {
    "index": number;
    "call": TxCallData;
};
export type I4o3j3biuetmn6 = {
    "as_origin": Anonymize<I32es0rp64745v>;
    "call": TxCallData;
};
export type I77jh18qf00h3j = {
    "call": TxCallData;
    "weight": Anonymize<I4q39t5hn830vp>;
};
export type Idtnqq2a4jl0f4 = {
    "main": TxCallData;
    "fallback": TxCallData;
};
export type I5o7g6ruskmlii = AnonymousEnum<{
    /**
     * Authenticates the sudo key and dispatches a function call with `Root` origin.
     */
    "sudo": Anonymize<I1kq857mo69eu7>;
    /**
     * Authenticates the sudo key and dispatches a function call with `Root` origin.
     * This function does not check the weight of the call, and instead allows the
     * Sudo user to specify the weight of the call.
     *
     * The dispatch origin for this call must be _Signed_.
     */
    "sudo_unchecked_weight": Anonymize<I77jh18qf00h3j>;
    /**
     * Authenticates the current sudo key and sets the given AccountId (`new`) as the new sudo
     * key.
     */
    "set_key": Anonymize<I8k3rnvpeeh4hv>;
    /**
     * Authenticates the sudo key and dispatches a function call with `Signed` origin from
     * a given account.
     *
     * The dispatch origin for this call must be _Signed_.
     */
    "sudo_as": Anonymize<Icoe7opmtd7qe1>;
    /**
     * Permanently removes the sudo key.
     *
     * **This cannot be un-done.**
     */
    "remove_key": undefined;
}>;
export type I1kq857mo69eu7 = {
    "call": TxCallData;
};
export type I8k3rnvpeeh4hv = {
    "new": MultiAddress;
};
export type Icoe7opmtd7qe1 = {
    "who": MultiAddress;
    "call": TxCallData;
};
export type I52kfmvokp9f61 = AnonymousEnum<{
    /**
     * Immediately dispatch a multi-signature call using a single approval from the caller.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * - `other_signatories`: The accounts (other than the sender) who are part of the
     * multi-signature, but do not participate in the approval process.
     * - `call`: The call to be executed.
     *
     * Result is equivalent to the dispatched result.
     *
     * ## Complexity
     * O(Z + C) where Z is the length of the call and C its execution weight.
     */
    "as_multi_threshold_1": Anonymize<I3rt0lr178u9f2>;
    /**
     * Register approval for a dispatch to be made from a deterministic composite account if
     * approved by a total of `threshold - 1` of `other_signatories`.
     *
     * If there are enough, then dispatch the call.
     *
     * Payment: `DepositBase` will be reserved if this is the first approval, plus
     * `threshold` times `DepositFactor`. It is returned once this dispatch happens or
     * is cancelled.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * - `threshold`: The total number of approvals for this dispatch before it is executed.
     * - `other_signatories`: The accounts (other than the sender) who can approve this
     * dispatch. May not be empty.
     * - `maybe_timepoint`: If this is the first approval, then this must be `None`. If it is
     * not the first approval, then it must be `Some`, with the timepoint (block number and
     * transaction index) of the first approval transaction.
     * - `call`: The call to be executed.
     *
     * NOTE: Unless this is the final approval, you will generally want to use
     * `approve_as_multi` instead, since it only requires a hash of the call.
     *
     * Result is equivalent to the dispatched result if `threshold` is exactly `1`. Otherwise
     * on success, result is `Ok` and the result from the interior call, if it was executed,
     * may be found in the deposited `MultisigExecuted` event.
     *
     * ## Complexity
     * - `O(S + Z + Call)`.
     * - Up to one balance-reserve or unreserve operation.
     * - One passthrough operation, one insert, both `O(S)` where `S` is the number of
     * signatories. `S` is capped by `MaxSignatories`, with weight being proportional.
     * - One call encode & hash, both of complexity `O(Z)` where `Z` is tx-len.
     * - One encode & hash, both of complexity `O(S)`.
     * - Up to one binary search and insert (`O(logS + S)`).
     * - I/O: 1 read `O(S)`, up to 1 mutate `O(S)`. Up to one remove.
     * - One event.
     * - The weight of the `call`.
     * - Storage: inserts one item, value size bounded by `MaxSignatories`, with a deposit
     * taken for its lifetime of `DepositBase + threshold * DepositFactor`.
     */
    "as_multi": Anonymize<I83718vol4v4pm>;
    /**
     * Register approval for a dispatch to be made from a deterministic composite account if
     * approved by a total of `threshold - 1` of `other_signatories`.
     *
     * Payment: `DepositBase` will be reserved if this is the first approval, plus
     * `threshold` times `DepositFactor`. It is returned once this dispatch happens or
     * is cancelled.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * - `threshold`: The total number of approvals for this dispatch before it is executed.
     * - `other_signatories`: The accounts (other than the sender) who can approve this
     * dispatch. May not be empty.
     * - `maybe_timepoint`: If this is the first approval, then this must be `None`. If it is
     * not the first approval, then it must be `Some`, with the timepoint (block number and
     * transaction index) of the first approval transaction.
     * - `call_hash`: The hash of the call to be executed.
     *
     * NOTE: If this is the final approval, you will want to use `as_multi` instead.
     *
     * ## Complexity
     * - `O(S)`.
     * - Up to one balance-reserve or unreserve operation.
     * - One passthrough operation, one insert, both `O(S)` where `S` is the number of
     * signatories. `S` is capped by `MaxSignatories`, with weight being proportional.
     * - One encode & hash, both of complexity `O(S)`.
     * - Up to one binary search and insert (`O(logS + S)`).
     * - I/O: 1 read `O(S)`, up to 1 mutate `O(S)`. Up to one remove.
     * - One event.
     * - Storage: inserts one item, value size bounded by `MaxSignatories`, with a deposit
     * taken for its lifetime of `DepositBase + threshold * DepositFactor`.
     */
    "approve_as_multi": Anonymize<Ideaemvoneh309>;
    /**
     * Cancel a pre-existing, on-going multisig transaction. Any deposit reserved previously
     * for this operation will be unreserved on success.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * - `threshold`: The total number of approvals for this dispatch before it is executed.
     * - `other_signatories`: The accounts (other than the sender) who can approve this
     * dispatch. May not be empty.
     * - `timepoint`: The timepoint (block number and transaction index) of the first approval
     * transaction for this dispatch.
     * - `call_hash`: The hash of the call to be executed.
     *
     * ## Complexity
     * - `O(S)`.
     * - Up to one balance-reserve or unreserve operation.
     * - One passthrough operation, one insert, both `O(S)` where `S` is the number of
     * signatories. `S` is capped by `MaxSignatories`, with weight being proportional.
     * - One encode & hash, both of complexity `O(S)`.
     * - One event.
     * - I/O: 1 read `O(S)`, one remove.
     * - Storage: removes one item.
     */
    "cancel_as_multi": Anonymize<I3d9o9d7epp66v>;
    /**
     * Poke the deposit reserved for an existing multisig operation.
     *
     * The dispatch origin for this call must be _Signed_ and must be the original depositor of
     * the multisig operation.
     *
     * The transaction fee is waived if the deposit amount has changed.
     *
     * - `threshold`: The total number of approvals needed for this multisig.
     * - `other_signatories`: The accounts (other than the sender) who are part of the
     * multisig.
     * - `call_hash`: The hash of the call this deposit is reserved for.
     *
     * Emits `DepositPoked` if successful.
     */
    "poke_deposit": Anonymize<I6lqh1vgb4mcja>;
}>;
export type I3rt0lr178u9f2 = {
    "other_signatories": Anonymize<Ia2lhg7l2hilo3>;
    "call": TxCallData;
};
export type I83718vol4v4pm = {
    "threshold": number;
    "other_signatories": Anonymize<Ia2lhg7l2hilo3>;
    "maybe_timepoint"?: Anonymize<I95jfd8j5cr5eh>;
    "call": TxCallData;
    "max_weight": Anonymize<I4q39t5hn830vp>;
};
export type I95jfd8j5cr5eh = (Anonymize<Itvprrpb0nm3o>) | undefined;
export type Ideaemvoneh309 = {
    "threshold": number;
    "other_signatories": Anonymize<Ia2lhg7l2hilo3>;
    "maybe_timepoint"?: Anonymize<I95jfd8j5cr5eh>;
    "call_hash": FixedSizeBinary<32>;
    "max_weight": Anonymize<I4q39t5hn830vp>;
};
export type I3d9o9d7epp66v = {
    "threshold": number;
    "other_signatories": Anonymize<Ia2lhg7l2hilo3>;
    "timepoint": Anonymize<Itvprrpb0nm3o>;
    "call_hash": FixedSizeBinary<32>;
};
export type I6lqh1vgb4mcja = {
    "threshold": number;
    "other_signatories": Anonymize<Ia2lhg7l2hilo3>;
    "call_hash": FixedSizeBinary<32>;
};
export type If81ks88t5mpk5 = AnonymousEnum<{
    /**
     * Register a preimage on-chain.
     *
     * If the preimage was previously requested, no fees or deposits are taken for providing
     * the preimage. Otherwise, a deposit is taken proportional to the size of the preimage.
     */
    "note_preimage": Anonymize<I82nfqfkd48n10>;
    /**
     * Clear an unrequested preimage from the runtime storage.
     *
     * If `len` is provided, then it will be a much cheaper operation.
     *
     * - `hash`: The hash of the preimage to be removed from the store.
     * - `len`: The length of the preimage of `hash`.
     */
    "unnote_preimage": Anonymize<I1jm8m1rh9e20v>;
    /**
     * Request a preimage be uploaded to the chain without paying any fees or deposits.
     *
     * If the preimage requests has already been provided on-chain, we unreserve any deposit
     * a user may have paid, and take the control of the preimage out of their hands.
     */
    "request_preimage": Anonymize<I1jm8m1rh9e20v>;
    /**
     * Clear a previously made request for a preimage.
     *
     * NOTE: THIS MUST NOT BE CALLED ON `hash` MORE TIMES THAN `request_preimage`.
     */
    "unrequest_preimage": Anonymize<I1jm8m1rh9e20v>;
    /**
     * Ensure that the bulk of pre-images is upgraded.
     *
     * The caller pays no fee if at least 90% of pre-images were successfully updated.
     */
    "ensure_updated": Anonymize<I3o5j3bli1pd8e>;
}>;
export type I82nfqfkd48n10 = {
    "bytes": Binary;
};
export type I3o5j3bli1pd8e = {
    "hashes": Anonymize<Ic5m5lp1oioo8r>;
};
export type I4nm6fqi0gsbdn = AnonymousEnum<{
    /**
     * Anonymously schedule a task.
     */
    "schedule": Anonymize<I12j3closeroc0>;
    /**
     * Cancel an anonymously scheduled task.
     */
    "cancel": Anonymize<I5n4sebgkfr760>;
    /**
     * Schedule a named task.
     */
    "schedule_named": Anonymize<Ieg42qkecnn5c3>;
    /**
     * Cancel a named scheduled task.
     */
    "cancel_named": Anonymize<Ifs1i5fk9cqvr6>;
    /**
     * Anonymously schedule a task after a delay.
     */
    "schedule_after": Anonymize<I21v9poe6i1enr>;
    /**
     * Schedule a named task after a delay.
     */
    "schedule_named_after": Anonymize<Id66b1tvo5iht7>;
    /**
     * Set a retry configuration for a task so that, in case its scheduled run fails, it will
     * be retried after `period` blocks, for a total amount of `retries` retries or until it
     * succeeds.
     *
     * Tasks which need to be scheduled for a retry are still subject to weight metering and
     * agenda space, same as a regular task. If a periodic task fails, it will be scheduled
     * normally while the task is retrying.
     *
     * Tasks scheduled as a result of a retry for a periodic task are unnamed, non-periodic
     * clones of the original task. Their retry configuration will be derived from the
     * original task's configuration, but will have a lower value for `remaining` than the
     * original `total_retries`.
     */
    "set_retry": Anonymize<Ieg3fd8p4pkt10>;
    /**
     * Set a retry configuration for a named task so that, in case its scheduled run fails, it
     * will be retried after `period` blocks, for a total amount of `retries` retries or until
     * it succeeds.
     *
     * Tasks which need to be scheduled for a retry are still subject to weight metering and
     * agenda space, same as a regular task. If a periodic task fails, it will be scheduled
     * normally while the task is retrying.
     *
     * Tasks scheduled as a result of a retry for a periodic task are unnamed, non-periodic
     * clones of the original task. Their retry configuration will be derived from the
     * original task's configuration, but will have a lower value for `remaining` than the
     * original `total_retries`.
     */
    "set_retry_named": Anonymize<I8kg5ll427kfqq>;
    /**
     * Removes the retry configuration of a task.
     */
    "cancel_retry": Anonymize<I467333262q1l9>;
    /**
     * Cancel the retry configuration of a named task.
     */
    "cancel_retry_named": Anonymize<Ifs1i5fk9cqvr6>;
}>;
export type I12j3closeroc0 = {
    "when": number;
    "maybe_periodic"?: Anonymize<Iep7au1720bm0e>;
    "priority": number;
    "call": TxCallData;
};
export type Ieg42qkecnn5c3 = {
    "id": FixedSizeBinary<32>;
    "when": number;
    "maybe_periodic"?: Anonymize<Iep7au1720bm0e>;
    "priority": number;
    "call": TxCallData;
};
export type Ifs1i5fk9cqvr6 = {
    "id": FixedSizeBinary<32>;
};
export type I21v9poe6i1enr = {
    "after": number;
    "maybe_periodic"?: Anonymize<Iep7au1720bm0e>;
    "priority": number;
    "call": TxCallData;
};
export type Id66b1tvo5iht7 = {
    "id": FixedSizeBinary<32>;
    "after": number;
    "maybe_periodic"?: Anonymize<Iep7au1720bm0e>;
    "priority": number;
    "call": TxCallData;
};
export type Ieg3fd8p4pkt10 = {
    "task": Anonymize<I9jd27rnpm8ttv>;
    "retries": number;
    "period": number;
};
export type I8kg5ll427kfqq = {
    "id": FixedSizeBinary<32>;
    "retries": number;
    "period": number;
};
export type I467333262q1l9 = {
    "task": Anonymize<I9jd27rnpm8ttv>;
};
export type Idpgc64kel5m98 = AnonymousEnum<{
    /**
     * Dispatch the given `call` from an account that the sender is authorised for through
     * `add_proxy`.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `real`: The account that the proxy will make a call on behalf of.
     * - `force_proxy_type`: Specify the exact proxy type to be used and checked for this call.
     * - `call`: The call to be made by the `real` account.
     */
    "proxy": Anonymize<I42l0e1oijb6bn>;
    /**
     * Register a proxy account for the sender that is able to make calls on its behalf.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `proxy`: The account that the `caller` would like to make a proxy.
     * - `proxy_type`: The permissions allowed for this proxy account.
     * - `delay`: The announcement period required of the initial proxy. Will generally be
     * zero.
     */
    "add_proxy": Anonymize<It11trpppbc3l>;
    /**
     * Unregister a proxy account for the sender.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `proxy`: The account that the `caller` would like to remove as a proxy.
     * - `proxy_type`: The permissions currently enabled for the removed proxy account.
     */
    "remove_proxy": Anonymize<It11trpppbc3l>;
    /**
     * Unregister all proxy accounts for the sender.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * WARNING: This may be called on accounts created by `create_pure`, however if done, then
     * the unreserved fees will be inaccessible. **All access to this account will be lost.**
     */
    "remove_proxies": undefined;
    /**
     * Spawn a fresh new account that is guaranteed to be otherwise inaccessible, and
     * initialize it with a proxy of `proxy_type` for `origin` sender.
     *
     * Requires a `Signed` origin.
     *
     * - `proxy_type`: The type of the proxy that the sender will be registered as over the
     * new account. This will almost always be the most permissive `ProxyType` possible to
     * allow for maximum flexibility.
     * - `index`: A disambiguation index, in case this is called multiple times in the same
     * transaction (e.g. with `utility::batch`). Unless you're using `batch` you probably just
     * want to use `0`.
     * - `delay`: The announcement period required of the initial proxy. Will generally be
     * zero.
     *
     * Fails with `Duplicate` if this has already been called in this transaction, from the
     * same sender, with the same parameters.
     *
     * Fails if there are insufficient funds to pay for deposit.
     */
    "create_pure": Anonymize<Ietml13sclqs1q>;
    /**
     * Removes a previously spawned pure proxy.
     *
     * WARNING: **All access to this account will be lost.** Any funds held in it will be
     * inaccessible.
     *
     * Requires a `Signed` origin, and the sender account must have been created by a call to
     * `create_pure` with corresponding parameters.
     *
     * - `spawner`: The account that originally called `create_pure` to create this account.
     * - `index`: The disambiguation index originally passed to `create_pure`. Probably `0`.
     * - `proxy_type`: The proxy type originally passed to `create_pure`.
     * - `height`: The height of the chain when the call to `create_pure` was processed.
     * - `ext_index`: The extrinsic index in which the call to `create_pure` was processed.
     *
     * Fails with `NoPermission` in case the caller is not a previously created pure
     * account whose `create_pure` call has corresponding parameters.
     */
    "kill_pure": Anonymize<Iftfic7p3uban2>;
    /**
     * Publish the hash of a proxy-call that will be made in the future.
     *
     * This must be called some number of blocks before the corresponding `proxy` is attempted
     * if the delay associated with the proxy relationship is greater than zero.
     *
     * No more than `MaxPending` announcements may be made at any one time.
     *
     * This will take a deposit of `AnnouncementDepositFactor` as well as
     * `AnnouncementDepositBase` if there are no other pending announcements.
     *
     * The dispatch origin for this call must be _Signed_ and a proxy of `real`.
     *
     * Parameters:
     * - `real`: The account that the proxy will make a call on behalf of.
     * - `call_hash`: The hash of the call to be made by the `real` account.
     */
    "announce": Anonymize<I2eb501t8s6hsq>;
    /**
     * Remove a given announcement.
     *
     * May be called by a proxy account to remove a call they previously announced and return
     * the deposit.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `real`: The account that the proxy will make a call on behalf of.
     * - `call_hash`: The hash of the call to be made by the `real` account.
     */
    "remove_announcement": Anonymize<I2eb501t8s6hsq>;
    /**
     * Remove the given announcement of a delegate.
     *
     * May be called by a target (proxied) account to remove a call that one of their delegates
     * (`delegate`) has announced they want to execute. The deposit is returned.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `delegate`: The account that previously announced the call.
     * - `call_hash`: The hash of the call to be made.
     */
    "reject_announcement": Anonymize<Ianmuoljk2sk1u>;
    /**
     * Dispatch the given `call` from an account that the sender is authorized for through
     * `add_proxy`.
     *
     * Removes any corresponding announcement(s).
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `real`: The account that the proxy will make a call on behalf of.
     * - `force_proxy_type`: Specify the exact proxy type to be used and checked for this call.
     * - `call`: The call to be made by the `real` account.
     */
    "proxy_announced": Anonymize<I8o7hg9oj4hscp>;
    /**
     * Poke / Adjust deposits made for proxies and announcements based on current values.
     * This can be used by accounts to possibly lower their locked amount.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * The transaction fee is waived if the deposit amount has changed.
     *
     * Emits `DepositPoked` if successful.
     */
    "poke_deposit": undefined;
}>;
export type I42l0e1oijb6bn = {
    "real": MultiAddress;
    "force_proxy_type"?: Anonymize<Iccd9gbcgdpjso>;
    "call": TxCallData;
};
export type Iccd9gbcgdpjso = (Anonymize<I8v1041j74kmaj>) | undefined;
export type It11trpppbc3l = {
    "delegate": MultiAddress;
    "proxy_type": Anonymize<I8v1041j74kmaj>;
    "delay": number;
};
export type Ietml13sclqs1q = {
    "proxy_type": Anonymize<I8v1041j74kmaj>;
    "delay": number;
    "index": number;
};
export type Iftfic7p3uban2 = {
    "spawner": MultiAddress;
    "proxy_type": Anonymize<I8v1041j74kmaj>;
    "index": number;
    "height": number;
    "ext_index": number;
};
export type I2eb501t8s6hsq = {
    "real": MultiAddress;
    "call_hash": FixedSizeBinary<32>;
};
export type Ianmuoljk2sk1u = {
    "delegate": MultiAddress;
    "call_hash": FixedSizeBinary<32>;
};
export type I8o7hg9oj4hscp = {
    "delegate": MultiAddress;
    "real": MultiAddress;
    "force_proxy_type"?: Anonymize<Iccd9gbcgdpjso>;
    "call": TxCallData;
};
export type Ifml9odtov51l3 = AnonymousEnum<{
    /**
     * Register an identity for an account. This will overwrite any existing identity.
     */
    "set_identity": Anonymize<I3p6khp3nv37cu>;
    /**
     * Clear the identity of an account.
     */
    "clear_identity": Anonymize<I6pnnj50tnq448>;
}>;
export type I3p6khp3nv37cu = {
    "identified": SS58String;
    "info": Anonymize<Ifiu33afi2n7qs>;
};
export type I6pnnj50tnq448 = {
    "identified": SS58String;
};
export type I5bqhvupj937er = AnonymousEnum<{
    /**
     * Set the commitment for a given netuid
     */
    "set_commitment": Anonymize<I57v1t6776pl3a>;
    /**
     * Sudo-set MaxSpace
     */
    "set_max_space": Anonymize<I1il5mj68vvsms>;
}>;
export type I57v1t6776pl3a = {
    "netuid": number;
    "info": Anonymize<I4122t6tpcniur>;
};
export type I1il5mj68vvsms = {
    "new_limit": number;
};
export type Iemvun0dttbcqs = AnonymousEnum<{
    /**
     * The extrinsic sets the new authorities for Aura consensus.
     * It is only callable by the root account.
     * The extrinsic will call the Aura pallet to change the authorities.
     */
    "swap_authorities": Anonymize<I42mob3hqe6j7h>;
    /**
     * The extrinsic sets the default take for the network.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the default take.
     */
    "sudo_set_default_take": Anonymize<Icdbq0j31b3g9c>;
    /**
     * The extrinsic sets the transaction rate limit for the network.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the transaction rate limit.
     */
    "sudo_set_tx_rate_limit": Anonymize<I3gk6eeddm0hsd>;
    /**
     * The extrinsic sets the serving rate limit for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the serving rate limit.
     */
    "sudo_set_serving_rate_limit": Anonymize<I2t2rlclb0ce3e>;
    /**
     * The extrinsic sets the minimum difficulty for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the minimum difficulty.
     */
    "sudo_set_min_difficulty": Anonymize<Iar87gdqmug5o7>;
    /**
     * The extrinsic sets the maximum difficulty for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the maximum difficulty.
     */
    "sudo_set_max_difficulty": Anonymize<I3oullii9p80a1>;
    /**
     * The extrinsic sets the weights version key for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the weights version key.
     */
    "sudo_set_weights_version_key": Anonymize<I8t8ta6lfbia9e>;
    /**
     * The extrinsic sets the weights set rate limit for a subnet.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the weights set rate limit.
     */
    "sudo_set_weights_set_rate_limit": Anonymize<I3akfmjle982qg>;
    /**
     * The extrinsic sets the adjustment interval for a subnet.
     * It is only callable by the root account, not changeable by the subnet owner.
     * The extrinsic will call the Subtensor pallet to set the adjustment interval.
     */
    "sudo_set_adjustment_interval": Anonymize<Ibaje86kdit7s6>;
    /**
     * The extrinsic sets the adjustment alpha for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the adjustment alpha.
     */
    "sudo_set_adjustment_alpha": Anonymize<I90lra4vl5j4db>;
    /**
     * The extrinsic sets the immunity period for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the immunity period.
     */
    "sudo_set_immunity_period": Anonymize<I1q480m57ftcms>;
    /**
     * The extrinsic sets the minimum allowed weights for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the minimum allowed weights.
     */
    "sudo_set_min_allowed_weights": Anonymize<Ie2bjglo51atf6>;
    /**
     * The extrinsic sets the maximum allowed UIDs for a subnet.
     * It is only callable by the root account and subnet owner.
     * The extrinsic will call the Subtensor pallet to set the maximum allowed UIDs for a subnet.
     */
    "sudo_set_max_allowed_uids": Anonymize<Ievma38tc25kil>;
    /**
     * The extrinsic sets the kappa for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the kappa.
     */
    "sudo_set_kappa": Anonymize<I2er75v4akf5cc>;
    /**
     * The extrinsic sets the rho for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the rho.
     */
    "sudo_set_rho": Anonymize<I5pldh0j0v0u4l>;
    /**
     * The extrinsic sets the activity cutoff for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the activity cutoff.
     */
    "sudo_set_activity_cutoff": Anonymize<Ifhou5p0slv68r>;
    /**
     * The extrinsic sets the network registration allowed for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the network registration allowed.
     */
    "sudo_set_network_registration_allowed": Anonymize<I9m89dnau2i4tt>;
    /**
     * The extrinsic sets the network PoW registration allowed for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the network PoW registration allowed.
     */
    "sudo_set_network_pow_registration_allowed": Anonymize<I9m89dnau2i4tt>;
    /**
     * The extrinsic sets the target registrations per interval for a subnet.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the target registrations per interval.
     */
    "sudo_set_target_registrations_per_interval": Anonymize<Ifunpjbsc4jrrr>;
    /**
     * The extrinsic sets the minimum burn for a subnet.
     * It is only callable by root and subnet owner.
     * The extrinsic will call the Subtensor pallet to set the minimum burn.
     */
    "sudo_set_min_burn": Anonymize<I85uujfpnu8gum>;
    /**
     * The extrinsic sets the maximum burn for a subnet.
     * It is only callable by root and subnet owner.
     * The extrinsic will call the Subtensor pallet to set the maximum burn.
     */
    "sudo_set_max_burn": Anonymize<I7bl5t0it6ck2m>;
    /**
     * The extrinsic sets the difficulty for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the difficulty.
     */
    "sudo_set_difficulty": Anonymize<I4iope0tjiqgu4>;
    /**
     * The extrinsic sets the maximum allowed validators for a subnet.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the maximum allowed validators.
     */
    "sudo_set_max_allowed_validators": Anonymize<Iptqa236frcvo>;
    /**
     * The extrinsic sets the bonds moving average for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the bonds moving average.
     */
    "sudo_set_bonds_moving_average": Anonymize<I8hbi1vrve1i2>;
    /**
     * The extrinsic sets the bonds penalty for a subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the bonds penalty.
     */
    "sudo_set_bonds_penalty": Anonymize<I1v9a50gjqk26k>;
    /**
     * The extrinsic sets the maximum registrations per block for a subnet.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the maximum registrations per block.
     */
    "sudo_set_max_registrations_per_block": Anonymize<Idv4d3rktbigfh>;
    /**
     * The extrinsic sets the subnet owner cut for a subnet.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the subnet owner cut.
     */
    "sudo_set_subnet_owner_cut": Anonymize<I56j1e9gqlq602>;
    /**
     * The extrinsic sets the network rate limit for the network.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the network rate limit.
     */
    "sudo_set_network_rate_limit": Anonymize<Ib6k4vik9ruq8h>;
    /**
     * The extrinsic sets the tempo for a subnet.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the tempo.
     */
    "sudo_set_tempo": Anonymize<I9u9gu9aa92l5m>;
    /**
     * The extrinsic sets the total issuance for the network.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the issuance for the network.
     */
    "sudo_set_total_issuance": Anonymize<Idmd4tos09qd68>;
    /**
     * The extrinsic sets the immunity period for the network.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the immunity period for the network.
     */
    "sudo_set_network_immunity_period": Anonymize<Ia0sp2p68e9k16>;
    /**
     * The extrinsic sets the min lock cost for the network.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the min lock cost for the network.
     */
    "sudo_set_network_min_lock_cost": Anonymize<Ie318529rgoagk>;
    /**
     * The extrinsic sets the subnet limit for the network.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the subnet limit.
     */
    "sudo_set_subnet_limit": Anonymize<Iam4iou8r3isc1>;
    /**
     * The extrinsic sets the lock reduction interval for the network.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the lock reduction interval.
     */
    "sudo_set_lock_reduction_interval": Anonymize<I21ajnsdtbutjh>;
    /**
     * The extrinsic sets the recycled RAO for a subnet.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the recycled RAO.
     */
    "sudo_set_rao_recycled": Anonymize<I203rofi4rpmo4>;
    /**
     * The extrinsic sets the weights min stake.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the weights min stake.
     */
    "sudo_set_stake_threshold": Anonymize<I1e290fmo892vi>;
    /**
     * The extrinsic sets the minimum stake required for nominators.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the minimum stake required for nominators.
     */
    "sudo_set_nominator_min_required_stake": Anonymize<I1e290fmo892vi>;
    /**
     * The extrinsic sets the rate limit for delegate take transactions.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the rate limit for delegate take transactions.
     */
    "sudo_set_tx_delegate_take_rate_limit": Anonymize<I3gk6eeddm0hsd>;
    /**
     * The extrinsic sets the minimum delegate take.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the minimum delegate take.
     */
    "sudo_set_min_delegate_take": Anonymize<I6ue7qc27uhiev>;
    /**
     * The extrinsic enabled/disables commit/reaveal for a given subnet.
     * It is only callable by the root account or subnet owner.
     * The extrinsic will call the Subtensor pallet to set the value.
     */
    "sudo_set_commit_reveal_weights_enabled": Anonymize<Ie31ro5s5e089f>;
    /**
     * Enables or disables Liquid Alpha for a given subnet.
     *
     * # Parameters
     * - `origin`: The origin of the call, which must be the root account or subnet owner.
     * - `netuid`: The unique identifier for the subnet.
     * - `enabled`: A boolean flag to enable or disable Liquid Alpha.
     *
     * # Weight
     * This function has a fixed weight of 0 and is classified as an operational transaction that does not incur any fees.
     */
    "sudo_set_liquid_alpha_enabled": Anonymize<Ie31ro5s5e089f>;
    /**
     * Sets values for liquid alpha
     */
    "sudo_set_alpha_values": Anonymize<I71lu4gpn88cf0>;
    /**
     * Sets the duration of the dissolve network schedule.
     *
     * This extrinsic allows the root account to set the duration for the dissolve network schedule.
     * The dissolve network schedule determines how long it takes for a network dissolution operation to complete.
     *
     * # Arguments
     * * `origin` - The origin of the call, which must be the root account.
     * * `duration` - The new duration for the dissolve network schedule, in number of blocks.
     *
     * # Errors
     * * `BadOrigin` - If the caller is not the root account.
     *
     * # Weight
     * Weight is handled by the `#[pallet::weight]` attribute.
     */
    "sudo_set_dissolve_network_schedule_duration": Anonymize<I98iornf3ajrp9>;
    /**
     * Sets the commit-reveal weights periods for a specific subnet.
     *
     * This extrinsic allows the subnet owner or root account to set the duration (in epochs) during which committed weights must be revealed.
     * The commit-reveal mechanism ensures that users commit weights in advance and reveal them only within a specified period.
     *
     * # Arguments
     * * `origin` - The origin of the call, which must be the subnet owner or the root account.
     * * `netuid` - The unique identifier of the subnet for which the periods are being set.
     * * `periods` - The number of epochs that define the commit-reveal period.
     *
     * # Errors
     * * `BadOrigin` - If the caller is neither the subnet owner nor the root account.
     * * `SubnetDoesNotExist` - If the specified subnet does not exist.
     *
     * # Weight
     * Weight is handled by the `#[pallet::weight]` attribute.
     */
    "sudo_set_commit_reveal_weights_interval": Anonymize<I9893mbk9nh201>;
    /**
     * Sets the EVM ChainID.
     *
     * # Arguments
     * * `origin` - The origin of the call, which must be the subnet owner or the root account.
     * * `chainId` - The u64 chain ID
     *
     * # Errors
     * * `BadOrigin` - If the caller is neither the subnet owner nor the root account.
     *
     * # Weight
     * Weight is handled by the `#[pallet::weight]` attribute.
     */
    "sudo_set_evm_chain_id": Anonymize<I623eo8t3jrbeo>;
    /**
     * A public interface for `pallet_grandpa::Pallet::schedule_grandpa_change`.
     *
     * Schedule a change in the authorities.
     *
     * The change will be applied at the end of execution of the block `in_blocks` after the
     * current block. This value may be 0, in which case the change is applied at the end of
     * the current block.
     *
     * If the `forced` parameter is defined, this indicates that the current set has been
     * synchronously determined to be offline and that after `in_blocks` the given change
     * should be applied. The given block number indicates the median last finalized block
     * number and it should be used as the canon block when starting the new grandpa voter.
     *
     * No change should be signaled while any change is pending. Returns an error if a change
     * is already pending.
     */
    "schedule_grandpa_change": Anonymize<Ieo8qamskgm4dk>;
    /**
     * Enable or disable atomic alpha transfers for a given subnet.
     *
     * # Parameters
     * - `origin`: The origin of the call, which must be the root account or subnet owner.
     * - `netuid`: The unique identifier for the subnet.
     * - `enabled`: A boolean flag to enable or disable Liquid Alpha.
     *
     * # Weight
     * This function has a fixed weight of 0 and is classified as an operational transaction that does not incur any fees.
     */
    "sudo_set_toggle_transfer": Anonymize<Ift1efpssa32g2>;
    /**
     * Set the behaviour of the "burn" UID(s) for a given subnet.
     * If set to `Burn`, the miner emission sent to the burn UID(s) will be burned.
     * If set to `Recycle`, the miner emission sent to the burn UID(s) will be recycled.
     *
     * # Parameters
     * - `origin`: The origin of the call, which must be the root account or subnet owner.
     * - `netuid`: The unique identifier for the subnet.
     * - `recycle_or_burn`: The desired behaviour of the "burn" UID(s) for the subnet.
     *
     */
    "sudo_set_recycle_or_burn": Anonymize<Ibk3v0rrpo1bio>;
    /**
     * Toggles the enablement of an EVM precompile.
     *
     * # Arguments
     * * `origin` - The origin of the call, which must be the root account.
     * * `precompile_id` - The identifier of the EVM precompile to toggle.
     * * `enabled` - The new enablement state of the precompile.
     *
     * # Errors
     * * `BadOrigin` - If the caller is not the root account.
     *
     * # Weight
     * Weight is handled by the `#[pallet::weight]` attribute.
     */
    "sudo_toggle_evm_precompile": Anonymize<I1sj8huj7of8mb>;
    /**
     *
     *
     * # Arguments
     * * `origin` - The origin of the call, which must be the root account.
     * * `alpha` - The new moving alpha value for the SubnetMovingAlpha.
     *
     * # Errors
     * * `BadOrigin` - If the caller is not the root account.
     *
     * # Weight
     * Weight is handled by the `#[pallet::weight]` attribute.
     */
    "sudo_set_subnet_moving_alpha": Anonymize<I6av3sq9jkhmm3>;
    /**
     * Change the SubnetOwnerHotkey for a given subnet.
     *
     * # Arguments
     * * `origin` - The origin of the call, which must be the subnet owner.
     * * `netuid` - The unique identifier for the subnet.
     * * `hotkey` - The new hotkey for the subnet owner.
     *
     * # Errors
     * * `BadOrigin` - If the caller is not the subnet owner or root account.
     *
     * # Weight
     * Weight is handled by the `#[pallet::weight]` attribute.
     */
    "sudo_set_subnet_owner_hotkey": Anonymize<I7f38r2vt6r9k1>;
    /**
     *
     *
     * # Arguments
     * * `origin` - The origin of the call, which must be the root account.
     * * `ema_alpha_period` - Number of blocks for EMA price to halve
     *
     * # Errors
     * * `BadOrigin` - If the caller is not the root account.
     *
     * # Weight
     * Weight is handled by the `#[pallet::weight]` attribute.
     */
    "sudo_set_ema_price_halving_period": Anonymize<I70cd7doki8rme>;
    /**
     *
     *
     * # Arguments
     * * `origin` - The origin of the call, which must be the root account.
     * * `netuid` - The unique identifier for the subnet.
     * * `steepness` - The Steepness for the alpha sigmoid function. (range is 0-int16::MAX,
     * negative values are reserved for future use)
     *
     * # Errors
     * * `BadOrigin` - If the caller is not the root account.
     * * `SubnetDoesNotExist` - If the specified subnet does not exist.
     * * `NegativeSigmoidSteepness` - If the steepness is negative and the caller is
     * root.
     * # Weight
     * Weight is handled by the `#[pallet::weight]` attribute.
     */
    "sudo_set_alpha_sigmoid_steepness": Anonymize<Iam7j42j9f1go6>;
    /**
     * Enables or disables Yuma3 for a given subnet.
     *
     * # Parameters
     * - `origin`: The origin of the call, which must be the root account or subnet owner.
     * - `netuid`: The unique identifier for the subnet.
     * - `enabled`: A boolean flag to enable or disable Yuma3.
     *
     * # Weight
     * This function has a fixed weight of 0 and is classified as an operational transaction that does not incur any fees.
     */
    "sudo_set_yuma3_enabled": Anonymize<Ie31ro5s5e089f>;
    /**
     * Enables or disables Bonds Reset for a given subnet.
     *
     * # Parameters
     * - `origin`: The origin of the call, which must be the root account or subnet owner.
     * - `netuid`: The unique identifier for the subnet.
     * - `enabled`: A boolean flag to enable or disable Bonds Reset.
     *
     * # Weight
     * This function has a fixed weight of 0 and is classified as an operational transaction that does not incur any fees.
     */
    "sudo_set_bonds_reset_enabled": Anonymize<Ie31ro5s5e089f>;
    /**
     * Sets or updates the hotkey account associated with the owner of a specific subnet.
     *
     * This function allows either the root origin or the current subnet owner to set or update
     * the hotkey for a given subnet. The subnet must already exist. To prevent abuse, the call is
     * rate-limited to once per configured interval (default: one week) per subnet.
     *
     * # Parameters
     * - `origin`: The dispatch origin of the call. Must be either root or the current owner of the subnet.
     * - `netuid`: The unique identifier of the subnet whose owner hotkey is being set.
     * - `hotkey`: The new hotkey account to associate with the subnet owner.
     *
     * # Returns
     * - `DispatchResult`: Returns `Ok(())` if the hotkey was successfully set, or an appropriate error otherwise.
     *
     * # Errors
     * - `Error::SubnetNotExists`: If the specified subnet does not exist.
     * - `Error::TxRateLimitExceeded`: If the function is called more frequently than the allowed rate limit.
     *
     * # Access Control
     * Only callable by:
     * - Root origin, or
     * - The coldkey account that owns the subnet.
     *
     * # Storage
     * - Updates [`SubnetOwnerHotkey`] for the given `netuid`.
     * - Reads and updates [`LastRateLimitedBlock`] for rate-limiting.
     * - Reads [`DefaultSetSNOwnerHotkeyRateLimit`] to determine the interval between allowed updates.
     *
     * # Rate Limiting
     * This function is rate-limited to one call per subnet per interval (e.g., one week).
     */
    "sudo_set_sn_owner_hotkey": Anonymize<I7f38r2vt6r9k1>;
    /**
     * Enables or disables subtoken trading for a given subnet.
     *
     * # Arguments
     * * `origin` - The origin of the call, which must be the root account.
     * * `netuid` - The unique identifier of the subnet.
     * * `subtoken_enabled` - A boolean indicating whether subtoken trading should be enabled or disabled.
     *
     * # Errors
     * * `BadOrigin` - If the caller is not the root account.
     *
     * # Weight
     * Weight is handled by the `#[pallet::weight]` attribute.
     */
    "sudo_set_subtoken_enabled": Anonymize<Idco9ambhipg4i>;
    /**
     * Sets the commit-reveal weights version for all subnets
     */
    "sudo_set_commit_reveal_version": Anonymize<I6s1nbislhk619>;
    /**
     * Sets the number of immune owner neurons
     */
    "sudo_set_owner_immune_neuron_limit": Anonymize<I9jtu7slb30qvs>;
    /**
     * Sets the childkey burn for a subnet.
     * It is only callable by the root account.
     * The extrinsic will call the Subtensor pallet to set the childkey burn.
     */
    "sudo_set_ck_burn": Anonymize<Idv3j6a15pjc16>;
    /**
     * Sets the admin freeze window length (in blocks) at the end of a tempo.
     * Only callable by root.
     */
    "sudo_set_admin_freeze_window": Anonymize<I206qvjkjun95i>;
    /**
     * Sets the owner hyperparameter rate limit in epochs (global multiplier).
     * Only callable by root.
     */
    "sudo_set_owner_hparam_rate_limit": Anonymize<I4qhb3plq4ifmq>;
    /**
     * Sets the desired number of mechanisms in a subnet
     */
    "sudo_set_mechanism_count": Anonymize<Ic58lhlh1ocpm1>;
    /**
     * Sets the emission split between mechanisms in a subnet
     */
    "sudo_set_mechanism_emission_split": Anonymize<I6uopd4b2os90n>;
    /**
     * Trims the maximum number of UIDs for a subnet.
     *
     * The trimming is done by sorting the UIDs by emission descending and then trimming
     * the lowest emitters while preserving temporally and owner immune UIDs. The UIDs are
     * then compressed to the left and storage is migrated to the new compressed UIDs.
     */
    "sudo_trim_to_max_allowed_uids": Anonymize<I6idbvi8v00o5j>;
    /**
     * The extrinsic sets the minimum allowed UIDs for a subnet.
     * It is only callable by the root account.
     */
    "sudo_set_min_allowed_uids": Anonymize<Ifbgbhkj74b35k>;
    /**
     * Sets TAO flow cutoff value (A)
     */
    "sudo_set_tao_flow_cutoff": Anonymize<Ibt4a800kb7frq>;
    /**
     * Sets TAO flow normalization exponent (p)
     */
    "sudo_set_tao_flow_normalization_exponent": Anonymize<Icb4un8h4cokoo>;
    /**
     * Sets TAO flow smoothing factor (alpha)
     */
    "sudo_set_tao_flow_smoothing_factor": Anonymize<I1up607q6ce947>;
    /**
     * Sets the global maximum number of mechanisms in a subnet
     */
    "sudo_set_max_mechanism_count": Anonymize<I7hktg5sccf8op>;
    /**
     * Sets the minimum number of non-immortal & non-immune UIDs that must remain in a subnet
     */
    "sudo_set_min_non_immune_uids": Anonymize<Ib1d0bomkbrqv1>;
    /**
     * Sets the delay before a subnet can call start
     */
    "sudo_set_start_call_delay": Anonymize<Iaflrold1ds0nq>;
    /**
     * Sets the announcement delay for coldkey swap.
     */
    "sudo_set_coldkey_swap_announcement_delay": Anonymize<I98iornf3ajrp9>;
    /**
     * Sets the coldkey swap reannouncement delay.
     */
    "sudo_set_coldkey_swap_reannouncement_delay": Anonymize<I98iornf3ajrp9>;
}>;
export type I42mob3hqe6j7h = {
    "new_authorities": Anonymize<Ic5m5lp1oioo8r>;
};
export type Icdbq0j31b3g9c = {
    "default_take": number;
};
export type I2t2rlclb0ce3e = {
    "netuid": number;
    "serving_rate_limit": bigint;
};
export type Iar87gdqmug5o7 = {
    "netuid": number;
    "min_difficulty": bigint;
};
export type I3oullii9p80a1 = {
    "netuid": number;
    "max_difficulty": bigint;
};
export type I8t8ta6lfbia9e = {
    "netuid": number;
    "weights_version_key": bigint;
};
export type I3akfmjle982qg = {
    "netuid": number;
    "weights_set_rate_limit": bigint;
};
export type Ibaje86kdit7s6 = {
    "netuid": number;
    "adjustment_interval": number;
};
export type I90lra4vl5j4db = {
    "netuid": number;
    "adjustment_alpha": bigint;
};
export type I1q480m57ftcms = {
    "netuid": number;
    "immunity_period": number;
};
export type Ie2bjglo51atf6 = {
    "netuid": number;
    "min_allowed_weights": number;
};
export type Ievma38tc25kil = {
    "netuid": number;
    "max_allowed_uids": number;
};
export type I2er75v4akf5cc = {
    "netuid": number;
    "kappa": number;
};
export type I5pldh0j0v0u4l = {
    "netuid": number;
    "rho": number;
};
export type Ifhou5p0slv68r = {
    "netuid": number;
    "activity_cutoff": number;
};
export type I9m89dnau2i4tt = {
    "netuid": number;
    "registration_allowed": boolean;
};
export type Ifunpjbsc4jrrr = {
    "netuid": number;
    "target_registrations_per_interval": number;
};
export type I85uujfpnu8gum = {
    "netuid": number;
    "min_burn": bigint;
};
export type I7bl5t0it6ck2m = {
    "netuid": number;
    "max_burn": bigint;
};
export type I4iope0tjiqgu4 = {
    "netuid": number;
    "difficulty": bigint;
};
export type Iptqa236frcvo = {
    "netuid": number;
    "max_allowed_validators": number;
};
export type I8hbi1vrve1i2 = {
    "netuid": number;
    "bonds_moving_average": bigint;
};
export type I1v9a50gjqk26k = {
    "netuid": number;
    "bonds_penalty": number;
};
export type Idv4d3rktbigfh = {
    "netuid": number;
    "max_registrations_per_block": number;
};
export type I56j1e9gqlq602 = {
    "subnet_owner_cut": number;
};
export type Ib6k4vik9ruq8h = {
    "rate_limit": bigint;
};
export type I9u9gu9aa92l5m = {
    "netuid": number;
    "tempo": number;
};
export type Idmd4tos09qd68 = {
    "total_issuance": bigint;
};
export type Ia0sp2p68e9k16 = {
    "immunity_period": bigint;
};
export type Ie318529rgoagk = {
    "lock_cost": bigint;
};
export type Iam4iou8r3isc1 = {
    "max_subnets": number;
};
export type I21ajnsdtbutjh = {
    "interval": bigint;
};
export type I203rofi4rpmo4 = {
    "netuid": number;
    "rao_recycled": bigint;
};
export type I1e290fmo892vi = {
    "min_stake": bigint;
};
export type I71lu4gpn88cf0 = {
    "netuid": number;
    "alpha_low": number;
    "alpha_high": number;
};
export type I98iornf3ajrp9 = {
    "duration": number;
};
export type I9893mbk9nh201 = {
    "netuid": number;
    "interval": bigint;
};
export type I623eo8t3jrbeo = {
    "chain_id": bigint;
};
export type Ieo8qamskgm4dk = {
    "next_authorities": Anonymize<I3geksg000c171>;
    "in_blocks": number;
    "forced"?: Anonymize<I4arjljr6dpflb>;
};
export type Ift1efpssa32g2 = {
    "netuid": number;
    "toggle": boolean;
};
export type Ibk3v0rrpo1bio = {
    "netuid": number;
    "recycle_or_burn": Anonymize<Ib9tptuv3cggfs>;
};
export type I6av3sq9jkhmm3 = {
    "alpha": bigint;
};
export type I70cd7doki8rme = {
    "netuid": number;
    "ema_halving": bigint;
};
export type Iam7j42j9f1go6 = {
    "netuid": number;
    "steepness": number;
};
export type Idco9ambhipg4i = {
    "netuid": number;
    "subtoken_enabled": boolean;
};
export type I6s1nbislhk619 = {
    "version": number;
};
export type I9jtu7slb30qvs = {
    "netuid": number;
    "immune_neurons": number;
};
export type Idv3j6a15pjc16 = {
    "burn": bigint;
};
export type I206qvjkjun95i = {
    "window": number;
};
export type I4qhb3plq4ifmq = {
    "epochs": number;
};
export type Ic58lhlh1ocpm1 = {
    "netuid": number;
    "mechanism_count": number;
};
export type I6uopd4b2os90n = {
    "netuid": number;
    "maybe_split"?: Anonymize<I35lk2003i8c8g>;
};
export type I35lk2003i8c8g = (Anonymize<Icgljjb6j82uhn>) | undefined;
export type I6idbvi8v00o5j = {
    "netuid": number;
    "max_n": number;
};
export type Ifbgbhkj74b35k = {
    "netuid": number;
    "min_allowed_uids": number;
};
export type Ibt4a800kb7frq = {
    "flow_cutoff": bigint;
};
export type Icb4un8h4cokoo = {
    "exponent": bigint;
};
export type I1up607q6ce947 = {
    "smoothing_factor": bigint;
};
export type I7hktg5sccf8op = {
    "max_mechanism_count": number;
};
export type Ib1d0bomkbrqv1 = {
    "netuid": number;
    "min": number;
};
export type Iaflrold1ds0nq = {
    "delay": bigint;
};
export type I48eehof2eias5 = AnonymousEnum<{
    /**
     * Enter safe-mode permissionlessly for [`Config::EnterDuration`] blocks.
     *
     * Reserves [`Config::EnterDepositAmount`] from the caller's account.
     * Emits an [`Event::Entered`] event on success.
     * Errors with [`Error::Entered`] if the safe-mode is already entered.
     * Errors with [`Error::NotConfigured`] if the deposit amount is `None`.
     */
    "enter": undefined;
    /**
     * Enter safe-mode by force for a per-origin configured number of blocks.
     *
     * Emits an [`Event::Entered`] event on success.
     * Errors with [`Error::Entered`] if the safe-mode is already entered.
     *
     * Can only be called by the [`Config::ForceEnterOrigin`] origin.
     */
    "force_enter": undefined;
    /**
     * Extend the safe-mode permissionlessly for [`Config::ExtendDuration`] blocks.
     *
     * This accumulates on top of the current remaining duration.
     * Reserves [`Config::ExtendDepositAmount`] from the caller's account.
     * Emits an [`Event::Extended`] event on success.
     * Errors with [`Error::Exited`] if the safe-mode is entered.
     * Errors with [`Error::NotConfigured`] if the deposit amount is `None`.
     *
     * This may be called by any signed origin with [`Config::ExtendDepositAmount`] free
     * currency to reserve. This call can be disabled for all origins by configuring
     * [`Config::ExtendDepositAmount`] to `None`.
     */
    "extend": undefined;
    /**
     * Extend the safe-mode by force for a per-origin configured number of blocks.
     *
     * Emits an [`Event::Extended`] event on success.
     * Errors with [`Error::Exited`] if the safe-mode is inactive.
     *
     * Can only be called by the [`Config::ForceExtendOrigin`] origin.
     */
    "force_extend": undefined;
    /**
     * Exit safe-mode by force.
     *
     * Emits an [`Event::Exited`] with [`ExitReason::Force`] event on success.
     * Errors with [`Error::Exited`] if the safe-mode is inactive.
     *
     * Note: `safe-mode` will be automatically deactivated by [`Pallet::on_initialize`] hook
     * after the block height is greater than the [`EnteredUntil`] storage item.
     * Emits an [`Event::Exited`] with [`ExitReason::Timeout`] event when deactivated in the
     * hook.
     */
    "force_exit": undefined;
    /**
     * Slash a deposit for an account that entered or extended safe-mode at a given
     * historical block.
     *
     * This can only be called while safe-mode is entered.
     *
     * Emits a [`Event::DepositSlashed`] event on success.
     * Errors with [`Error::Entered`] if safe-mode is entered.
     *
     * Can only be called by the [`Config::ForceDepositOrigin`] origin.
     */
    "force_slash_deposit": Anonymize<I1ssp78ejl639m>;
    /**
     * Permissionlessly release a deposit for an account that entered safe-mode at a
     * given historical block.
     *
     * The call can be completely disabled by setting [`Config::ReleaseDelay`] to `None`.
     * This cannot be called while safe-mode is entered and not until
     * [`Config::ReleaseDelay`] blocks have passed since safe-mode was entered.
     *
     * Emits a [`Event::DepositReleased`] event on success.
     * Errors with [`Error::Entered`] if the safe-mode is entered.
     * Errors with [`Error::CannotReleaseYet`] if [`Config::ReleaseDelay`] block have not
     * passed since safe-mode was entered. Errors with [`Error::NoDeposit`] if the payee has no
     * reserved currency at the block specified.
     */
    "release_deposit": Anonymize<I1ssp78ejl639m>;
    /**
     * Force to release a deposit for an account that entered safe-mode at a given
     * historical block.
     *
     * This can be called while safe-mode is still entered.
     *
     * Emits a [`Event::DepositReleased`] event on success.
     * Errors with [`Error::Entered`] if safe-mode is entered.
     * Errors with [`Error::NoDeposit`] if the payee has no reserved currency at the
     * specified block.
     *
     * Can only be called by the [`Config::ForceDepositOrigin`] origin.
     */
    "force_release_deposit": Anonymize<I1ssp78ejl639m>;
}>;
export type I1ssp78ejl639m = {
    "account": SS58String;
    "block": number;
};
export type I3lo8is2egp8k4 = AnonymousEnum<{
    /**
     * Transact an Ethereum transaction.
     */
    "transact": Anonymize<I13qib3vtm9cs3>;
}>;
export type I13qib3vtm9cs3 = {
    "transaction": Anonymize<Ibjuap2vk03rp6>;
};
export type Iafltn68socb5h = AnonymousEnum<{
    /**
     * Withdraw balance from EVM into currency/balances pallet.
     */
    "withdraw": Anonymize<Idcabvplu05lea>;
    /**
     * Issue an EVM call operation. This is similar to a message call transaction in Ethereum.
     */
    "call": Anonymize<Id38gdpcotl637>;
    /**
     * Issue an EVM create operation. This is similar to a contract creation transaction in
     * Ethereum.
     */
    "create": Anonymize<I73q3qf5u7nnqg>;
    /**
     * Issue an EVM create2 operation.
     */
    "create2": Anonymize<Idpm1bc2cr6dgj>;
    "set_whitelist": Anonymize<I837c61fc07ine>;
    "disable_whitelist": Anonymize<I6m0oguilvhn8>;
}>;
export type Idcabvplu05lea = {
    "address": FixedSizeBinary<20>;
    "value": bigint;
};
export type Id38gdpcotl637 = {
    "source": FixedSizeBinary<20>;
    "target": FixedSizeBinary<20>;
    "input": Binary;
    "value": Anonymize<I4totqt881mlti>;
    "gas_limit": bigint;
    "max_fee_per_gas": Anonymize<I4totqt881mlti>;
    "max_priority_fee_per_gas"?: Anonymize<Ic4rgfgksgmm3e>;
    "nonce"?: Anonymize<Ic4rgfgksgmm3e>;
    "access_list": Anonymize<I1bsfec060j604>;
    "authorization_list": Anonymize<Idg0qi60379vnh>;
};
export type Ic4rgfgksgmm3e = (Anonymize<I4totqt881mlti>) | undefined;
export type I1bsfec060j604 = Array<[FixedSizeBinary<20>, Anonymize<Ic5m5lp1oioo8r>]>;
export type I73q3qf5u7nnqg = {
    "source": FixedSizeBinary<20>;
    "init": Binary;
    "value": Anonymize<I4totqt881mlti>;
    "gas_limit": bigint;
    "max_fee_per_gas": Anonymize<I4totqt881mlti>;
    "max_priority_fee_per_gas"?: Anonymize<Ic4rgfgksgmm3e>;
    "nonce"?: Anonymize<Ic4rgfgksgmm3e>;
    "access_list": Anonymize<I1bsfec060j604>;
    "authorization_list": Anonymize<Idg0qi60379vnh>;
};
export type Idpm1bc2cr6dgj = {
    "source": FixedSizeBinary<20>;
    "init": Binary;
    "salt": FixedSizeBinary<32>;
    "value": Anonymize<I4totqt881mlti>;
    "gas_limit": bigint;
    "max_fee_per_gas": Anonymize<I4totqt881mlti>;
    "max_priority_fee_per_gas"?: Anonymize<Ic4rgfgksgmm3e>;
    "nonce"?: Anonymize<Ic4rgfgksgmm3e>;
    "access_list": Anonymize<I1bsfec060j604>;
    "authorization_list": Anonymize<Idg0qi60379vnh>;
};
export type I837c61fc07ine = {
    "new": Anonymize<I4gqmlq9k6jlk3>;
};
export type I6m0oguilvhn8 = {
    "disabled": boolean;
};
export type I2aqcjbjlffus = AnonymousEnum<{
    "set_base_fee_per_gas": Anonymize<I7vi74gbubc8u5>;
    "set_elasticity": Anonymize<I3u0knmtb1ueq7>;
}>;
export type Ibdf4fkp7qcokd = AnonymousEnum<{
    /**
     * Verify and write a pulse from the beacon into the runtime
     */
    "write_pulse": Anonymize<I87tlou92i0bot>;
    /**
     * allows the root user to set the beacon configuration
     * generally this would be called from an offchain worker context.
     * there is no verification of configurations, so be careful with this.
     *
     * * `origin`: the root user
     * * `config`: the beacon configuration
     */
    "set_beacon_config": Anonymize<Ifd3mkud9g8rb1>;
    /**
     * allows the root user to set the oldest stored round
     */
    "set_oldest_stored_round": Anonymize<Iakvbbhvger3oa>;
}>;
export type I87tlou92i0bot = {
    "pulses_payload": {
        "block_number": number;
        "pulses": Array<Anonymize<Ialchst9lgd11u>>;
        "public": MultiSigner;
    };
    "signature"?: Anonymize<I86cdjmsf3a81s>;
};
export type MultiSigner = Enum<{
    "Ed25519": FixedSizeBinary<32>;
    "Sr25519": FixedSizeBinary<32>;
    "Ecdsa": FixedSizeBinary<33>;
}>;
export declare const MultiSigner: GetEnum<MultiSigner>;
export type I86cdjmsf3a81s = (MultiSignature) | undefined;
export type MultiSignature = Enum<{
    "Ed25519": FixedSizeBinary<64>;
    "Sr25519": FixedSizeBinary<64>;
    "Ecdsa": FixedSizeBinary<65>;
}>;
export declare const MultiSignature: GetEnum<MultiSignature>;
export type Ifd3mkud9g8rb1 = {
    "config_payload": {
        "block_number": number;
        "config": Anonymize<I494mq1ertfc9k>;
        "public": MultiSigner;
    };
    "signature"?: Anonymize<I86cdjmsf3a81s>;
};
export type Iakvbbhvger3oa = {
    "oldest_round": bigint;
};
export type Ic9v5nofc059ih = AnonymousEnum<{
    /**
     * Create a crowdloan that will raise funds up to a maximum cap and if successful,
     * will transfer funds to the target address if provided and dispatch the call
     * (using creator origin).
     *
     * The initial deposit will be transfered to the crowdloan account and will be refunded
     * in case the crowdloan fails to raise the cap. Additionally, the creator will pay for
     * the execution of the call.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `deposit`: The initial deposit from the creator.
     * - `min_contribution`: The minimum contribution required to contribute to the crowdloan.
     * - `cap`: The maximum amount of funds that can be raised.
     * - `end`: The block number at which the crowdloan will end.
     * - `call`: The call to dispatch when the crowdloan is finalized.
     * - `target_address`: The address to transfer the raised funds to if provided.
     */
    "create": Anonymize<Ichahh9gh3g4i>;
    /**
     * Contribute to an active crowdloan.
     *
     * The contribution will be transfered to the crowdloan account and will be refunded
     * if the crowdloan fails to raise the cap. If the contribution would raise the amount above the cap,
     * the contribution will be set to the amount that is left to be raised.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `crowdloan_id`: The id of the crowdloan to contribute to.
     * - `amount`: The amount to contribute.
     */
    "contribute": Anonymize<Iet4pe2le7ku09>;
    /**
     * Withdraw a contribution from an active (not yet finalized or dissolved) crowdloan.
     *
     * Only contributions over the deposit can be withdrawn by the creator.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `crowdloan_id`: The id of the crowdloan to withdraw from.
     */
    "withdraw": Anonymize<I5dueehi6i2dg9>;
    /**
     * Finalize crowdloan that has reached the cap.
     *
     * The call will transfer the raised amount to the target address if it was provided when the crowdloan was created
     * and dispatch the call that was provided using the creator origin. The CurrentCrowdloanId will be set to the
     * crowdloan id being finalized so the dispatched call can access it temporarily by accessing
     * the `CurrentCrowdloanId` storage item.
     *
     * The dispatch origin for this call must be _Signed_ and must be the creator of the crowdloan.
     *
     * Parameters:
     * - `crowdloan_id`: The id of the crowdloan to finalize.
     */
    "finalize": Anonymize<I5dueehi6i2dg9>;
    /**
     * Refund contributors of a non-finalized crowdloan.
     *
     * The call will try to refund all contributors (excluding the creator) up to the limit defined by the `RefundContributorsLimit`.
     * If the limit is reached, the call will stop and the crowdloan will be marked as partially refunded.
     * It may be needed to dispatch this call multiple times to refund all contributors.
     *
     * The dispatch origin for this call must be _Signed_ and doesn't need to be the creator of the crowdloan.
     *
     * Parameters:
     * - `crowdloan_id`: The id of the crowdloan to refund.
     */
    "refund": Anonymize<I5dueehi6i2dg9>;
    /**
     * Dissolve a crowdloan.
     *
     * The crowdloan will be removed from the storage.
     * All contributions must have been refunded before the crowdloan can be dissolved (except the creator's one).
     *
     * The dispatch origin for this call must be _Signed_ and must be the creator of the crowdloan.
     *
     * Parameters:
     * - `crowdloan_id`: The id of the crowdloan to dissolve.
     */
    "dissolve": Anonymize<I5dueehi6i2dg9>;
    /**
     * Update the minimum contribution of a non-finalized crowdloan.
     *
     * The dispatch origin for this call must be _Signed_ and must be the creator of the crowdloan.
     *
     * Parameters:
     * - `crowdloan_id`: The id of the crowdloan to update the minimum contribution of.
     * - `new_min_contribution`: The new minimum contribution.
     */
    "update_min_contribution": Anonymize<I64ev05f6q10es>;
    /**
     * Update the end block of a non-finalized crowdloan.
     *
     * The dispatch origin for this call must be _Signed_ and must be the creator of the crowdloan.
     *
     * Parameters:
     * - `crowdloan_id`: The id of the crowdloan to update the end block of.
     * - `new_end`: The new end block.
     */
    "update_end": Anonymize<Ikc5h15joooak>;
    /**
     * Update the cap of a non-finalized crowdloan.
     *
     * The dispatch origin for this call must be _Signed_ and must be the creator of the crowdloan.
     *
     * Parameters:
     * - `crowdloan_id`: The id of the crowdloan to update the cap of.
     * - `new_cap`: The new cap.
     */
    "update_cap": Anonymize<Ie8f436ua5fs59>;
}>;
export type Ichahh9gh3g4i = {
    "deposit": bigint;
    "min_contribution": bigint;
    "cap": bigint;
    "end": number;
    "call"?: (TxCallData) | undefined;
    "target_address"?: Anonymize<Ihfphjolmsqq1>;
};
export type Iet4pe2le7ku09 = {
    "crowdloan_id": number;
    "amount": bigint;
};
export type Id0qcnu1chac12 = AnonymousEnum<{
    /**
     * Set the fee rate for swaps on a specific subnet (normalized value).
     * For example, 0.3% is approximately 196.
     *
     * Only callable by the admin origin
     */
    "set_fee_rate": Anonymize<I3mkis681qg30e>;
    /**
     * DEPRECATED
     */
    "toggle_user_liquidity": Anonymize<I2foqo7cbqf35v>;
    /**
     * DEPRECATED
     */
    "add_liquidity": Anonymize<I3mcu79ge1e54v>;
    /**
     * DEPRECATED
     */
    "remove_liquidity": Anonymize<Icf66vuktncksu>;
    /**
     * DEPRECATED
     */
    "modify_position": Anonymize<Id69glo8rcjef>;
    /**
     * DEPRECATED
     */
    "disable_lp": undefined;
}>;
export type I2foqo7cbqf35v = {
    "netuid": number;
    "enable": boolean;
};
export type I3mcu79ge1e54v = {
    "hotkey": SS58String;
    "netuid": number;
    "tick_low": number;
    "tick_high": number;
    "liquidity": bigint;
};
export type Icf66vuktncksu = {
    "hotkey": SS58String;
    "netuid": number;
    "position_id": bigint;
};
export type Id69glo8rcjef = {
    "hotkey": SS58String;
    "netuid": number;
    "position_id": bigint;
    "liquidity_delta": bigint;
};
export type I6jivj2j5qp8sa = AnonymousEnum<{
    /**
     * Deprecated version if [`Self::call`] for use in an in-storage `Call`.
     */
    "call_old_weight": Anonymize<Ia2rnh5pfua40a>;
    /**
     * Deprecated version if [`Self::instantiate_with_code`] for use in an in-storage `Call`.
     */
    "instantiate_with_code_old_weight": Anonymize<I3otc7e9a35k1k>;
    /**
     * Deprecated version if [`Self::instantiate`] for use in an in-storage `Call`.
     */
    "instantiate_old_weight": Anonymize<I89ier5tb9ne0s>;
    /**
     * Upload new `code` without instantiating a contract from it.
     *
     * If the code does not already exist a deposit is reserved from the caller
     * and unreserved only when [`Self::remove_code`] is called. The size of the reserve
     * depends on the size of the supplied `code`.
     *
     * If the code already exists in storage it will still return `Ok` and upgrades
     * the in storage version to the current
     * [`InstructionWeights::version`](InstructionWeights).
     *
     * - `determinism`: If this is set to any other value but [`Determinism::Enforced`] then
     * the only way to use this code is to delegate call into it from an offchain execution.
     * Set to [`Determinism::Enforced`] if in doubt.
     *
     * # Note
     *
     * Anyone can instantiate a contract from any uploaded code and thus prevent its removal.
     * To avoid this situation a constructor could employ access control so that it can
     * only be instantiated by permissioned entities. The same is true when uploading
     * through [`Self::instantiate_with_code`].
     *
     * Use [`Determinism::Relaxed`] exclusively for non-deterministic code. If the uploaded
     * code is deterministic, specifying [`Determinism::Relaxed`] will be disregarded and
     * result in higher gas costs.
     */
    "upload_code": Anonymize<Im2f0numhevg3>;
    /**
     * Remove the code stored under `code_hash` and refund the deposit to its owner.
     *
     * A code can only be removed by its original uploader (its owner) and only if it is
     * not used by any contract.
     */
    "remove_code": Anonymize<Ib51vk42m1po4n>;
    /**
     * Privileged function that changes the code of an existing contract.
     *
     * This takes care of updating refcounts and all other necessary operations. Returns
     * an error if either the `code_hash` or `dest` do not exist.
     *
     * # Note
     *
     * This does **not** change the address of the contract in question. This means
     * that the contract address is no longer derived from its code hash after calling
     * this dispatchable.
     */
    "set_code": Anonymize<I2agkcpojhkk43>;
    /**
     * Makes a call to an account, optionally transferring some balance.
     *
     * # Parameters
     *
     * * `dest`: Address of the contract to call.
     * * `value`: The balance to transfer from the `origin` to `dest`.
     * * `gas_limit`: The gas limit enforced when executing the constructor.
     * * `storage_deposit_limit`: The maximum amount of balance that can be charged from the
     * caller to pay for the storage consumed.
     * * `data`: The input data to pass to the contract.
     *
     * * If the account is a smart-contract account, the associated code will be
     * executed and any value will be transferred.
     * * If the account is a regular account, any value will be transferred.
     * * If no account exists and the call value is not less than `existential_deposit`,
     * a regular account will be created and any value will be transferred.
     */
    "call": Anonymize<I32rvg545edabm>;
    /**
     * Instantiates a new contract from the supplied `code` optionally transferring
     * some balance.
     *
     * This dispatchable has the same effect as calling [`Self::upload_code`] +
     * [`Self::instantiate`]. Bundling them together provides efficiency gains. Please
     * also check the documentation of [`Self::upload_code`].
     *
     * # Parameters
     *
     * * `value`: The balance to transfer from the `origin` to the newly created contract.
     * * `gas_limit`: The gas limit enforced when executing the constructor.
     * * `storage_deposit_limit`: The maximum amount of balance that can be charged/reserved
     * from the caller to pay for the storage consumed.
     * * `code`: The contract code to deploy in raw bytes.
     * * `data`: The input data to pass to the contract constructor.
     * * `salt`: Used for the address derivation. See [`Pallet::contract_address`].
     *
     * Instantiation is executed as follows:
     *
     * - The supplied `code` is deployed, and a `code_hash` is created for that code.
     * - If the `code_hash` already exists on the chain the underlying `code` will be shared.
     * - The destination address is computed based on the sender, code_hash and the salt.
     * - The smart-contract account is created at the computed address.
     * - The `value` is transferred to the new account.
     * - The `deploy` function is executed in the context of the newly-created account.
     */
    "instantiate_with_code": Anonymize<I83fv0vi59md7i>;
    /**
     * Instantiates a contract from a previously deployed wasm binary.
     *
     * This function is identical to [`Self::instantiate_with_code`] but without the
     * code deployment step. Instead, the `code_hash` of an on-chain deployed wasm binary
     * must be supplied.
     */
    "instantiate": Anonymize<I5tjjqcdd4tae0>;
    /**
     * When a migration is in progress, this dispatchable can be used to run migration steps.
     * Calls that contribute to advancing the migration have their fees waived, as it's helpful
     * for the chain. Note that while the migration is in progress, the pallet will also
     * leverage the `on_idle` hooks to run migration steps.
     */
    "migrate": Anonymize<I1894dm1lf1ae7>;
}>;
export type Ia2rnh5pfua40a = {
    "dest": MultiAddress;
    "value": bigint;
    "gas_limit": bigint;
    "storage_deposit_limit"?: Anonymize<I35p85j063s0il>;
    "data": Binary;
};
export type I3otc7e9a35k1k = {
    "value": bigint;
    "gas_limit": bigint;
    "storage_deposit_limit"?: Anonymize<I35p85j063s0il>;
    "code": Binary;
    "data": Binary;
    "salt": Binary;
};
export type I89ier5tb9ne0s = {
    "value": bigint;
    "gas_limit": bigint;
    "storage_deposit_limit"?: Anonymize<I35p85j063s0il>;
    "code_hash": FixedSizeBinary<32>;
    "data": Binary;
    "salt": Binary;
};
export type Im2f0numhevg3 = {
    "code": Binary;
    "storage_deposit_limit"?: Anonymize<I35p85j063s0il>;
    "determinism": Anonymize<I2dfliekq1ed7e>;
};
export type I2agkcpojhkk43 = {
    "dest": MultiAddress;
    "code_hash": FixedSizeBinary<32>;
};
export type I32rvg545edabm = {
    "dest": MultiAddress;
    "value": bigint;
    "gas_limit": Anonymize<I4q39t5hn830vp>;
    "storage_deposit_limit"?: Anonymize<I35p85j063s0il>;
    "data": Binary;
};
export type I83fv0vi59md7i = {
    "value": bigint;
    "gas_limit": Anonymize<I4q39t5hn830vp>;
    "storage_deposit_limit"?: Anonymize<I35p85j063s0il>;
    "code": Binary;
    "data": Binary;
    "salt": Binary;
};
export type I5tjjqcdd4tae0 = {
    "value": bigint;
    "gas_limit": Anonymize<I4q39t5hn830vp>;
    "storage_deposit_limit"?: Anonymize<I35p85j063s0il>;
    "code_hash": FixedSizeBinary<32>;
    "data": Binary;
    "salt": Binary;
};
export type I1894dm1lf1ae7 = {
    "weight_limit": Anonymize<I4q39t5hn830vp>;
};
export type I1o2fkthdkdbjl = AnonymousEnum<{
    /**
     * Announce the ML‑KEM public key that will become `CurrentKey` in
     * the following block.
     */
    "announce_next_key": Anonymize<Idkfsqnep2hpeb>;
    /**
     * Users submit an encrypted wrapper.
     *
     * Client‑side:
     *
     * 1. Read `NextKey` (ML‑KEM public key bytes) from storage.
     * 2. Sign your extrinsic so that it can be executed when added to the pool,
     * i.e. you may need to increment the nonce if you submit using the same account.
     * 3. `commitment = Hashing::hash(signed_extrinsic)`.
     * 4. Encrypt:
     *
     * plaintext = signed_extrinsic
     *
     * with ML‑KEM‑768 + XChaCha20‑Poly1305, producing
     *
     * ciphertext = [u16 kem_len] || kem_ct || nonce24 || aead_ct
     *
     */
    "submit_encrypted": Anonymize<I2u5b4034ft9hp>;
    /**
     * Marks a submission as failed to decrypt and removes it from storage.
     *
     * Called by the block author when decryption fails at any stage (e.g., ML-KEM decapsulate
     * failed, AEAD decrypt failed, invalid ciphertext format, etc.). This allows clients to be
     * notified of decryption failures through on-chain events.
     *
     * # Arguments
     *
     * * `id` - The wrapper id (hash of (author, commitment, ciphertext))
     * * `reason` - Human-readable reason for the decryption failure (e.g., "ML-KEM decapsulate failed")
     */
    "mark_decryption_failed": Anonymize<I602p6mm30elei>;
}>;
export type Idkfsqnep2hpeb = {
    "public_key": Binary;
};
export type I2u5b4034ft9hp = {
    "commitment": FixedSizeBinary<32>;
    "ciphertext": Binary;
};
export type I4v2u7504g53eo = AnonymousEnum<{
    "System": Anonymize<Iekve0i6djpd9f>;
    "Timestamp": Anonymize<I7d75gqfg6jh9c>;
    "Grandpa": Anonymize<Ibck9ekr2i96uj>;
    "Balances": Anonymize<I9svldsp29mh87>;
    "SubtensorModule": Anonymize<I5cgnbuovlct77>;
    "Utility": Anonymize<I3g440un09hrpf>;
    "Sudo": Anonymize<I5o7g6ruskmlii>;
    "Multisig": Anonymize<I52kfmvokp9f61>;
    "Preimage": Anonymize<If81ks88t5mpk5>;
    "Scheduler": Anonymize<I4nm6fqi0gsbdn>;
    "Proxy": Anonymize<Idpgc64kel5m98>;
    "Registry": Anonymize<Ifml9odtov51l3>;
    "Commitments": Anonymize<I5bqhvupj937er>;
    "AdminUtils": Anonymize<Iemvun0dttbcqs>;
    "SafeMode": Anonymize<I48eehof2eias5>;
    "Ethereum": Anonymize<I3lo8is2egp8k4>;
    "EVM": Anonymize<Iafltn68socb5h>;
    "BaseFee": Anonymize<I2aqcjbjlffus>;
    "Drand": Anonymize<Ibdf4fkp7qcokd>;
    "Crowdloan": Anonymize<Ic9v5nofc059ih>;
    "Swap": Anonymize<Id0qcnu1chac12>;
    "Contracts": Anonymize<I6jivj2j5qp8sa>;
    "MevShield": Anonymize<I1o2fkthdkdbjl>;
}>;
export type Iaqet9jc3ihboe = {
    "header": Anonymize<Ic952bubvq4k7d>;
    "extrinsics": Anonymize<Itom7fk49o0c9>;
};
export type Ic952bubvq4k7d = {
    "parent_hash": FixedSizeBinary<32>;
    "number": number;
    "state_root": FixedSizeBinary<32>;
    "extrinsics_root": FixedSizeBinary<32>;
    "digest": Anonymize<I4mddgoa69c0a2>;
};
export type I2v50gu3s1aqk6 = AnonymousEnum<{
    "AllExtrinsics": undefined;
    "OnlyInherents": undefined;
}>;
export type I2478jmjgv26ib = ResultPayload<Anonymize<I9dkdd0svp2anm>, Anonymize<I5nrjkj9qumobs>>;
export type I5nrjkj9qumobs = AnonymousEnum<{
    "Invalid": Enum<{
        "Call": undefined;
        "Payment": undefined;
        "Future": undefined;
        "Stale": undefined;
        "BadProof": undefined;
        "AncientBirthBlock": undefined;
        "ExhaustsResources": undefined;
        "Custom": number;
        "BadMandatory": undefined;
        "MandatoryValidation": undefined;
        "BadSigner": undefined;
        "IndeterminateImplicit": undefined;
        "UnknownOrigin": undefined;
    }>;
    "Unknown": TransactionValidityUnknownTransaction;
}>;
export type TransactionValidityUnknownTransaction = Enum<{
    "CannotLookup": undefined;
    "NoUnsignedValidator": undefined;
    "Custom": number;
}>;
export declare const TransactionValidityUnknownTransaction: GetEnum<TransactionValidityUnknownTransaction>;
export type If7uv525tdvv7a = Array<[FixedSizeBinary<8>, Binary]>;
export type I2an1fs2eiebjp = {
    "okay": boolean;
    "fatal_error": boolean;
    "errors": Anonymize<If7uv525tdvv7a>;
};
export type Ie9sr1iqcg3cgm = ResultPayload<undefined, string>;
export type I1mqgk2tmnn9i2 = (string) | undefined;
export type I6lr8sctk0bi4e = Array<string>;
export type TransactionValidityTransactionSource = Enum<{
    "InBlock": undefined;
    "Local": undefined;
    "External": undefined;
}>;
export declare const TransactionValidityTransactionSource: GetEnum<TransactionValidityTransactionSource>;
export type I9ask1o4tfvcvs = ResultPayload<Anonymize<I6g5lcd9vf2cr0>, Anonymize<I5nrjkj9qumobs>>;
export type I6g5lcd9vf2cr0 = {
    "priority": bigint;
    "requires": Anonymize<Itom7fk49o0c9>;
    "provides": Anonymize<Itom7fk49o0c9>;
    "longevity": bigint;
    "propagate": boolean;
};
export type Icerf8h8pdu8ss = (Array<[Binary, FixedSizeBinary<4>]>) | undefined;
export type I6spmpef2c7svf = {
    "weight": Anonymize<I4q39t5hn830vp>;
    "class": DispatchClass;
    "partial_fee": bigint;
};
export type Iei2mvq0mjvt81 = {
    "inclusion_fee"?: ({
        "base_fee": bigint;
        "len_fee": bigint;
        "adjusted_weight_fee": bigint;
    }) | undefined;
    "tip": bigint;
};
export type If08sfhqn8ujfr = {
    "balance": Anonymize<I4totqt881mlti>;
    "nonce": Anonymize<I4totqt881mlti>;
};
export type I3dj14b7k3rkm5 = (Anonymize<I1bsfec060j604>) | undefined;
export type Ic5egmm215ml6k = (Anonymize<Idg0qi60379vnh>) | undefined;
export type Isie6rb08fgbf = ResultPayload<Anonymize<I7ag5k7bmmgq3j>, Anonymize<I6orop8m3bqhqc>>;
export type I7ag5k7bmmgq3j = {
    "exit_reason": Anonymize<Iag9iovb9j5ijo>;
    "value": Binary;
    "used_gas": Anonymize<I8mgv59to1hjie>;
    "weight_info"?: Anonymize<Ib72ii9bshc8f5>;
    "logs": Anonymize<Ids7ng2qsv7snu>;
};
export type I8mgv59to1hjie = {
    "standard": Anonymize<I4totqt881mlti>;
    "effective": Anonymize<I4totqt881mlti>;
};
export type Ib72ii9bshc8f5 = ({
    "ref_time_limit"?: Anonymize<I35p85j063s0il>;
    "proof_size_limit"?: Anonymize<I35p85j063s0il>;
    "ref_time_usage"?: Anonymize<I35p85j063s0il>;
    "proof_size_usage"?: Anonymize<I35p85j063s0il>;
}) | undefined;
export type Inotr0scdlvht = ResultPayload<Anonymize<Ie3rl25flint9v>, Anonymize<I6orop8m3bqhqc>>;
export type Ie3rl25flint9v = {
    "exit_reason": Anonymize<Iag9iovb9j5ijo>;
    "value": FixedSizeBinary<20>;
    "used_gas": Anonymize<I8mgv59to1hjie>;
    "weight_info"?: Anonymize<Ib72ii9bshc8f5>;
    "logs": Anonymize<Ids7ng2qsv7snu>;
};
export type I5fvdd841odbi3 = (Anonymize<Ib0hfhkohlekcj>) | undefined;
export type I35vouom6s9r2 = (Anonymize<I32lgu058i52q9>) | undefined;
export type Ie6kgk6f04rsvk = (Anonymize<Ie7atdsih6q14b>) | undefined;
export type Ifgqf2rskq94om = [Anonymize<I5fvdd841odbi3>, Anonymize<I35vouom6s9r2>, Anonymize<Ie6kgk6f04rsvk>];
export type I7aold6s47n103 = [Anonymize<I5fvdd841odbi3>, Anonymize<Ie6kgk6f04rsvk>];
export type Ickqvsc42g7jaj = {
    "gas_consumed": Anonymize<I4q39t5hn830vp>;
    "gas_required": Anonymize<I4q39t5hn830vp>;
    "storage_deposit": Anonymize<If7bmpttbdmqu4>;
    "debug_message": Binary;
    "result": ResultPayload<Anonymize<I620n7irgfspm4>, Anonymize<I6orop8m3bqhqc>>;
    "events"?: Anonymize<Ie922qsegrja>;
};
export type If7bmpttbdmqu4 = AnonymousEnum<{
    "Refund": bigint;
    "Charge": bigint;
}>;
export type I620n7irgfspm4 = {
    "flags": number;
    "data": Binary;
};
export type Ie922qsegrja = (Anonymize<Idl4dgic8j220i>) | undefined;
export type I9sijb8gfrns29 = AnonymousEnum<{
    "Upload": Binary;
    "Existing": FixedSizeBinary<32>;
}>;
export type I62367b4vvbr1u = {
    "gas_consumed": Anonymize<I4q39t5hn830vp>;
    "gas_required": Anonymize<I4q39t5hn830vp>;
    "storage_deposit": Anonymize<If7bmpttbdmqu4>;
    "debug_message": Binary;
    "result": ResultPayload<{
        "result": Anonymize<I620n7irgfspm4>;
        "account_id": SS58String;
    }, Anonymize<I6orop8m3bqhqc>>;
    "events"?: Anonymize<Ie922qsegrja>;
};
export type I95an1md3ghn7t = ResultPayload<{
    "code_hash": FixedSizeBinary<32>;
    "deposit": bigint;
}, Anonymize<I6orop8m3bqhqc>>;
export type I9u22scd4ksrjm = ResultPayload<Anonymize<Iabpgqcjikia83>, Enum<{
    "DoesntExist": undefined;
    "KeyDecodingFailed": undefined;
    "MigrationInProgress": undefined;
}>>;
export type Ibil6rvg3saeb3 = Array<Anonymize<I4dh58q3tkaf4j>>;
export type I4dh58q3tkaf4j = {
    "delegate_ss58": SS58String;
    "take": number;
    "nominators": Array<[SS58String, Anonymize<If9jidduiuq7vv>]>;
    "owner_ss58": SS58String;
    "registrations": Anonymize<Icgljjb6j82uhn>;
    "validator_permits": Anonymize<Icgljjb6j82uhn>;
    "return_per_1000": bigint;
    "total_daily_return": bigint;
};
export type I97cs1i8k87lnm = (Anonymize<I4dh58q3tkaf4j>) | undefined;
export type I874e758ge6pa9 = Array<[Anonymize<I4dh58q3tkaf4j>, Anonymize<I4ojmnsk1dchql>]>;
export type I86tq0h1o8f1g5 = Array<Anonymize<I89nj65vjrv1i8>>;
export type I89nj65vjrv1i8 = {
    "hotkey": SS58String;
    "coldkey": SS58String;
    "uid": number;
    "netuid": number;
    "active": boolean;
    "axon_info": Anonymize<Ibc83gdj8hi3rc>;
    "prometheus_info": Anonymize<Iaap7oohdmr1sb>;
    "stake": Anonymize<Iba9inugg1atvo>;
    "rank": number;
    "emission": bigint;
    "incentive": number;
    "consensus": number;
    "trust": number;
    "validator_trust": number;
    "dividends": number;
    "last_update": bigint;
    "validator_permit": boolean;
    "weights": Anonymize<I95g6i7ilua7lq>;
    "bonds": Anonymize<I95g6i7ilua7lq>;
    "pruning_score": number;
};
export type Iba9inugg1atvo = Array<Anonymize<I95l2k9b1re95f>>;
export type I78cq8c9mego2f = (Anonymize<I89nj65vjrv1i8>) | undefined;
export type I64hm01ml98m4p = Array<Anonymize<If8j022vmi07bv>>;
export type If8j022vmi07bv = {
    "hotkey": SS58String;
    "coldkey": SS58String;
    "uid": number;
    "netuid": number;
    "active": boolean;
    "axon_info": Anonymize<Ibc83gdj8hi3rc>;
    "prometheus_info": Anonymize<Iaap7oohdmr1sb>;
    "stake": Anonymize<Iba9inugg1atvo>;
    "rank": number;
    "emission": bigint;
    "incentive": number;
    "consensus": number;
    "trust": number;
    "validator_trust": number;
    "dividends": number;
    "last_update": bigint;
    "validator_permit": boolean;
    "pruning_score": number;
};
export type I3gjbugrk45her = (Anonymize<If8j022vmi07bv>) | undefined;
export type I9nvi04b7jiso4 = ({
    "netuid": number;
    "rho": number;
    "kappa": number;
    "difficulty": bigint;
    "immunity_period": number;
    "max_allowed_validators": number;
    "min_allowed_weights": number;
    "max_weights_limit": number;
    "scaling_law_power": number;
    "subnetwork_n": number;
    "max_allowed_uids": number;
    "blocks_since_last_step": bigint;
    "tempo": number;
    "network_modality": number;
    "network_connect": Anonymize<I95g6i7ilua7lq>;
    "emission_values": bigint;
    "burn": bigint;
    "owner": SS58String;
}) | undefined;
export type I6s1052v0hl6mr = Array<Anonymize<I9nvi04b7jiso4>>;
export type I31p8sd8onusg0 = ({
    "netuid": number;
    "rho": number;
    "kappa": number;
    "difficulty": bigint;
    "immunity_period": number;
    "max_allowed_validators": number;
    "min_allowed_weights": number;
    "max_weights_limit": number;
    "scaling_law_power": number;
    "subnetwork_n": number;
    "max_allowed_uids": number;
    "blocks_since_last_step": bigint;
    "tempo": number;
    "network_modality": number;
    "network_connect": Anonymize<I95g6i7ilua7lq>;
    "emission_value": bigint;
    "burn": bigint;
    "owner": SS58String;
    "identity"?: Anonymize<I3m38saj8mvtpv>;
}) | undefined;
export type I2vgg418k9gfnm = Array<Anonymize<I31p8sd8onusg0>>;
export type I7dp6t7k7a8r36 = ({
    "rho": number;
    "kappa": number;
    "immunity_period": number;
    "min_allowed_weights": number;
    "max_weights_limit": number;
    "tempo": number;
    "min_difficulty": bigint;
    "max_difficulty": bigint;
    "weights_version": bigint;
    "weights_rate_limit": bigint;
    "adjustment_interval": number;
    "activity_cutoff": number;
    "registration_allowed": boolean;
    "target_regs_per_interval": number;
    "min_burn": bigint;
    "max_burn": bigint;
    "bonds_moving_avg": bigint;
    "max_regs_per_block": number;
    "serving_rate_limit": bigint;
    "max_validators": number;
    "adjustment_alpha": bigint;
    "difficulty": bigint;
    "commit_reveal_period": bigint;
    "commit_reveal_weights_enabled": boolean;
    "alpha_high": number;
    "alpha_low": number;
    "liquid_alpha_enabled": boolean;
}) | undefined;
export type Ibtpedbm9ai3hp = ({
    "rho": number;
    "kappa": number;
    "immunity_period": number;
    "min_allowed_weights": number;
    "max_weights_limit": number;
    "tempo": number;
    "min_difficulty": bigint;
    "max_difficulty": bigint;
    "weights_version": bigint;
    "weights_rate_limit": bigint;
    "adjustment_interval": number;
    "activity_cutoff": number;
    "registration_allowed": boolean;
    "target_regs_per_interval": number;
    "min_burn": bigint;
    "max_burn": bigint;
    "bonds_moving_avg": bigint;
    "max_regs_per_block": number;
    "serving_rate_limit": bigint;
    "max_validators": number;
    "adjustment_alpha": bigint;
    "difficulty": bigint;
    "commit_reveal_period": bigint;
    "commit_reveal_weights_enabled": boolean;
    "alpha_high": number;
    "alpha_low": number;
    "liquid_alpha_enabled": boolean;
    "alpha_sigmoid_steepness": bigint;
    "yuma_version": number;
    "subnet_is_active": boolean;
    "transfers_enabled": boolean;
    "bonds_reset_enabled": boolean;
    "user_liquidity_enabled": boolean;
}) | undefined;
export type I8ivaf995pho4u = Array<Anonymize<Ibjoh8vk2j7bqd>>;
export type Ibjoh8vk2j7bqd = ({
    "netuid": number;
    "owner_hotkey": SS58String;
    "owner_coldkey": SS58String;
    "subnet_name": Anonymize<Icgljjb6j82uhn>;
    "token_symbol": Anonymize<Icgljjb6j82uhn>;
    "tempo": number;
    "last_step": bigint;
    "blocks_since_last_step": bigint;
    "emission": bigint;
    "alpha_in": bigint;
    "alpha_out": bigint;
    "tao_in": bigint;
    "alpha_out_emission": bigint;
    "alpha_in_emission": bigint;
    "tao_in_emission": bigint;
    "pending_alpha_emission": bigint;
    "pending_root_emission": bigint;
    "subnet_volume": bigint;
    "network_registered_at": bigint;
    "subnet_identity"?: Anonymize<I3m38saj8mvtpv>;
    "moving_price": bigint;
}) | undefined;
export type Icr6rj04unermu = Array<Anonymize<I5gfdo8kg6rloq>>;
export type I5gfdo8kg6rloq = ({
    "netuid": number;
    "name": Anonymize<Icgljjb6j82uhn>;
    "symbol": Anonymize<Icgljjb6j82uhn>;
    "identity"?: Anonymize<I3m38saj8mvtpv>;
    "network_registered_at": bigint;
    "owner_hotkey": SS58String;
    "owner_coldkey": SS58String;
    "block": bigint;
    "tempo": number;
    "last_step": bigint;
    "blocks_since_last_step": bigint;
    "subnet_emission": bigint;
    "alpha_in": bigint;
    "alpha_out": bigint;
    "tao_in": bigint;
    "alpha_out_emission": bigint;
    "alpha_in_emission": bigint;
    "tao_in_emission": bigint;
    "pending_alpha_emission": bigint;
    "pending_root_emission": bigint;
    "subnet_volume": bigint;
    "moving_price": bigint;
    "rho": number;
    "kappa": number;
    "min_allowed_weights": number;
    "max_weights_limit": number;
    "weights_version": bigint;
    "weights_rate_limit": bigint;
    "activity_cutoff": number;
    "max_validators": number;
    "num_uids": number;
    "max_uids": number;
    "burn": bigint;
    "difficulty": bigint;
    "registration_allowed": boolean;
    "pow_registration_allowed": boolean;
    "immunity_period": number;
    "min_difficulty": bigint;
    "max_difficulty": bigint;
    "min_burn": bigint;
    "max_burn": bigint;
    "adjustment_alpha": bigint;
    "adjustment_interval": number;
    "target_regs_per_interval": number;
    "max_regs_per_block": number;
    "serving_rate_limit": bigint;
    "commit_reveal_weights_enabled": boolean;
    "commit_reveal_period": bigint;
    "liquid_alpha_enabled": boolean;
    "alpha_high": number;
    "alpha_low": number;
    "bonds_moving_avg": bigint;
    "hotkeys": Anonymize<Ia2lhg7l2hilo3>;
    "coldkeys": Anonymize<Ia2lhg7l2hilo3>;
    "identities": Anonymize<Iaf9dcc3cspgj7>;
    "axons": Anonymize<Iemjgg2q8584r9>;
    "active": Anonymize<I9eir063evtfb6>;
    "validator_permit": Anonymize<I9eir063evtfb6>;
    "pruning_score": Anonymize<Icgljjb6j82uhn>;
    "last_update": Anonymize<Iafqnechp3omqg>;
    "emission": Anonymize<Iafqnechp3omqg>;
    "dividends": Anonymize<Icgljjb6j82uhn>;
    "incentives": Anonymize<Icgljjb6j82uhn>;
    "consensus": Anonymize<Icgljjb6j82uhn>;
    "trust": Anonymize<Icgljjb6j82uhn>;
    "rank": Anonymize<Icgljjb6j82uhn>;
    "block_at_registration": Anonymize<Iafqnechp3omqg>;
    "alpha_stake": Anonymize<Iafqnechp3omqg>;
    "tao_stake": Anonymize<Iafqnechp3omqg>;
    "total_stake": Anonymize<Iafqnechp3omqg>;
    "tao_dividends_per_hotkey": Anonymize<Iba9inugg1atvo>;
    "alpha_dividends_per_hotkey": Anonymize<Iba9inugg1atvo>;
}) | undefined;
export type Iaf9dcc3cspgj7 = Array<(Anonymize<Ifjlj958aeheic>) | undefined>;
export type Iemjgg2q8584r9 = Array<Anonymize<Ibc83gdj8hi3rc>>;
export type I2u4s5o1c0r3fu = ({
    "netuid": number;
    "hotkeys": Anonymize<Ia2lhg7l2hilo3>;
    "coldkeys": Anonymize<Ia2lhg7l2hilo3>;
    "active": Anonymize<I9eir063evtfb6>;
    "validator_permit": Anonymize<I9eir063evtfb6>;
    "pruning_score": Anonymize<Icgljjb6j82uhn>;
    "last_update": Anonymize<Iafqnechp3omqg>;
    "emission": Anonymize<Iafqnechp3omqg>;
    "dividends": Anonymize<Icgljjb6j82uhn>;
    "incentives": Anonymize<Icgljjb6j82uhn>;
    "consensus": Anonymize<Icgljjb6j82uhn>;
    "trust": Anonymize<Icgljjb6j82uhn>;
    "rank": Anonymize<Icgljjb6j82uhn>;
    "block_at_registration": Anonymize<Iafqnechp3omqg>;
    "alpha_stake": Anonymize<Iafqnechp3omqg>;
    "tao_stake": Anonymize<Iafqnechp3omqg>;
    "total_stake": Anonymize<Iafqnechp3omqg>;
    "emission_history": Array<Anonymize<Iafqnechp3omqg>>;
}) | undefined;
export type Ic0g2vnp5r296p = ({
    "netuid": number;
    "name"?: Anonymize<I35lk2003i8c8g>;
    "symbol"?: Anonymize<I35lk2003i8c8g>;
    "identity"?: (Anonymize<I3m38saj8mvtpv>) | undefined;
    "network_registered_at"?: Anonymize<I35p85j063s0il>;
    "owner_hotkey"?: Anonymize<Ihfphjolmsqq1>;
    "owner_coldkey"?: Anonymize<Ihfphjolmsqq1>;
    "block"?: Anonymize<I35p85j063s0il>;
    "tempo"?: Anonymize<I4arjljr6dpflb>;
    "last_step"?: Anonymize<I35p85j063s0il>;
    "blocks_since_last_step"?: Anonymize<I35p85j063s0il>;
    "subnet_emission"?: Anonymize<I35p85j063s0il>;
    "alpha_in"?: Anonymize<I35p85j063s0il>;
    "alpha_out"?: Anonymize<I35p85j063s0il>;
    "tao_in"?: Anonymize<I35p85j063s0il>;
    "alpha_out_emission"?: Anonymize<I35p85j063s0il>;
    "alpha_in_emission"?: Anonymize<I35p85j063s0il>;
    "tao_in_emission"?: Anonymize<I35p85j063s0il>;
    "pending_alpha_emission"?: Anonymize<I35p85j063s0il>;
    "pending_root_emission"?: Anonymize<I35p85j063s0il>;
    "subnet_volume"?: Anonymize<I35p85j063s0il>;
    "moving_price"?: Anonymize<I35p85j063s0il>;
    "rho"?: Anonymize<I4arjljr6dpflb>;
    "kappa"?: Anonymize<I4arjljr6dpflb>;
    "min_allowed_weights"?: Anonymize<I4arjljr6dpflb>;
    "max_weights_limit"?: Anonymize<I4arjljr6dpflb>;
    "weights_version"?: Anonymize<I35p85j063s0il>;
    "weights_rate_limit"?: Anonymize<I35p85j063s0il>;
    "activity_cutoff"?: Anonymize<I4arjljr6dpflb>;
    "max_validators"?: Anonymize<I4arjljr6dpflb>;
    "num_uids"?: Anonymize<I4arjljr6dpflb>;
    "max_uids"?: Anonymize<I4arjljr6dpflb>;
    "burn"?: Anonymize<I35p85j063s0il>;
    "difficulty"?: Anonymize<I35p85j063s0il>;
    "registration_allowed"?: (boolean) | undefined;
    "pow_registration_allowed"?: (boolean) | undefined;
    "immunity_period"?: Anonymize<I4arjljr6dpflb>;
    "min_difficulty"?: Anonymize<I35p85j063s0il>;
    "max_difficulty"?: Anonymize<I35p85j063s0il>;
    "min_burn"?: Anonymize<I35p85j063s0il>;
    "max_burn"?: Anonymize<I35p85j063s0il>;
    "adjustment_alpha"?: Anonymize<I35p85j063s0il>;
    "adjustment_interval"?: Anonymize<I4arjljr6dpflb>;
    "target_regs_per_interval"?: Anonymize<I4arjljr6dpflb>;
    "max_regs_per_block"?: Anonymize<I4arjljr6dpflb>;
    "serving_rate_limit"?: Anonymize<I35p85j063s0il>;
    "commit_reveal_weights_enabled"?: (boolean) | undefined;
    "commit_reveal_period"?: Anonymize<I35p85j063s0il>;
    "liquid_alpha_enabled"?: (boolean) | undefined;
    "alpha_high"?: Anonymize<I4arjljr6dpflb>;
    "alpha_low"?: Anonymize<I4arjljr6dpflb>;
    "bonds_moving_avg"?: Anonymize<I35p85j063s0il>;
    "hotkeys"?: (Anonymize<Ia2lhg7l2hilo3>) | undefined;
    "coldkeys"?: (Anonymize<Ia2lhg7l2hilo3>) | undefined;
    "identities"?: (Anonymize<Iaf9dcc3cspgj7>) | undefined;
    "axons"?: (Anonymize<Iemjgg2q8584r9>) | undefined;
    "active"?: (Anonymize<I9eir063evtfb6>) | undefined;
    "validator_permit"?: (Anonymize<I9eir063evtfb6>) | undefined;
    "pruning_score"?: Anonymize<I35lk2003i8c8g>;
    "last_update"?: (Anonymize<Iafqnechp3omqg>) | undefined;
    "emission"?: (Anonymize<Iafqnechp3omqg>) | undefined;
    "dividends"?: Anonymize<I35lk2003i8c8g>;
    "incentives"?: Anonymize<I35lk2003i8c8g>;
    "consensus"?: Anonymize<I35lk2003i8c8g>;
    "trust"?: Anonymize<I35lk2003i8c8g>;
    "rank"?: Anonymize<I35lk2003i8c8g>;
    "block_at_registration"?: (Anonymize<Iafqnechp3omqg>) | undefined;
    "alpha_stake"?: (Anonymize<Iafqnechp3omqg>) | undefined;
    "tao_stake"?: (Anonymize<Iafqnechp3omqg>) | undefined;
    "total_stake"?: (Anonymize<Iafqnechp3omqg>) | undefined;
    "tao_dividends_per_hotkey"?: (Anonymize<Iba9inugg1atvo>) | undefined;
    "alpha_dividends_per_hotkey"?: (Anonymize<Iba9inugg1atvo>) | undefined;
    "validators"?: Anonymize<I35lk2003i8c8g>;
    "commitments"?: (Array<[SS58String, Anonymize<Icgljjb6j82uhn>]>) | undefined;
}) | undefined;
export type Ic9fkrj2ggjleq = Array<Anonymize<I66h6oadnuebe>>;
export type I66h6oadnuebe = {
    "hotkey": SS58String;
    "coldkey": SS58String;
    "netuid": number;
    "stake": bigint;
    "locked": bigint;
    "emission": bigint;
    "tao_emission": bigint;
    "drain": bigint;
    "is_registered": boolean;
};
export type Ifi9cmevnosufh = Array<[SS58String, Anonymize<Ic9fkrj2ggjleq>]>;
export type I1i5jfmqcsjper = (Anonymize<I66h6oadnuebe>) | undefined;
export type I3pbrjdm4vnbsa = (Anonymize<I6ouflveob4eli>) | undefined;
export type Iems84l8lk2v0c = {
    "slot_duration": bigint;
    "epoch_length": bigint;
    "c": Anonymize<I200n1ov5tbcvr>;
    "authorities": Anonymize<I3geksg000c171>;
    "randomness": FixedSizeBinary<32>;
    "allowed_slots": BabeAllowedSlots;
};
export type I200n1ov5tbcvr = FixedSizeArray<2, bigint>;
export type BabeAllowedSlots = Enum<{
    "PrimarySlots": undefined;
    "PrimaryAndSecondaryPlainSlots": undefined;
    "PrimaryAndSecondaryVRFSlots": undefined;
}>;
export declare const BabeAllowedSlots: GetEnum<BabeAllowedSlots>;
export type I1r5ke30ueqo0r = {
    "epoch_index": bigint;
    "start_slot": bigint;
    "duration": bigint;
    "authorities": Anonymize<I3geksg000c171>;
    "randomness": FixedSizeBinary<32>;
    "config": Anonymize<I8jnd4d8ip6djo>;
};
export type I8jnd4d8ip6djo = {
    "c": Anonymize<I200n1ov5tbcvr>;
    "allowed_slots": BabeAllowedSlots;
};
export type I68ii5ik8avr9o = {
    "offender": FixedSizeBinary<32>;
    "slot": bigint;
    "first_header": Anonymize<Ic952bubvq4k7d>;
    "second_header": Anonymize<Ic952bubvq4k7d>;
};
export type I8slfm2rri67ri = Array<{
    "netuid": number;
    "price": bigint;
}>;
export type I34n2itmpoq7on = {
    "tao_amount": bigint;
    "alpha_amount": bigint;
    "tao_fee": bigint;
    "alpha_fee": bigint;
    "tao_slippage": bigint;
    "alpha_slippage": bigint;
};
export type Icp0d89tlsgb4c = Array<{
    "phase": Phase;
    "event": Enum<{
        "System": Anonymize<I336ogc4kolkam>;
        "Sudo": Anonymize<I6ntn47ia3efe1>;
        "Assets": Anonymize<Id7glfm578e80n>;
        "Balances": Anonymize<Iao8h4hv7atnq3>;
        "TransactionPayment": TransactionPaymentEvent;
        "Grandpa": GrandpaEvent;
        "Indices": IndicesEvent;
        "Democracy": Anonymize<Ia7dnqubar6kb0>;
        "Council": Anonymize<Iec6lsg8g36jn6>;
        "Vesting": VestingEvent;
        "Elections": Anonymize<I4iamd5rd51ec2>;
        "ElectionProviderMultiPhase": Anonymize<Iaf9qcn9c4uvq1>;
        "Staking": StakingEvent;
        "Session": SessionEvent;
        "Treasury": Anonymize<I6led74bt1hkg5>;
        "Bounties": BountiesEvent;
        "ChildBounties": ChildBountiesEvent;
        "BagsList": BagsListEvent;
        "NominationPools": Anonymize<Id9v43dv1m5j6r>;
        "Scheduler": Anonymize<I93jig937vec0q>;
        "Preimage": PreimageEvent;
        "Offences": OffencesEvent;
        "TxPause": Anonymize<I9ulgod11dfvq5>;
        "ImOnline": Anonymize<I9jqrili6gan6u>;
        "Identity": Anonymize<I9ec49dohok6av>;
        "Utility": Anonymize<I1fgi2uu12f9d9>;
        "Multisig": Anonymize<I1vafc8g7b7gkb>;
        "Ethereum": Anonymize<I510u4q1qqh897>;
        "EVM": Anonymize<I9k071kk4cn1u8>;
        "BaseFee": Anonymize<I3bmatomsds8j7>;
        "Proxy": Anonymize<Ifbmgqcmcn6k0k>;
        "Registration": Anonymize<I4eco4p4dqdnac>;
        "ExecutionUnit": Anonymize<Iau0en1i5l2f3e>;
        "Metagraph": Anonymize<Iespmrk3s62imr>;
        "Marketplace": Anonymize<I9jban0pha1pe7>;
        "Bittensor": undefined;
        "SubAccount": Anonymize<I1mkips9o62jhg>;
        "Notifications": Anonymize<Ia263kraiqgd7u>;
        "AccountProfile": Anonymize<I3pp8f8uhsees6>;
        "Utils": undefined;
        "RankingStorage": Anonymize<If1tghl0loi5k7>;
        "RankingCompute": Anonymize<If1tghl0loi5k7>;
        "RankingValidators": Anonymize<If1tghl0loi5k7>;
        "Credits": Anonymize<Icc8a3tvhmo74f>;
        "ContainerRegistry": Anonymize<I5474kjbb5l04k>;
        "AlphaBridge": Anonymize<Ibdesbk77aplmk>;
        "PalletIp": Anonymize<Ic3avj73bju5u2>;
        "IpfsPallet": Anonymize<I3koatptgmpvu6>;
        "Arion": Anonymize<I146vjraq6ao3p>;
    }>;
    "topics": Anonymize<Ic5m5lp1oioo8r>;
}>;
export type I336ogc4kolkam = AnonymousEnum<{
    /**
     * An extrinsic completed successfully.
     */
    "ExtrinsicSuccess": Anonymize<Ia82mnkmeo2rhc>;
    /**
     * An extrinsic failed.
     */
    "ExtrinsicFailed": Anonymize<I3ivcchssriktc>;
    /**
     * `:code` was updated.
     */
    "CodeUpdated": undefined;
    /**
     * A new account was created.
     */
    "NewAccount": Anonymize<Icbccs0ug47ilf>;
    /**
     * An account was reaped.
     */
    "KilledAccount": Anonymize<Icbccs0ug47ilf>;
    /**
     * On on-chain remark happened.
     */
    "Remarked": Anonymize<I855j4i3kr8ko1>;
    /**
     * An upgrade was authorized.
     */
    "UpgradeAuthorized": Anonymize<Ibgl04rn6nbfm6>;
}>;
export type I3ivcchssriktc = {
    "dispatch_error": Anonymize<Ik9f7r9ibbik9>;
    "dispatch_info": Anonymize<Ic9s8f85vjtncc>;
};
export type Ik9f7r9ibbik9 = AnonymousEnum<{
    "Other": undefined;
    "CannotLookup": undefined;
    "BadOrigin": undefined;
    "Module": Enum<{
        "System": Anonymize<I5o0s7c8q1cc9b>;
        "Timestamp": undefined;
        "Sudo": Anonymize<Iaug04qjhbli00>;
        "RandomnessCollectiveFlip": undefined;
        "Assets": Anonymize<Iapedqb0veh71>;
        "Balances": Anonymize<Idj13i7adlomht>;
        "TransactionPayment": undefined;
        "Authorship": undefined;
        "Babe": Anonymize<Ib6q602k6o213a>;
        "Grandpa": Anonymize<I7q8i0pp1gkas6>;
        "Indices": Anonymize<Icq1825fru3di2>;
        "Democracy": Anonymize<I67neb7i10udig>;
        "Council": Anonymize<Icapevgbpfn5p9>;
        "Vesting": Anonymize<Icof2acl69lq3c>;
        "Elections": Anonymize<I96u72l8br1ego>;
        "ElectionProviderMultiPhase": Anonymize<Idb84kfjd998sl>;
        "Staking": Anonymize<I11137r14aka6n>;
        "Session": Anonymize<I1e07dgbaqd1sq>;
        "Historical": undefined;
        "Treasury": Anonymize<I36uss0m9fpcsf>;
        "Bounties": Anonymize<Ibfvjqqblobf53>;
        "ChildBounties": Anonymize<I4u5ou5u3tthff>;
        "BagsList": Anonymize<Ic35l5bgiij29p>;
        "NominationPools": Anonymize<I2t4hgc65ifdsd>;
        "Scheduler": Anonymize<If7oa8fprnilo5>;
        "Preimage": Anonymize<I1iknkudsdnbks>;
        "Offences": undefined;
        "TxPause": Anonymize<Ifku1elmu8hk3i>;
        "ImOnline": Anonymize<I8kh6j0q1r930d>;
        "Identity": Anonymize<I9mq328955mgb8>;
        "Utility": Anonymize<I8dt2g2hcrgh36>;
        "Multisig": Anonymize<Ia76qmhhg4jvb9>;
        "Ethereum": Anonymize<I1mp6vnoh32l4q>;
        "EVM": Anonymize<Id1ggjaqrb40ns>;
        "EVMChainId": undefined;
        "DynamicFee": undefined;
        "BaseFee": undefined;
        "HotfixSufficients": Anonymize<I9heam5bpv5tbs>;
        "Proxy": Anonymize<Iuvt54ei4cehc>;
        "Registration": Anonymize<Icrjdufvqrbtmp>;
        "ExecutionUnit": Anonymize<I71nupm1pp4kan>;
        "Metagraph": Anonymize<I53vvfsa2djd70>;
        "Marketplace": Anonymize<I2nd8aee8flais>;
        "Bittensor": Anonymize<I5rf3lt9apv0lm>;
        "SubAccount": Anonymize<Ia9d5dr223ctsp>;
        "Notifications": Anonymize<Ifkfiju0fdpbss>;
        "AccountProfile": Anonymize<Idt3seekemq2lp>;
        "Utils": Anonymize<Iec82fol2ihelb>;
        "RankingStorage": Anonymize<I39s6aasu1rhk7>;
        "RankingCompute": Anonymize<I39s6aasu1rhk7>;
        "RankingValidators": Anonymize<I39s6aasu1rhk7>;
        "Credits": Anonymize<I9nflfk0n9gf26>;
        "ContainerRegistry": Anonymize<Iat7q0fl4pe5ha>;
        "AlphaBridge": Anonymize<I59jf7vkud350h>;
        "PalletIp": Anonymize<I6e2rs4vqj03pu>;
        "IpfsPallet": Anonymize<Ibqred97kvmfr3>;
        "Arion": Anonymize<I44vkinnmi502t>;
    }>;
    "ConsumerRemaining": undefined;
    "NoProviders": undefined;
    "TooManyConsumers": undefined;
    "Token": TokenError;
    "Arithmetic": ArithmeticError;
    "Transactional": TransactionalError;
    "Exhausted": undefined;
    "Corruption": undefined;
    "Unavailable": undefined;
    "RootNotAllowed": undefined;
}>;
export type Iapedqb0veh71 = AnonymousEnum<{
    /**
     * Account balance must be greater than or equal to the transfer amount.
     */
    "BalanceLow": undefined;
    /**
     * The account to alter does not exist.
     */
    "NoAccount": undefined;
    /**
     * The signing account has no permission to do the operation.
     */
    "NoPermission": undefined;
    /**
     * The given asset ID is unknown.
     */
    "Unknown": undefined;
    /**
     * The origin account is frozen.
     */
    "Frozen": undefined;
    /**
     * The asset ID is already taken.
     */
    "InUse": undefined;
    /**
     * Invalid witness data given.
     */
    "BadWitness": undefined;
    /**
     * Minimum balance should be non-zero.
     */
    "MinBalanceZero": undefined;
    /**
     * Unable to increment the consumer reference counters on the account. Either no provider
     * reference exists to allow a non-zero balance of a non-self-sufficient asset, or one
     * fewer then the maximum number of consumers has been reached.
     */
    "UnavailableConsumer": undefined;
    /**
     * Invalid metadata given.
     */
    "BadMetadata": undefined;
    /**
     * No approval exists that would allow the transfer.
     */
    "Unapproved": undefined;
    /**
     * The source account would not survive the transfer and it needs to stay alive.
     */
    "WouldDie": undefined;
    /**
     * The asset-account already exists.
     */
    "AlreadyExists": undefined;
    /**
     * The asset-account doesn't have an associated deposit.
     */
    "NoDeposit": undefined;
    /**
     * The operation would result in funds being burned.
     */
    "WouldBurn": undefined;
    /**
     * The asset is a live asset and is actively being used. Usually emit for operations such
     * as `start_destroy` which require the asset to be in a destroying state.
     */
    "LiveAsset": undefined;
    /**
     * The asset is not live, and likely being destroyed.
     */
    "AssetNotLive": undefined;
    /**
     * The asset status is not the expected status.
     */
    "IncorrectStatus": undefined;
    /**
     * The asset should be frozen before the given operation.
     */
    "NotFrozen": undefined;
    /**
     * Callback action resulted in error
     */
    "CallbackFailed": undefined;
    /**
     * The asset ID must be equal to the [`NextAssetId`].
     */
    "BadAssetId": undefined;
}>;
export type Ib6q602k6o213a = AnonymousEnum<{
    /**
     * An equivocation proof provided as part of an equivocation report is invalid.
     */
    "InvalidEquivocationProof": undefined;
    /**
     * A key ownership proof provided as part of an equivocation report is invalid.
     */
    "InvalidKeyOwnershipProof": undefined;
    /**
     * A given equivocation report is valid but already previously reported.
     */
    "DuplicateOffenceReport": undefined;
    /**
     * Submitted configuration is invalid.
     */
    "InvalidConfiguration": undefined;
}>;
export type Icq1825fru3di2 = AnonymousEnum<{
    /**
     * The index was not already assigned.
     */
    "NotAssigned": undefined;
    /**
     * The index is assigned to another account.
     */
    "NotOwner": undefined;
    /**
     * The index was not available.
     */
    "InUse": undefined;
    /**
     * The source and destination accounts are identical.
     */
    "NotTransfer": undefined;
    /**
     * The index is permanent and may not be freed/changed.
     */
    "Permanent": undefined;
}>;
export type I67neb7i10udig = AnonymousEnum<{
    /**
     * Value too low
     */
    "ValueLow": undefined;
    /**
     * Proposal does not exist
     */
    "ProposalMissing": undefined;
    /**
     * Cannot cancel the same proposal twice
     */
    "AlreadyCanceled": undefined;
    /**
     * Proposal already made
     */
    "DuplicateProposal": undefined;
    /**
     * Proposal still blacklisted
     */
    "ProposalBlacklisted": undefined;
    /**
     * Next external proposal not simple majority
     */
    "NotSimpleMajority": undefined;
    /**
     * Invalid hash
     */
    "InvalidHash": undefined;
    /**
     * No external proposal
     */
    "NoProposal": undefined;
    /**
     * Identity may not veto a proposal twice
     */
    "AlreadyVetoed": undefined;
    /**
     * Vote given for invalid referendum
     */
    "ReferendumInvalid": undefined;
    /**
     * No proposals waiting
     */
    "NoneWaiting": undefined;
    /**
     * The given account did not vote on the referendum.
     */
    "NotVoter": undefined;
    /**
     * The actor has no permission to conduct the action.
     */
    "NoPermission": undefined;
    /**
     * The account is already delegating.
     */
    "AlreadyDelegating": undefined;
    /**
     * Too high a balance was provided that the account cannot afford.
     */
    "InsufficientFunds": undefined;
    /**
     * The account is not currently delegating.
     */
    "NotDelegating": undefined;
    /**
     * The account currently has votes attached to it and the operation cannot succeed until
     * these are removed, either through `unvote` or `reap_vote`.
     */
    "VotesExist": undefined;
    /**
     * The instant referendum origin is currently disallowed.
     */
    "InstantNotAllowed": undefined;
    /**
     * Delegation to oneself makes no sense.
     */
    "Nonsense": undefined;
    /**
     * Invalid upper bound.
     */
    "WrongUpperBound": undefined;
    /**
     * Maximum number of votes reached.
     */
    "MaxVotesReached": undefined;
    /**
     * Maximum number of items reached.
     */
    "TooMany": undefined;
    /**
     * Voting period too low
     */
    "VotingPeriodLow": undefined;
    /**
     * The preimage does not exist.
     */
    "PreimageNotExist": undefined;
}>;
export type Icapevgbpfn5p9 = AnonymousEnum<{
    /**
     * Account is not a member
     */
    "NotMember": undefined;
    /**
     * Duplicate proposals not allowed
     */
    "DuplicateProposal": undefined;
    /**
     * Proposal must exist
     */
    "ProposalMissing": undefined;
    /**
     * Mismatched index
     */
    "WrongIndex": undefined;
    /**
     * Duplicate vote ignored
     */
    "DuplicateVote": undefined;
    /**
     * Members are already initialized!
     */
    "AlreadyInitialized": undefined;
    /**
     * The close call was made too early, before the end of the voting.
     */
    "TooEarly": undefined;
    /**
     * There can only be a maximum of `MaxProposals` active proposals.
     */
    "TooManyProposals": undefined;
    /**
     * The given weight bound for the proposal was too low.
     */
    "WrongProposalWeight": undefined;
    /**
     * The given length bound for the proposal was too low.
     */
    "WrongProposalLength": undefined;
    /**
     * Prime account is not a member
     */
    "PrimeAccountNotMember": undefined;
}>;
export type Icof2acl69lq3c = AnonymousEnum<{
    /**
     * The account given is not vesting.
     */
    "NotVesting": undefined;
    /**
     * The account already has `MaxVestingSchedules` count of schedules and thus
     * cannot add another one. Consider merging existing schedules in order to add another.
     */
    "AtMaxVestingSchedules": undefined;
    /**
     * Amount being transferred is too low to create a vesting schedule.
     */
    "AmountLow": undefined;
    /**
     * An index was out of bounds of the vesting schedules.
     */
    "ScheduleIndexOutOfBounds": undefined;
    /**
     * Failed to create a new schedule because some parameter was invalid.
     */
    "InvalidScheduleParams": undefined;
}>;
export type I96u72l8br1ego = AnonymousEnum<{
    /**
     * Cannot vote when no candidates or members exist.
     */
    "UnableToVote": undefined;
    /**
     * Must vote for at least one candidate.
     */
    "NoVotes": undefined;
    /**
     * Cannot vote more than candidates.
     */
    "TooManyVotes": undefined;
    /**
     * Cannot vote more than maximum allowed.
     */
    "MaximumVotesExceeded": undefined;
    /**
     * Cannot vote with stake less than minimum balance.
     */
    "LowBalance": undefined;
    /**
     * Voter can not pay voting bond.
     */
    "UnableToPayBond": undefined;
    /**
     * Must be a voter.
     */
    "MustBeVoter": undefined;
    /**
     * Duplicated candidate submission.
     */
    "DuplicatedCandidate": undefined;
    /**
     * Too many candidates have been created.
     */
    "TooManyCandidates": undefined;
    /**
     * Member cannot re-submit candidacy.
     */
    "MemberSubmit": undefined;
    /**
     * Runner cannot re-submit candidacy.
     */
    "RunnerUpSubmit": undefined;
    /**
     * Candidate does not have enough funds.
     */
    "InsufficientCandidateFunds": undefined;
    /**
     * Not a member.
     */
    "NotMember": undefined;
    /**
     * The provided count of number of candidates is incorrect.
     */
    "InvalidWitnessData": undefined;
    /**
     * The provided count of number of votes is incorrect.
     */
    "InvalidVoteCount": undefined;
    /**
     * The renouncing origin presented a wrong `Renouncing` parameter.
     */
    "InvalidRenouncing": undefined;
    /**
     * Prediction regarding replacement after member removal is wrong.
     */
    "InvalidReplacement": undefined;
}>;
export type Idb84kfjd998sl = AnonymousEnum<{
    /**
     * Submission was too early.
     */
    "PreDispatchEarlySubmission": undefined;
    /**
     * Wrong number of winners presented.
     */
    "PreDispatchWrongWinnerCount": undefined;
    /**
     * Submission was too weak, score-wise.
     */
    "PreDispatchWeakSubmission": undefined;
    /**
     * The queue was full, and the solution was not better than any of the existing ones.
     */
    "SignedQueueFull": undefined;
    /**
     * The origin failed to pay the deposit.
     */
    "SignedCannotPayDeposit": undefined;
    /**
     * Witness data to dispatchable is invalid.
     */
    "SignedInvalidWitness": undefined;
    /**
     * The signed submission consumes too much weight
     */
    "SignedTooMuchWeight": undefined;
    /**
     * OCW submitted solution for wrong round
     */
    "OcwCallWrongEra": undefined;
    /**
     * Snapshot metadata should exist but didn't.
     */
    "MissingSnapshotMetadata": undefined;
    /**
     * `Self::insert_submission` returned an invalid index.
     */
    "InvalidSubmissionIndex": undefined;
    /**
     * The call is not allowed at this point.
     */
    "CallNotAllowed": undefined;
    /**
     * The fallback failed
     */
    "FallbackFailed": undefined;
    /**
     * Some bound not met
     */
    "BoundNotMet": undefined;
    /**
     * Submitted solution has too many winners
     */
    "TooManyWinners": undefined;
    /**
     * Submission was prepared for a different round.
     */
    "PreDispatchDifferentRound": undefined;
}>;
export type I11137r14aka6n = AnonymousEnum<{
    /**
     * Not a controller account.
     */
    "NotController": undefined;
    /**
     * Not a stash account.
     */
    "NotStash": undefined;
    /**
     * Stash is already bonded.
     */
    "AlreadyBonded": undefined;
    /**
     * Controller is already paired.
     */
    "AlreadyPaired": undefined;
    /**
     * Targets cannot be empty.
     */
    "EmptyTargets": undefined;
    /**
     * Duplicate index.
     */
    "DuplicateIndex": undefined;
    /**
     * Slash record index out of bounds.
     */
    "InvalidSlashIndex": undefined;
    /**
     * Cannot have a validator or nominator role, with value less than the minimum defined by
     * governance (see `MinValidatorBond` and `MinNominatorBond`). If unbonding is the
     * intention, `chill` first to remove one's role as validator/nominator.
     */
    "InsufficientBond": undefined;
    /**
     * Can not schedule more unlock chunks.
     */
    "NoMoreChunks": undefined;
    /**
     * Can not rebond without unlocking chunks.
     */
    "NoUnlockChunk": undefined;
    /**
     * Attempting to target a stash that still has funds.
     */
    "FundedTarget": undefined;
    /**
     * Invalid era to reward.
     */
    "InvalidEraToReward": undefined;
    /**
     * Invalid number of nominations.
     */
    "InvalidNumberOfNominations": undefined;
    /**
     * Items are not sorted and unique.
     */
    "NotSortedAndUnique": undefined;
    /**
     * Rewards for this era have already been claimed for this validator.
     */
    "AlreadyClaimed": undefined;
    /**
     * No nominators exist on this page.
     */
    "InvalidPage": undefined;
    /**
     * Incorrect previous history depth input provided.
     */
    "IncorrectHistoryDepth": undefined;
    /**
     * Incorrect number of slashing spans provided.
     */
    "IncorrectSlashingSpans": undefined;
    /**
     * Internal state has become somehow corrupted and the operation cannot continue.
     */
    "BadState": undefined;
    /**
     * Too many nomination targets supplied.
     */
    "TooManyTargets": undefined;
    /**
     * A nomination target was supplied that was blocked or otherwise not a validator.
     */
    "BadTarget": undefined;
    /**
     * The user has enough bond and thus cannot be chilled forcefully by an external person.
     */
    "CannotChillOther": undefined;
    /**
     * There are too many nominators in the system. Governance needs to adjust the staking
     * settings to keep things safe for the runtime.
     */
    "TooManyNominators": undefined;
    /**
     * There are too many validator candidates in the system. Governance needs to adjust the
     * staking settings to keep things safe for the runtime.
     */
    "TooManyValidators": undefined;
    /**
     * Commission is too low. Must be at least `MinCommission`.
     */
    "CommissionTooLow": undefined;
    /**
     * Some bound is not met.
     */
    "BoundNotMet": undefined;
    /**
     * Used when attempting to use deprecated controller account logic.
     */
    "ControllerDeprecated": undefined;
    /**
     * Cannot reset a ledger.
     */
    "CannotRestoreLedger": undefined;
    /**
     * Provided reward destination is not allowed.
     */
    "RewardDestinationRestricted": undefined;
    /**
     * Not enough funds available to withdraw.
     */
    "NotEnoughFunds": undefined;
    /**
     * Operation not allowed for virtual stakers.
     */
    "VirtualStakerNotAllowed": undefined;
}>;
export type I1e07dgbaqd1sq = AnonymousEnum<{
    /**
     * Invalid ownership proof.
     */
    "InvalidProof": undefined;
    /**
     * No associated validator ID for account.
     */
    "NoAssociatedValidatorId": undefined;
    /**
     * Registered duplicate key.
     */
    "DuplicatedKey": undefined;
    /**
     * No keys are associated with this account.
     */
    "NoKeys": undefined;
    /**
     * Key setting account is not live, so it's impossible to associate keys.
     */
    "NoAccount": undefined;
}>;
export type I36uss0m9fpcsf = AnonymousEnum<{
    /**
     * No proposal, bounty or spend at that index.
     */
    "InvalidIndex": undefined;
    /**
     * Too many approvals in the queue.
     */
    "TooManyApprovals": undefined;
    /**
     * The spend origin is valid but the amount it is allowed to spend is lower than the
     * amount to be spent.
     */
    "InsufficientPermission": undefined;
    /**
     * Proposal has not been approved.
     */
    "ProposalNotApproved": undefined;
    /**
     * The balance of the asset kind is not convertible to the balance of the native asset.
     */
    "FailedToConvertBalance": undefined;
    /**
     * The spend has expired and cannot be claimed.
     */
    "SpendExpired": undefined;
    /**
     * The spend is not yet eligible for payout.
     */
    "EarlyPayout": undefined;
    /**
     * The payment has already been attempted.
     */
    "AlreadyAttempted": undefined;
    /**
     * There was some issue with the mechanism of payment.
     */
    "PayoutError": undefined;
    /**
     * The payout was not yet attempted/claimed.
     */
    "NotAttempted": undefined;
    /**
     * The payment has neither failed nor succeeded yet.
     */
    "Inconclusive": undefined;
}>;
export type Ibfvjqqblobf53 = AnonymousEnum<{
    /**
     * Proposer's balance is too low.
     */
    "InsufficientProposersBalance": undefined;
    /**
     * No proposal or bounty at that index.
     */
    "InvalidIndex": undefined;
    /**
     * The reason given is just too big.
     */
    "ReasonTooBig": undefined;
    /**
     * The bounty status is unexpected.
     */
    "UnexpectedStatus": undefined;
    /**
     * Require bounty curator.
     */
    "RequireCurator": undefined;
    /**
     * Invalid bounty value.
     */
    "InvalidValue": undefined;
    /**
     * Invalid bounty fee.
     */
    "InvalidFee": undefined;
    /**
     * A bounty payout is pending.
     * To cancel the bounty, you must unassign and slash the curator.
     */
    "PendingPayout": undefined;
    /**
     * The bounties cannot be claimed/closed because it's still in the countdown period.
     */
    "Premature": undefined;
    /**
     * The bounty cannot be closed because it has active child bounties.
     */
    "HasActiveChildBounty": undefined;
    /**
     * Too many approvals are already queued.
     */
    "TooManyQueued": undefined;
}>;
export type I4u5ou5u3tthff = AnonymousEnum<{
    /**
     * The parent bounty is not in active state.
     */
    "ParentBountyNotActive": undefined;
    /**
     * The bounty balance is not enough to add new child-bounty.
     */
    "InsufficientBountyBalance": undefined;
    /**
     * Number of child bounties exceeds limit `MaxActiveChildBountyCount`.
     */
    "TooManyChildBounties": undefined;
}>;
export type Ic35l5bgiij29p = AnonymousEnum<{
    /**
     * A error in the list interface implementation.
     */
    "List": BagsListListListError;
}>;
export type BagsListListListError = Enum<{
    "Duplicate": undefined;
    "NotHeavier": undefined;
    "NotInSameBag": undefined;
    "NodeNotFound": undefined;
}>;
export declare const BagsListListListError: GetEnum<BagsListListListError>;
export type I2t4hgc65ifdsd = AnonymousEnum<{
    /**
     * A (bonded) pool id does not exist.
     */
    "PoolNotFound": undefined;
    /**
     * An account is not a member.
     */
    "PoolMemberNotFound": undefined;
    /**
     * A reward pool does not exist. In all cases this is a system logic error.
     */
    "RewardPoolNotFound": undefined;
    /**
     * A sub pool does not exist.
     */
    "SubPoolsNotFound": undefined;
    /**
     * An account is already delegating in another pool. An account may only belong to one
     * pool at a time.
     */
    "AccountBelongsToOtherPool": undefined;
    /**
     * The member is fully unbonded (and thus cannot access the bonded and reward pool
     * anymore to, for example, collect rewards).
     */
    "FullyUnbonding": undefined;
    /**
     * The member cannot unbond further chunks due to reaching the limit.
     */
    "MaxUnbondingLimit": undefined;
    /**
     * None of the funds can be withdrawn yet because the bonding duration has not passed.
     */
    "CannotWithdrawAny": undefined;
    /**
     * The amount does not meet the minimum bond to either join or create a pool.
     *
     * The depositor can never unbond to a value less than `Pallet::depositor_min_bond`. The
     * caller does not have nominating permissions for the pool. Members can never unbond to a
     * value below `MinJoinBond`.
     */
    "MinimumBondNotMet": undefined;
    /**
     * The transaction could not be executed due to overflow risk for the pool.
     */
    "OverflowRisk": undefined;
    /**
     * A pool must be in [`PoolState::Destroying`] in order for the depositor to unbond or for
     * other members to be permissionlessly unbonded.
     */
    "NotDestroying": undefined;
    /**
     * The caller does not have nominating permissions for the pool.
     */
    "NotNominator": undefined;
    /**
     * Either a) the caller cannot make a valid kick or b) the pool is not destroying.
     */
    "NotKickerOrDestroying": undefined;
    /**
     * The pool is not open to join
     */
    "NotOpen": undefined;
    /**
     * The system is maxed out on pools.
     */
    "MaxPools": undefined;
    /**
     * Too many members in the pool or system.
     */
    "MaxPoolMembers": undefined;
    /**
     * The pools state cannot be changed.
     */
    "CanNotChangeState": undefined;
    /**
     * The caller does not have adequate permissions.
     */
    "DoesNotHavePermission": undefined;
    /**
     * Metadata exceeds [`Config::MaxMetadataLen`]
     */
    "MetadataExceedsMaxLen": undefined;
    /**
     * Some error occurred that should never happen. This should be reported to the
     * maintainers.
     */
    "Defensive": Anonymize<Ie2db4l6126rkt>;
    /**
     * Partial unbonding now allowed permissionlessly.
     */
    "PartialUnbondNotAllowedPermissionlessly": undefined;
    /**
     * The pool's max commission cannot be set higher than the existing value.
     */
    "MaxCommissionRestricted": undefined;
    /**
     * The supplied commission exceeds the max allowed commission.
     */
    "CommissionExceedsMaximum": undefined;
    /**
     * The supplied commission exceeds global maximum commission.
     */
    "CommissionExceedsGlobalMaximum": undefined;
    /**
     * Not enough blocks have surpassed since the last commission update.
     */
    "CommissionChangeThrottled": undefined;
    /**
     * The submitted changes to commission change rate are not allowed.
     */
    "CommissionChangeRateNotAllowed": undefined;
    /**
     * There is no pending commission to claim.
     */
    "NoPendingCommission": undefined;
    /**
     * No commission current has been set.
     */
    "NoCommissionCurrentSet": undefined;
    /**
     * Pool id currently in use.
     */
    "PoolIdInUse": undefined;
    /**
     * Pool id provided is not correct/usable.
     */
    "InvalidPoolId": undefined;
    /**
     * Bonding extra is restricted to the exact pending reward amount.
     */
    "BondExtraRestricted": undefined;
    /**
     * No imbalance in the ED deposit for the pool.
     */
    "NothingToAdjust": undefined;
    /**
     * No slash pending that can be applied to the member.
     */
    "NothingToSlash": undefined;
    /**
     * The slash amount is too low to be applied.
     */
    "SlashTooLow": undefined;
    /**
     * The pool or member delegation has already migrated to delegate stake.
     */
    "AlreadyMigrated": undefined;
    /**
     * The pool or member delegation has not migrated yet to delegate stake.
     */
    "NotMigrated": undefined;
    /**
     * This call is not allowed in the current state of the pallet.
     */
    "NotSupported": undefined;
}>;
export type Ie2db4l6126rkt = AnonymousEnum<{
    "NotEnoughSpaceInUnbondPool": undefined;
    "PoolNotFound": undefined;
    "RewardPoolNotFound": undefined;
    "SubPoolsNotFound": undefined;
    "BondedStashKilledPrematurely": undefined;
    "DelegationUnsupported": undefined;
    "SlashNotApplied": undefined;
}>;
export type I1iknkudsdnbks = AnonymousEnum<{
    /**
     * Preimage is too large to store on-chain.
     */
    "TooBig": undefined;
    /**
     * Preimage has already been noted on-chain.
     */
    "AlreadyNoted": undefined;
    /**
     * The user is not authorized to perform this action.
     */
    "NotAuthorized": undefined;
    /**
     * The preimage cannot be removed since it has not yet been noted.
     */
    "NotNoted": undefined;
    /**
     * A preimage may not be removed when there are outstanding requests.
     */
    "Requested": undefined;
    /**
     * The preimage request cannot be removed since no outstanding requests exist.
     */
    "NotRequested": undefined;
    /**
     * More than `MAX_HASH_UPGRADE_BULK_COUNT` hashes were requested to be upgraded at once.
     */
    "TooMany": undefined;
    /**
     * Too few hashes were requested to be upgraded (i.e. zero).
     */
    "TooFew": undefined;
    /**
     * No ticket with a cost was returned by [`Config::Consideration`] to store the preimage.
     */
    "NoCost": undefined;
}>;
export type Ifku1elmu8hk3i = AnonymousEnum<{
    /**
     * The call is paused.
     */
    "IsPaused": undefined;
    /**
     * The call is unpaused.
     */
    "IsUnpaused": undefined;
    /**
     * The call is whitelisted and cannot be paused.
     */
    "Unpausable": undefined;
    "NotFound": undefined;
}>;
export type I8kh6j0q1r930d = AnonymousEnum<{
    /**
     * Non existent public key.
     */
    "InvalidKey": undefined;
    /**
     * Duplicated heartbeat.
     */
    "DuplicatedHeartbeat": undefined;
}>;
export type I9mq328955mgb8 = AnonymousEnum<{
    /**
     * Too many subs-accounts.
     */
    "TooManySubAccounts": undefined;
    /**
     * Account isn't found.
     */
    "NotFound": undefined;
    /**
     * Account isn't named.
     */
    "NotNamed": undefined;
    /**
     * Empty index.
     */
    "EmptyIndex": undefined;
    /**
     * Fee is changed.
     */
    "FeeChanged": undefined;
    /**
     * No identity found.
     */
    "NoIdentity": undefined;
    /**
     * Sticky judgement.
     */
    "StickyJudgement": undefined;
    /**
     * Judgement given.
     */
    "JudgementGiven": undefined;
    /**
     * Invalid judgement.
     */
    "InvalidJudgement": undefined;
    /**
     * The index is invalid.
     */
    "InvalidIndex": undefined;
    /**
     * The target is invalid.
     */
    "InvalidTarget": undefined;
    /**
     * Maximum amount of registrars reached. Cannot add any more.
     */
    "TooManyRegistrars": undefined;
    /**
     * Account ID is already named.
     */
    "AlreadyClaimed": undefined;
    /**
     * Sender is not a sub-account.
     */
    "NotSub": undefined;
    /**
     * Sub-account isn't owned by sender.
     */
    "NotOwned": undefined;
    /**
     * The provided judgement was for a different identity.
     */
    "JudgementForDifferentIdentity": undefined;
    /**
     * Error that occurs when there is an issue paying for judgement.
     */
    "JudgementPaymentFailed": undefined;
    /**
     * The provided suffix is too long.
     */
    "InvalidSuffix": undefined;
    /**
     * The sender does not have permission to issue a username.
     */
    "NotUsernameAuthority": undefined;
    /**
     * The authority cannot allocate any more usernames.
     */
    "NoAllocation": undefined;
    /**
     * The signature on a username was not valid.
     */
    "InvalidSignature": undefined;
    /**
     * Setting this username requires a signature, but none was provided.
     */
    "RequiresSignature": undefined;
    /**
     * The username does not meet the requirements.
     */
    "InvalidUsername": undefined;
    /**
     * The username is already taken.
     */
    "UsernameTaken": undefined;
    /**
     * The requested username does not exist.
     */
    "NoUsername": undefined;
    /**
     * The username cannot be forcefully removed because it can still be accepted.
     */
    "NotExpired": undefined;
}>;
export type I8dt2g2hcrgh36 = AnonymousEnum<{
    /**
     * Too many calls batched.
     */
    "TooManyCalls": undefined;
}>;
export type Id1ggjaqrb40ns = AnonymousEnum<{
    /**
     * Not enough balance to perform action
     */
    "BalanceLow": undefined;
    /**
     * Calculating total fee overflowed
     */
    "FeeOverflow": undefined;
    /**
     * Calculating total payment overflowed
     */
    "PaymentOverflow": undefined;
    /**
     * Withdraw fee failed
     */
    "WithdrawFailed": undefined;
    /**
     * Gas price is too low.
     */
    "GasPriceTooLow": undefined;
    /**
     * Nonce is invalid
     */
    "InvalidNonce": undefined;
    /**
     * Gas limit is too low.
     */
    "GasLimitTooLow": undefined;
    /**
     * Gas limit is too high.
     */
    "GasLimitTooHigh": undefined;
    /**
     * The chain id is invalid.
     */
    "InvalidChainId": undefined;
    /**
     * the signature is invalid.
     */
    "InvalidSignature": undefined;
    /**
     * EVM reentrancy
     */
    "Reentrancy": undefined;
    /**
     * EIP-3607,
     */
    "TransactionMustComeFromEOA": undefined;
    /**
     * Undefined error.
     */
    "Undefined": undefined;
    "NotAllowed": undefined;
}>;
export type I9heam5bpv5tbs = AnonymousEnum<{
    /**
     * Maximum address count exceeded
     */
    "MaxAddressCountExceeded": undefined;
}>;
export type Iuvt54ei4cehc = AnonymousEnum<{
    /**
     * There are too many proxies registered or too many announcements pending.
     */
    "TooMany": undefined;
    /**
     * Proxy registration not found.
     */
    "NotFound": undefined;
    /**
     * Sender is not a proxy of the account to be proxied.
     */
    "NotProxy": undefined;
    /**
     * A call which is incompatible with the proxy type's filter was attempted.
     */
    "Unproxyable": undefined;
    /**
     * Account is already a proxy.
     */
    "Duplicate": undefined;
    /**
     * Call may not be made by proxy because it may escalate its privileges.
     */
    "NoPermission": undefined;
    /**
     * Announcement, if made at all, was made too recently.
     */
    "Unannounced": undefined;
    /**
     * Cannot add self as proxy.
     */
    "NoSelfProxy": undefined;
}>;
export type Icrjdufvqrbtmp = AnonymousEnum<{
    "NoneValue": undefined;
    "StorageOverflow": undefined;
    "IpfsNodeIdRequired": undefined;
    "NodeAlreadyRegistered": undefined;
    "NodeNotFound": undefined;
    "NotAminer": undefined;
    "IpfsNodeIdAlreadyRegistered": undefined;
    "AddressUidNotFoundOnBittensor": undefined;
    "InvalidAccountId": undefined;
    "InsufficientStake": undefined;
    "InsufficientBalanceForFee": undefined;
    "FeeTooHigh": undefined;
    "NodeTypeDisabled": undefined;
    "NodeTypeMismatch": undefined;
    "NodeNotRegistered": undefined;
    "NotNodeOwner": undefined;
    "NotAProxyAccount": undefined;
    "InvalidProxyType": undefined;
    "AccountNotRegistered": undefined;
    "NodeNotInUids": undefined;
    "NodeCooldownPeriodNotExpired": undefined;
    "OwnerAlreadyRegistered": undefined;
    "InvalidNodeType": undefined;
    "NodeNotDegradedStorageMiner": undefined;
    "TooManyRequests": undefined;
    "AccountBanned": undefined;
    "ExceededMaxWhitelistedValidators": undefined;
    "NodeNotWhitelisted": undefined;
    "InvalidSignature": undefined;
    "InvalidKeyType": undefined;
    "InvalidChallenge": undefined;
    "InvalidChallengeDomain": undefined;
    "ChallengeExpired": undefined;
    "ChallengeReused": undefined;
    "GenesisMismatch": undefined;
    "PublicKeyMismatch": undefined;
    "ChallengeMismatch": undefined;
    /**
     * Batch unregistration failed due to too many nodes
     */
    "TooManyUnverifiedNodes": undefined;
    "NodeAlreadyVerified": undefined;
    "Unauthorized": undefined;
}>;
export type I71nupm1pp4kan = AnonymousEnum<{
    "MetricsNotFound": undefined;
    "InvalidJson": undefined;
    "InvalidCid": undefined;
    "StorageOverflow": undefined;
    "IpfsError": undefined;
    "TooManyRequests": undefined;
    "NodeNotRegistered": undefined;
    "InvalidNodeType": undefined;
    "StorageBelowTwoTB": undefined;
    /**
     * Primary network interface is not provided.
     */
    "NoPrimaryNetworkInterface": undefined;
    /**
     * Disks array is empty.
     */
    "EmptyDisksArray": undefined;
    "MemoryExceedsFiveTB": undefined;
    "ConsensusNotReached": undefined;
    "SuccessfulPinsExceedTotal": undefined;
}>;
export type I53vvfsa2djd70 = AnonymousEnum<{
    /**
     * Value not found
     */
    "NoneValue": undefined;
    /**
     * Storage overflow
     */
    "StorageOverflow": undefined;
    /**
     * Error during signing
     */
    "SigningError": undefined;
    /**
     * Invalid signature
     */
    "InvalidSignature": undefined;
    /**
     * Invalid UID format
     */
    "InvalidUIDFormat": undefined;
    /**
     * Error decoding hex
     */
    "DecodingError": undefined;
    "ValidatorAlreadyWhitelisted": undefined;
    "ValidatorNotWhitelisted": undefined;
    "NotWhitelistedValidator": undefined;
    "NodeNotRegistered": undefined;
    "InvalidNodeType": undefined;
}>;
export type I2nd8aee8flais = AnonymousEnum<{
    "NoneValue": undefined;
    "NotSubscriptionOwner": undefined;
    "SubscriptionNotFound": undefined;
    "TooManySharedUsers": undefined;
    "InsufficientPermissions": undefined;
    "CannotTransferToSelf": undefined;
    "RecipientTooManySubscriptions": undefined;
    "CannotModifyOwnerPermissions": undefined;
    "CannotTransferInactiveSubscription": undefined;
    "AlreadyHasAccess": undefined;
    "NoExistingAccess": undefined;
    "NotAuthorized": undefined;
    "InsufficientBalance": undefined;
    "PackageNotFound": undefined;
    "SubscriptionNotActive": undefined;
    "InvalidSubscriptionType": undefined;
    "StorageLimitExceeded": undefined;
    "StorageRequestNotFound": undefined;
    "PlanNotFound": undefined;
    "InvalidPlanType": undefined;
    "AlreadyHasActiveSubscription": undefined;
    "PlanSuspended": undefined;
    "InsufficientFreeCredits": undefined;
    "LocationNotFound": undefined;
    "InvalidPlanLimits": undefined;
    "NodeTypeDisabled": undefined;
    "InvalidStorageReduction": undefined;
    "InvalidSubscriptionUsage": undefined;
    "ComputeResourceExceeded": undefined;
    "NoActiveSubscription": undefined;
    "BackupAlreadyEnabled": undefined;
    "InvalidImageSelection": undefined;
    "NodeNotRegistered": undefined;
    "InvalidNodeType": undefined;
    /**
     * No active compute subscription found for the user
     */
    "NoActiveComputeSubscription": undefined;
    /**
     * The plan does not match the user's active subscription
     */
    "InvalidPlanForSubscription": undefined;
    "InvalidPlanConfiguration": undefined;
    "InvalidOSDiskImageUrl": undefined;
    /**
     * No subscription found for the given user
     */
    "NoSubscriptionFound": undefined;
    "StorageOperationsDisabled": undefined;
    "PlanOperationDisabled": undefined;
    "TooManyRequests": undefined;
    "OperationNotAllowed": undefined;
}>;
export type I5rf3lt9apv0lm = AnonymousEnum<{
    "NoneValue": undefined;
    "StorageOverflow": undefined;
    "SubmissionDisabled": undefined;
}>;
export type Ia9d5dr223ctsp = AnonymousEnum<{
    /**
     * Sender is not a sub account
     */
    "NoSubAccount": undefined;
    /**
     * Sender is not a sub account of the given address
     */
    "NotAllowed": undefined;
    /**
     * Cannot remove all sub-accounts
     */
    "NoAccountsLeft": undefined;
    /**
     * Cannot add a sub account twice
     */
    "AlreadySubAccount": undefined;
    /**
     * Main account cannot be a sub-account
     */
    "MainCannotBeSubAccount": undefined;
    /**
     * Cannot be a Sub Account of Itself
     */
    "CannotBeOwnSubAccount": undefined;
    /**
     * Reached Limit
     */
    "TooManySubAccounts": undefined;
    /**
     * Invalid role change
     */
    "InvalidRoleChange": undefined;
}>;
export type Ifkfiju0fdpbss = AnonymousEnum<{
    /**
     * No notifications found for the user
     */
    "NoNotifications": undefined;
    /**
     * Notification index is invalid
     */
    "InvalidNotificationIndex": undefined;
    "CooldownNotElapsed": undefined;
    "AccountBanned": undefined;
}>;
export type Idt3seekemq2lp = AnonymousEnum<{
    /**
     * The hex string provided is invalid.
     */
    "InvalidHexString": undefined;
    /**
     * The account already has a username set.
     */
    "UsernameAlreadySet": undefined;
    "UsernameAlreadyTaken": undefined;
}>;
export type Iec82fol2ihelb = AnonymousEnum<{
    "NoneValue": undefined;
    "StorageOverflow": undefined;
}>;
export type I39s6aasu1rhk7 = AnonymousEnum<{
    /**
     * Value is None.
     */
    "NoneValue": undefined;
    /**
     * Storage overflow occurred.
     */
    "StorageOverflow": undefined;
    /**
     * Input provided is invalid.
     */
    "InvalidInput": undefined;
    /**
     * Error during conversion.
     */
    "ConversionError": undefined;
    /**
     * No signer was available to submit the transaction
     */
    "NoSignerAvailable": undefined;
    /**
     * Could not acquire the lock for updating rankings
     */
    "CannotAcquireLock": undefined;
    "NodeNotRegistered": undefined;
    "InvalidNodeType": undefined;
}>;
export type I9nflfk0n9gf26 = AnonymousEnum<{
    "NoneValue": undefined;
    "StorageOverflow": undefined;
    "InsufficientFreeCredits": undefined;
    "UserNotFound": undefined;
    "InsufficientLockedCredits": undefined;
    "NotAuthorized": undefined;
    "AuthorityAlreadyExists": undefined;
    "AuthorityNotFound": undefined;
    "InvalidConversionAmount": undefined;
    "InsufficientBalance": undefined;
    "ConversionFailed": undefined;
    "InvalidReferralCode": undefined;
    "ReferralCodeCooldown": undefined;
    "NoReferralCodeUsed": undefined;
    "InvalidRefferalOwner": undefined;
    "CreditAlreadyFulfilled": undefined;
    "LockedCreditNotFound": undefined;
    /**
     * Returned if the account has insufficient free credits
     * Returned if the current block is outside the specified lock period
     */
    "OutsideLockPeriod": undefined;
    /**
     * Returned if no active lock period is set
     */
    "NoActiveLockPeriod": undefined;
    "InvalidLockPeriod": undefined;
    /**
     * Minimum lock amount is not set
     */
    "MinLockAmountNotSet": undefined;
    /**
     * Locked amount is less than the minimum required lock amount
     */
    "InsufficientLockAmount": undefined;
    "InsufficientAlphaBalance": undefined;
}>;
export type Iat7q0fl4pe5ha = AnonymousEnum<{
    /**
     * Repository already exists
     */
    "RepositoryAlreadyExists": undefined;
    /**
     * Maximum tags limit reached
     */
    "MaxTagsLimitReached": undefined;
    /**
     * Input exceeds maximum allowed length
     */
    "ExceedsMaxLength": undefined;
    /**
     * Repository not found
     */
    "RepositoryNotFound": undefined;
    "MaxImageCidsLimitReached": undefined;
    /**
     * Space already exists
     */
    "SpaceAlreadyExists": undefined;
    /**
     * Space not found
     */
    "SpaceNotFound": undefined;
    /**
     * Not authorized to access the space
     */
    "NotAuthorized": undefined;
    /**
     * Maximum space members limit reached
     */
    "MaxSpaceMembersReached": undefined;
    /**
     * The image name cannot be empty
     */
    "EmptyImageName": undefined;
    /**
     * The digest cannot be empty
     */
    "EmptyDigest": undefined;
    /**
     * The CID cannot be empty
     */
    "EmptyCid": undefined;
    /**
     * The digest information cannot be empty
     */
    "EmptyDigestInfo": undefined;
    /**
     * The CID information cannot be empty
     */
    "EmptyCidInfo": undefined;
    /**
     * Not a member of the space
     */
    "NotSpaceMember": undefined;
    "SpaceDoesNotExist": undefined;
    "NotSpaceOwner": undefined;
    /**
     * User already has a space
     */
    "UserAlreadyHasSpace": undefined;
}>;
export type I59jf7vkud350h = AnonymousEnum<{
    /**
     * Caller is not a guardian
     */
    "NotGuardian": undefined;
    /**
     * Guardian has already voted on this deposit
     */
    "AlreadyVoted": undefined;
    /**
     * User has insufficient hAlpha balance
     */
    "InsufficientBalance": undefined;
    /**
     * Minting would exceed the global mint cap
     */
    "CapExceeded": undefined;
    /**
     * Bridge is currently paused
     */
    "BridgePaused": undefined;
    /**
     * Deposit not found
     */
    "DepositNotFound": undefined;
    /**
     * Withdrawal request not found
     */
    "WithdrawalRequestNotFound": undefined;
    /**
     * Invalid status for this operation
     */
    "InvalidStatus": undefined;
    /**
     * Threshold cannot be zero
     */
    "ThresholdTooLow": undefined;
    /**
     * Threshold exceeds guardian count
     */
    "ThresholdTooHigh": undefined;
    /**
     * Too many guardians provided
     */
    "TooManyGuardians": undefined;
    /**
     * Failed to convert between numeric balance types
     */
    "AmountConversionFailed": undefined;
    /**
     * Failed to mint tokens
     */
    "MintFailed": undefined;
    /**
     * Arithmetic overflow
     */
    "ArithmeticOverflow": undefined;
    /**
     * Deposit already completed
     */
    "DepositAlreadyCompleted": undefined;
    /**
     * Withdrawal request already completed or failed
     */
    "WithdrawalRequestAlreadyFinalized": undefined;
    /**
     * Amount must be greater than zero
     */
    "AmountTooSmall": undefined;
    /**
     * Accounting underflow - indicates a bug
     */
    "AccountingUnderflow": undefined;
    /**
     * Record is not finalized (not Completed or Cancelled)
     */
    "RecordNotFinalized": undefined;
    /**
     * TTL has not expired yet
     */
    "TTLNotExpired": undefined;
    /**
     * TTL must be greater than zero
     */
    "InvalidTTL": undefined;
    /**
     * Recomputed request ID does not match the provided one
     */
    "InvalidRequestId": undefined;
    /**
     * Withdrawal amount must be divisible by the conversion factor (no dust)
     */
    "AmountNotBridgeable": undefined;
}>;
export type I6e2rs4vqj03pu = AnonymousEnum<{
    "NoAvailableIp": undefined;
    "VmAlreadyHasIp": undefined;
    "VmHasNoIp": undefined;
    "IpAlreadyExists": undefined;
    "RoleAlreadyHasIp": undefined;
}>;
export type Ibqred97kvmfr3 = AnonymousEnum<{
    "NoneValue": undefined;
    "StorageOverflow": undefined;
    "RequestDoesNotExists": undefined;
    "OwnerNotFound": undefined;
    "TooManyUnpinRequests": undefined;
    "InvalidInput": undefined;
    "RequestAlreadyExists": undefined;
    "TooManyRequests": undefined;
    "ValidatorSelectionFailed": undefined;
    "NoValidatorsAvailable": undefined;
    "NodeNotRegistered": undefined;
    "NodeNotValidator": undefined;
    "InvalidCid": undefined;
    "InvalidJson": undefined;
    "IpfsError": undefined;
    "MaxUnpinRequestsExceeded": undefined;
    "InvalidNodeType": undefined;
    "MinerNotLocked": undefined;
    "AssignmentNotEnabled": undefined;
    "StorageRequestsCleared": undefined;
    "FileHashBlacklisted": undefined;
    "MinersNotLocked": undefined;
    "UnauthorizedLocker": undefined;
    "MinersAlreadyLocked": undefined;
    "NodeIdTooLong": undefined;
    "RequestNotFound": undefined;
    "InvalidReputationPoints": undefined;
    "UserIsBlacklisted": undefined;
    "InvalidAccountId": undefined;
    "NotCurrentEpochValidator": undefined;
    "FileSizeOverflow": undefined;
    "NotAuthorized": undefined;
    "StorageRequestFailed": undefined;
}>;
export type I44vkinnmi502t = AnonymousEnum<{
    /**
     * Epoch is not strictly increasing.
     */
    "EpochRegression": undefined;
    /**
     * Epoch already exists.
     */
    "EpochAlreadyExists": undefined;
    /**
     * Miner list must be sorted by uid and unique.
     */
    "MinerListNotSortedOrNotUnique": undefined;
    /**
     * Too many miners.
     */
    "TooManyMiners": undefined;
    /**
     * Too many stats updates in one call.
     */
    "TooManyStatsUpdates": undefined;
    /**
     * Stats bucket regression.
     */
    "StatsBucketRegression": undefined;
    /**
     * Family is not registered (per `FamilyRegistry` hook).
     */
    "FamilyNotRegistered": undefined;
    /**
     * Proxy verification failed (per `ProxyVerifier` hook).
     */
    "ProxyVerificationFailed": undefined;
    /**
     * Too many families.
     */
    "TooManyFamilies": undefined;
    /**
     * Too many active children total.
     */
    "TooManyChildrenTotal": undefined;
    /**
     * Too many active children in this family.
     */
    "TooManyChildrenInFamily": undefined;
    /**
     * Child is already registered.
     */
    "ChildAlreadyRegistered": undefined;
    /**
     * Child is not registered.
     */
    "ChildNotRegistered": undefined;
    /**
     * Child is in cooldown.
     */
    "ChildInCooldown": undefined;
    /**
     * Node id is already registered.
     */
    "NodeIdAlreadyRegistered": undefined;
    /**
     * Node id is in cooldown.
     */
    "NodeIdInCooldown": undefined;
    /**
     * Invalid node signature.
     */
    "InvalidNodeSignature": undefined;
    /**
     * Child is not currently active (cannot be deregistered).
     */
    "ChildNotActive": undefined;
    /**
     * Child is not in unbonding state.
     */
    "NotUnbonding": undefined;
    /**
     * Unbonding not finished yet.
     */
    "UnbondingNotReady": undefined;
    /**
     * Failed to reserve required deposit.
     */
    "InsufficientDeposit": undefined;
    /**
     * CRUSH map includes a miner that is not registered (when enforcement is enabled).
     */
    "MinerNotRegistered": undefined;
    /**
     * Weight bucket regression.
     */
    "WeightBucketRegression": undefined;
    /**
     * Too many node weight updates.
     */
    "TooManyNodeWeightUpdates": undefined;
    /**
     * Attestation bucket regression.
     */
    "AttestationBucketRegression": undefined;
    /**
     * Too many attestations in one call.
     */
    "TooManyAttestations": undefined;
    /**
     * Attestation list is full for this bucket.
     */
    "AttestationBucketFull": undefined;
    /**
     * Invalid attestation signature.
     */
    "InvalidAttestationSignature": undefined;
    /**
     * Attestation commitment already exists for this epoch.
     */
    "AttestationCommitmentAlreadyExists": undefined;
    /**
     * Invalid content hash length (expected 32 bytes for BLAKE3).
     */
    "InvalidContentHashLength": undefined;
    /**
     * Warden is already registered.
     */
    "WardenAlreadyRegistered": undefined;
    /**
     * Warden is not registered.
     */
    "WardenNotRegistered": undefined;
    /**
     * Attestation submitted by unregistered warden.
     */
    "UnregisteredWarden": undefined;
    /**
     * Cannot prune buckets within retention period.
     */
    "PruningWithinRetentionPeriod": undefined;
}>;
export type I6ntn47ia3efe1 = AnonymousEnum<{
    /**
     * A sudo call just took place.
     */
    "Sudid": Anonymize<I548nsjpe0eqli>;
    /**
     * The sudo key has been updated.
     */
    "KeyChanged": Anonymize<I5rtkmhm2dng4u>;
    /**
     * The key was permanently removed.
     */
    "KeyRemoved": undefined;
    /**
     * A [sudo_as](Pallet::sudo_as) call just took place.
     */
    "SudoAsDone": Anonymize<I548nsjpe0eqli>;
}>;
export type I548nsjpe0eqli = {
    /**
     * The result of the call made by the sudo user.
     */
    "sudo_result": Anonymize<I5stn0hvret66s>;
};
export type I5stn0hvret66s = ResultPayload<undefined, Anonymize<Ik9f7r9ibbik9>>;
export type Id7glfm578e80n = AnonymousEnum<{
    /**
     * Some asset class was created.
     */
    "Created": Anonymize<I2f09r4lf5jjh9>;
    /**
     * Some assets were issued.
     */
    "Issued": Anonymize<If6m0o1bjubses>;
    /**
     * Some assets were transferred.
     */
    "Transferred": Anonymize<Ica4tsd7r045b4>;
    /**
     * Some assets were destroyed.
     */
    "Burned": Anonymize<I8lqcc9n1bpf10>;
    /**
     * The management team changed.
     */
    "TeamChanged": Anonymize<Ic756ll6rev3et>;
    /**
     * The owner changed.
     */
    "OwnerChanged": Anonymize<Iabgjddlh1k1hp>;
    /**
     * Some account `who` was frozen.
     */
    "Frozen": Anonymize<Ie04jjjrr8q02l>;
    /**
     * Some account `who` was thawed.
     */
    "Thawed": Anonymize<Ie04jjjrr8q02l>;
    /**
     * Some asset `asset_id` was frozen.
     */
    "AssetFrozen": Anonymize<Ib9karr24cpmca>;
    /**
     * Some asset `asset_id` was thawed.
     */
    "AssetThawed": Anonymize<Ib9karr24cpmca>;
    /**
     * Accounts were destroyed for given asset.
     */
    "AccountsDestroyed": Anonymize<Ifstva0urnm27g>;
    /**
     * Approvals were destroyed for given asset.
     */
    "ApprovalsDestroyed": Anonymize<I4lpo3encq7fn8>;
    /**
     * An asset class is in the process of being destroyed.
     */
    "DestructionStarted": Anonymize<Ib9karr24cpmca>;
    /**
     * An asset class was destroyed.
     */
    "Destroyed": Anonymize<Ib9karr24cpmca>;
    /**
     * Some asset class was force-created.
     */
    "ForceCreated": Anonymize<Iabgjddlh1k1hp>;
    /**
     * New metadata has been set for an asset.
     */
    "MetadataSet": Anonymize<Icd1cghie6s8nr>;
    /**
     * Metadata has been cleared for an asset.
     */
    "MetadataCleared": Anonymize<Ib9karr24cpmca>;
    /**
     * (Additional) funds have been approved for transfer to a destination account.
     */
    "ApprovedTransfer": Anonymize<I7vvm3he225ppt>;
    /**
     * An approval for account `delegate` was cancelled by `owner`.
     */
    "ApprovalCancelled": Anonymize<Iaui349lsh3clk>;
    /**
     * An `amount` was transferred in its entirety from `owner` to `destination` by
     * the approved `delegate`.
     */
    "TransferredApproved": Anonymize<Ifbddfv84nkppg>;
    /**
     * An asset has had its attributes changed by the `Force` origin.
     */
    "AssetStatusChanged": Anonymize<Ib9karr24cpmca>;
    /**
     * The min_balance of an asset has been updated by the asset owner.
     */
    "AssetMinBalanceChanged": Anonymize<Iil3sdsh8fk7l>;
    /**
     * Some account `who` was created with a deposit from `depositor`.
     */
    "Touched": Anonymize<I85i3hdo5nsfi5>;
    /**
     * Some account `who` was blocked.
     */
    "Blocked": Anonymize<Ie04jjjrr8q02l>;
    /**
     * Some assets were deposited (e.g. for transaction fees).
     */
    "Deposited": Anonymize<Ic65advfoqjhk7>;
    /**
     * Some assets were withdrawn from the account (e.g. for transaction fees).
     */
    "Withdrawn": Anonymize<Ic65advfoqjhk7>;
}>;
export type I2f09r4lf5jjh9 = {
    "asset_id": bigint;
    "creator": SS58String;
    "owner": SS58String;
};
export type If6m0o1bjubses = {
    "asset_id": bigint;
    "owner": SS58String;
    "amount": bigint;
};
export type Ica4tsd7r045b4 = {
    "asset_id": bigint;
    "from": SS58String;
    "to": SS58String;
    "amount": bigint;
};
export type I8lqcc9n1bpf10 = {
    "asset_id": bigint;
    "owner": SS58String;
    "balance": bigint;
};
export type Ic756ll6rev3et = {
    "asset_id": bigint;
    "issuer": SS58String;
    "admin": SS58String;
    "freezer": SS58String;
};
export type Iabgjddlh1k1hp = {
    "asset_id": bigint;
    "owner": SS58String;
};
export type Ie04jjjrr8q02l = {
    "asset_id": bigint;
    "who": SS58String;
};
export type Ib9karr24cpmca = {
    "asset_id": bigint;
};
export type Ifstva0urnm27g = {
    "asset_id": bigint;
    "accounts_destroyed": number;
    "accounts_remaining": number;
};
export type I4lpo3encq7fn8 = {
    "asset_id": bigint;
    "approvals_destroyed": number;
    "approvals_remaining": number;
};
export type Icd1cghie6s8nr = {
    "asset_id": bigint;
    "name": Binary;
    "symbol": Binary;
    "decimals": number;
    "is_frozen": boolean;
};
export type I7vvm3he225ppt = {
    "asset_id": bigint;
    "source": SS58String;
    "delegate": SS58String;
    "amount": bigint;
};
export type Iaui349lsh3clk = {
    "asset_id": bigint;
    "owner": SS58String;
    "delegate": SS58String;
};
export type Ifbddfv84nkppg = {
    "asset_id": bigint;
    "owner": SS58String;
    "delegate": SS58String;
    "destination": SS58String;
    "amount": bigint;
};
export type Iil3sdsh8fk7l = {
    "asset_id": bigint;
    "new_min_balance": bigint;
};
export type I85i3hdo5nsfi5 = {
    "asset_id": bigint;
    "who": SS58String;
    "depositor": SS58String;
};
export type Ic65advfoqjhk7 = {
    "asset_id": bigint;
    "who": SS58String;
    "amount": bigint;
};
export type IndicesEvent = Enum<{
    /**
     * A account index was assigned.
     */
    "IndexAssigned": Anonymize<Ia1u3jll6a06ae>;
    /**
     * A account index has been freed up (unassigned).
     */
    "IndexFreed": Anonymize<I666bl2fqjkejo>;
    /**
     * A account index has been frozen to its current account ID.
     */
    "IndexFrozen": Anonymize<Ia1u3jll6a06ae>;
}>;
export declare const IndicesEvent: GetEnum<IndicesEvent>;
export type Ia1u3jll6a06ae = {
    "who": SS58String;
    "index": number;
};
export type I666bl2fqjkejo = {
    "index": number;
};
export type Ia7dnqubar6kb0 = AnonymousEnum<{
    /**
     * A motion has been proposed by a public account.
     */
    "Proposed": Anonymize<I3peh714diura8>;
    /**
     * A public proposal has been tabled for referendum vote.
     */
    "Tabled": Anonymize<I3peh714diura8>;
    /**
     * An external proposal has been tabled.
     */
    "ExternalTabled": undefined;
    /**
     * A referendum has begun.
     */
    "Started": Anonymize<I62ffgu6q2478o>;
    /**
     * A proposal has been approved by referendum.
     */
    "Passed": Anonymize<Ied9mja4bq7va8>;
    /**
     * A proposal has been rejected by referendum.
     */
    "NotPassed": Anonymize<Ied9mja4bq7va8>;
    /**
     * A referendum has been cancelled.
     */
    "Cancelled": Anonymize<Ied9mja4bq7va8>;
    /**
     * An account has delegated their vote to another account.
     */
    "Delegated": Anonymize<I10r7il4gvbcae>;
    /**
     * An account has cancelled a previous delegation operation.
     */
    "Undelegated": Anonymize<Icbccs0ug47ilf>;
    /**
     * An external proposal has been vetoed.
     */
    "Vetoed": Anonymize<I5bb5d1095hgr4>;
    /**
     * A proposal_hash has been blacklisted permanently.
     */
    "Blacklisted": Anonymize<I2ev73t79f46tb>;
    /**
     * An account has voted in a referendum
     */
    "Voted": Anonymize<Iet7kfijhihjik>;
    /**
     * An account has seconded a proposal
     */
    "Seconded": Anonymize<I2vrbos7ogo6ps>;
    /**
     * A proposal got canceled.
     */
    "ProposalCanceled": Anonymize<I9mnj4k4u8ls2c>;
    /**
     * Metadata for a proposal or a referendum has been set.
     */
    "MetadataSet": Anonymize<Iffeo46j957abe>;
    /**
     * Metadata for a proposal or a referendum has been cleared.
     */
    "MetadataCleared": Anonymize<Iffeo46j957abe>;
    /**
     * Metadata has been transferred to new owner.
     */
    "MetadataTransferred": Anonymize<I4ljshcevmm3p2>;
}>;
export type I3peh714diura8 = {
    "proposal_index": number;
    "deposit": bigint;
};
export type I62ffgu6q2478o = {
    "ref_index": number;
    "threshold": Anonymize<Ivbp9821csvot>;
};
export type Ivbp9821csvot = AnonymousEnum<{
    "SuperMajorityApprove": undefined;
    "SuperMajorityAgainst": undefined;
    "SimpleMajority": undefined;
}>;
export type Ied9mja4bq7va8 = {
    "ref_index": number;
};
export type I10r7il4gvbcae = {
    "who": SS58String;
    "target": SS58String;
};
export type I5bb5d1095hgr4 = {
    "who": SS58String;
    "proposal_hash": FixedSizeBinary<32>;
    "until": bigint;
};
export type I2ev73t79f46tb = {
    "proposal_hash": FixedSizeBinary<32>;
};
export type Iet7kfijhihjik = {
    "voter": SS58String;
    "ref_index": number;
    "vote": Anonymize<Ia9hdots6g53fs>;
};
export type Ia9hdots6g53fs = AnonymousEnum<{
    "Standard": {
        "vote": number;
        "balance": bigint;
    };
    "Split": {
        "aye": bigint;
        "nay": bigint;
    };
}>;
export type I2vrbos7ogo6ps = {
    "seconder": SS58String;
    "prop_index": number;
};
export type I9mnj4k4u8ls2c = {
    "prop_index": number;
};
export type Iffeo46j957abe = {
    /**
     * Metadata owner.
     */
    "owner": Anonymize<I2itl2k1j2q8nf>;
    /**
     * Preimage hash.
     */
    "hash": FixedSizeBinary<32>;
};
export type I2itl2k1j2q8nf = AnonymousEnum<{
    "External": undefined;
    "Proposal": number;
    "Referendum": number;
}>;
export type I4ljshcevmm3p2 = {
    /**
     * Previous metadata owner.
     */
    "prev_owner": Anonymize<I2itl2k1j2q8nf>;
    /**
     * New metadata owner.
     */
    "owner": Anonymize<I2itl2k1j2q8nf>;
    /**
     * Preimage hash.
     */
    "hash": FixedSizeBinary<32>;
};
export type Iec6lsg8g36jn6 = AnonymousEnum<{
    /**
     * A motion (given hash) has been proposed (by given account) with a threshold (given
     * `MemberCount`).
     */
    "Proposed": Anonymize<Ift6f10887nk72>;
    /**
     * A motion (given hash) has been voted on by given account, leaving
     * a tally (yes votes and no votes given respectively as `MemberCount`).
     */
    "Voted": Anonymize<I7qc53b1tvqjg2>;
    /**
     * A motion was approved by the required threshold.
     */
    "Approved": Anonymize<I2ev73t79f46tb>;
    /**
     * A motion was not approved by the required threshold.
     */
    "Disapproved": Anonymize<I2ev73t79f46tb>;
    /**
     * A motion was executed; result will be `Ok` if it returned without error.
     */
    "Executed": Anonymize<Ie4reroenbg6hl>;
    /**
     * A single member did some action; result will be `Ok` if it returned without error.
     */
    "MemberExecuted": Anonymize<Ie4reroenbg6hl>;
    /**
     * A proposal was closed because its threshold was reached or after its duration was up.
     */
    "Closed": Anonymize<Iak7fhrgb9jnnq>;
}>;
export type Ift6f10887nk72 = {
    "account": SS58String;
    "proposal_index": number;
    "proposal_hash": FixedSizeBinary<32>;
    "threshold": number;
};
export type I7qc53b1tvqjg2 = {
    "account": SS58String;
    "proposal_hash": FixedSizeBinary<32>;
    "voted": boolean;
    "yes": number;
    "no": number;
};
export type Ie4reroenbg6hl = {
    "proposal_hash": FixedSizeBinary<32>;
    "result": Anonymize<I5stn0hvret66s>;
};
export type Iak7fhrgb9jnnq = {
    "proposal_hash": FixedSizeBinary<32>;
    "yes": number;
    "no": number;
};
export type VestingEvent = Enum<{
    /**
     * The amount vested has been updated. This could indicate a change in funds available.
     * The balance given is the amount which is left unvested (and thus locked).
     */
    "VestingUpdated": Anonymize<Ievr89968437gm>;
    /**
     * An \[account\] has become fully vested.
     */
    "VestingCompleted": Anonymize<Icbccs0ug47ilf>;
}>;
export declare const VestingEvent: GetEnum<VestingEvent>;
export type Ievr89968437gm = {
    "account": SS58String;
    "unvested": bigint;
};
export type I4iamd5rd51ec2 = AnonymousEnum<{
    /**
     * A new term with new_members. This indicates that enough candidates existed to run
     * the election, not that enough have has been elected. The inner value must be examined
     * for this purpose. A `NewTerm(\[\])` indicates that some candidates got their bond
     * slashed and none were elected, whilst `EmptyTerm` means that no candidates existed to
     * begin with.
     */
    "NewTerm": Anonymize<Iaofef34v2445a>;
    /**
     * No (or not enough) candidates existed for this round. This is different from
     * `NewTerm(\[\])`. See the description of `NewTerm`.
     */
    "EmptyTerm": undefined;
    /**
     * Internal error happened while trying to perform election.
     */
    "ElectionError": undefined;
    /**
     * A member has been removed. This should always be followed by either `NewTerm` or
     * `EmptyTerm`.
     */
    "MemberKicked": Anonymize<Ie3gphha4ejh40>;
    /**
     * Someone has renounced their candidacy.
     */
    "Renounced": Anonymize<I4b66js88p45m8>;
    /**
     * A candidate was slashed by amount due to failing to obtain a seat as member or
     * runner-up.
     *
     * Note that old members and runners-up are also candidates.
     */
    "CandidateSlashed": Anonymize<I50d9r8lrdga93>;
    /**
     * A seat holder was slashed by amount by being forcefully removed from the set.
     */
    "SeatHolderSlashed": Anonymize<I27avf13g71mla>;
}>;
export type Iaofef34v2445a = {
    "new_members": Anonymize<Iba9inugg1atvo>;
};
export type Ie3gphha4ejh40 = {
    "member": SS58String;
};
export type I4b66js88p45m8 = {
    "candidate": SS58String;
};
export type I50d9r8lrdga93 = {
    "candidate": SS58String;
    "amount": bigint;
};
export type I27avf13g71mla = {
    "seat_holder": SS58String;
    "amount": bigint;
};
export type Iaf9qcn9c4uvq1 = AnonymousEnum<{
    /**
     * A solution was stored with the given compute.
     *
     * The `origin` indicates the origin of the solution. If `origin` is `Some(AccountId)`,
     * the stored solution was submitted in the signed phase by a miner with the `AccountId`.
     * Otherwise, the solution was stored either during the unsigned phase or by
     * `T::ForceOrigin`. The `bool` is `true` when a previous solution was ejected to make
     * room for this one.
     */
    "SolutionStored": Anonymize<I4mol6k10mv0io>;
    /**
     * The election has been finalized, with the given computation and score.
     */
    "ElectionFinalized": Anonymize<Iec90vukseit9e>;
    /**
     * An election failed.
     *
     * Not much can be said about which computes failed in the process.
     */
    "ElectionFailed": undefined;
    /**
     * An account has been rewarded for their signed submission being finalized.
     */
    "Rewarded": Anonymize<I7j4m7a3pkvsf4>;
    /**
     * An account has been slashed for submitting an invalid signed submission.
     */
    "Slashed": Anonymize<I7j4m7a3pkvsf4>;
    /**
     * There was a phase transition in a given round.
     */
    "PhaseTransitioned": Anonymize<Ie732teo48djnq>;
}>;
export type I4mol6k10mv0io = {
    "compute": ElectionProviderMultiPhaseElectionCompute;
    "origin"?: Anonymize<Ihfphjolmsqq1>;
    "prev_ejected": boolean;
};
export type ElectionProviderMultiPhaseElectionCompute = Enum<{
    "OnChain": undefined;
    "Signed": undefined;
    "Unsigned": undefined;
    "Fallback": undefined;
    "Emergency": undefined;
}>;
export declare const ElectionProviderMultiPhaseElectionCompute: GetEnum<ElectionProviderMultiPhaseElectionCompute>;
export type Iec90vukseit9e = {
    "compute": ElectionProviderMultiPhaseElectionCompute;
    "score": Anonymize<I8s6n43okuj2b1>;
};
export type I8s6n43okuj2b1 = {
    "minimal_stake": bigint;
    "sum_stake": bigint;
    "sum_stake_squared": bigint;
};
export type I7j4m7a3pkvsf4 = {
    "account": SS58String;
    "value": bigint;
};
export type Ie732teo48djnq = {
    "from": Anonymize<I60mqgbf0p40e1>;
    "to": Anonymize<I60mqgbf0p40e1>;
    "round": number;
};
export type I60mqgbf0p40e1 = AnonymousEnum<{
    "Off": undefined;
    "Signed": undefined;
    "Unsigned": [boolean, bigint];
    "Emergency": undefined;
}>;
export type StakingEvent = Enum<{
    /**
     * The era payout has been set; the first balance is the validator-payout; the second is
     * the remainder from the maximum amount of reward.
     */
    "EraPaid": Anonymize<I1au3fq4n84nv3>;
    /**
     * The nominator has been rewarded by this amount to this destination.
     */
    "Rewarded": Anonymize<Iejaj7m7qka9tr>;
    /**
     * A staker (validator or nominator) has been slashed by the given amount.
     */
    "Slashed": Anonymize<Idnak900lt5lm8>;
    /**
     * A slash for the given validator, for the given percentage of their stake, at the given
     * era as been reported.
     */
    "SlashReported": Anonymize<I27n7lbd66730p>;
    /**
     * An old slashing report from a prior era was discarded because it could
     * not be processed.
     */
    "OldSlashingReportDiscarded": Anonymize<I2hq50pu2kdjpo>;
    /**
     * A new set of stakers was elected.
     */
    "StakersElected": undefined;
    /**
     * An account has bonded this amount. \[stash, amount\]
     *
     * NOTE: This event is only emitted when funds are bonded via a dispatchable. Notably,
     * it will not be emitted for staking rewards when they are added to stake.
     */
    "Bonded": Anonymize<Ifk8eme5o7mukf>;
    /**
     * An account has unbonded this amount.
     */
    "Unbonded": Anonymize<Ifk8eme5o7mukf>;
    /**
     * An account has called `withdraw_unbonded` and removed unbonding chunks worth `Balance`
     * from the unlocking queue.
     */
    "Withdrawn": Anonymize<Ifk8eme5o7mukf>;
    /**
     * A nominator has been kicked from a validator.
     */
    "Kicked": Anonymize<Iau4cgm6ih61cf>;
    /**
     * The election failed. No new era is planned.
     */
    "StakingElectionFailed": undefined;
    /**
     * An account has stopped participating as either a validator or nominator.
     */
    "Chilled": Anonymize<Idl3umm12u5pa>;
    /**
     * The stakers' rewards are getting paid.
     */
    "PayoutStarted": Anonymize<I6ir616rur362k>;
    /**
     * A validator has set their preferences.
     */
    "ValidatorPrefsSet": Anonymize<Ic19as7nbst738>;
    /**
     * Voters size limit reached.
     */
    "SnapshotVotersSizeExceeded": Anonymize<I54umskavgc9du>;
    /**
     * Targets size limit reached.
     */
    "SnapshotTargetsSizeExceeded": Anonymize<I54umskavgc9du>;
    /**
     * A new force era mode was set.
     */
    "ForceEra": Anonymize<I2ip7o9e2tc5sf>;
    /**
     * Report of a controller batch deprecation.
     */
    "ControllerBatchDeprecated": Anonymize<I5egvk6hadac5h>;
}>;
export declare const StakingEvent: GetEnum<StakingEvent>;
export type I1au3fq4n84nv3 = {
    "era_index": number;
    "validator_payout": bigint;
    "remainder": bigint;
};
export type Iejaj7m7qka9tr = {
    "stash": SS58String;
    "dest": StakingRewardDestination;
    "amount": bigint;
};
export type StakingRewardDestination = Enum<{
    "Staked": undefined;
    "Stash": undefined;
    "Controller": undefined;
    "Account": SS58String;
    "None": undefined;
}>;
export declare const StakingRewardDestination: GetEnum<StakingRewardDestination>;
export type Idnak900lt5lm8 = {
    "staker": SS58String;
    "amount": bigint;
};
export type I27n7lbd66730p = {
    "validator": SS58String;
    "fraction": number;
    "slash_era": number;
};
export type I2hq50pu2kdjpo = {
    "session_index": number;
};
export type Ifk8eme5o7mukf = {
    "stash": SS58String;
    "amount": bigint;
};
export type Iau4cgm6ih61cf = {
    "nominator": SS58String;
    "stash": SS58String;
};
export type Idl3umm12u5pa = {
    "stash": SS58String;
};
export type I6ir616rur362k = {
    "era_index": number;
    "validator_stash": SS58String;
};
export type Ic19as7nbst738 = {
    "stash": SS58String;
    "prefs": Anonymize<I9o7ssi9vmhmgr>;
};
export type I9o7ssi9vmhmgr = {
    "commission": number;
    "blocked": boolean;
};
export type I54umskavgc9du = {
    "size": number;
};
export type I2ip7o9e2tc5sf = {
    "mode": StakingForcing;
};
export type StakingForcing = Enum<{
    "NotForcing": undefined;
    "ForceNew": undefined;
    "ForceNone": undefined;
    "ForceAlways": undefined;
}>;
export declare const StakingForcing: GetEnum<StakingForcing>;
export type I5egvk6hadac5h = {
    "failures": number;
};
export type SessionEvent = Enum<{
    /**
     * New session has happened. Note that the argument is the session index, not the
     * block number as the type might suggest.
     */
    "NewSession": Anonymize<I2hq50pu2kdjpo>;
}>;
export declare const SessionEvent: GetEnum<SessionEvent>;
export type I6led74bt1hkg5 = AnonymousEnum<{
    /**
     * We have ended a spend period and will now allocate funds.
     */
    "Spending": Anonymize<I8iksqi3eani0a>;
    /**
     * Some funds have been allocated.
     */
    "Awarded": Anonymize<I16enopmju1p0q>;
    /**
     * Some of our funds have been burnt.
     */
    "Burnt": Anonymize<I43kq8qudg7pq9>;
    /**
     * Spending has finished; this is the amount that rolls over until next spend.
     */
    "Rollover": Anonymize<I76riseemre533>;
    /**
     * Some funds have been deposited.
     */
    "Deposit": Anonymize<Ie5v6njpckr05b>;
    /**
     * A new spend proposal has been approved.
     */
    "SpendApproved": Anonymize<I38bmcrmh852rk>;
    /**
     * The inactive funds of the pallet have been updated.
     */
    "UpdatedInactive": Anonymize<I4hcillge8de5f>;
    /**
     * A new asset spend proposal has been approved.
     */
    "AssetSpendApproved": Anonymize<I3pitp3nlr696e>;
    /**
     * An approved spend was voided.
     */
    "AssetSpendVoided": Anonymize<I666bl2fqjkejo>;
    /**
     * A payment happened.
     */
    "Paid": Anonymize<I666bl2fqjkejo>;
    /**
     * A payment failed and can be retried.
     */
    "PaymentFailed": Anonymize<I666bl2fqjkejo>;
    /**
     * A spend was processed and removed from the storage. It might have been successfully
     * paid or it may have expired.
     */
    "SpendProcessed": Anonymize<I666bl2fqjkejo>;
}>;
export type I8iksqi3eani0a = {
    "budget_remaining": bigint;
};
export type I16enopmju1p0q = {
    "proposal_index": number;
    "award": bigint;
    "account": SS58String;
};
export type I43kq8qudg7pq9 = {
    "burnt_funds": bigint;
};
export type I76riseemre533 = {
    "rollover_balance": bigint;
};
export type Ie5v6njpckr05b = {
    "value": bigint;
};
export type I38bmcrmh852rk = {
    "proposal_index": number;
    "amount": bigint;
    "beneficiary": SS58String;
};
export type I4hcillge8de5f = {
    "reactivated": bigint;
    "deactivated": bigint;
};
export type I3pitp3nlr696e = {
    "index": number;
    "amount": bigint;
    "beneficiary": SS58String;
    "valid_from": bigint;
    "expire_at": bigint;
};
export type BountiesEvent = Enum<{
    /**
     * New bounty proposal.
     */
    "BountyProposed": Anonymize<I666bl2fqjkejo>;
    /**
     * A bounty proposal was rejected; funds were slashed.
     */
    "BountyRejected": Anonymize<Id9idaj83175f9>;
    /**
     * A bounty proposal is funded and became active.
     */
    "BountyBecameActive": Anonymize<I666bl2fqjkejo>;
    /**
     * A bounty is awarded to a beneficiary.
     */
    "BountyAwarded": Anonymize<Ie1semicfuv5uu>;
    /**
     * A bounty is claimed by beneficiary.
     */
    "BountyClaimed": Anonymize<If25fjs9o37co1>;
    /**
     * A bounty is cancelled.
     */
    "BountyCanceled": Anonymize<I666bl2fqjkejo>;
    /**
     * A bounty expiry is extended.
     */
    "BountyExtended": Anonymize<I666bl2fqjkejo>;
    /**
     * A bounty is approved.
     */
    "BountyApproved": Anonymize<I666bl2fqjkejo>;
    /**
     * A bounty curator is proposed.
     */
    "CuratorProposed": Anonymize<I70sc1pdo8vtos>;
    /**
     * A bounty curator is unassigned.
     */
    "CuratorUnassigned": Anonymize<Ia9p5bg6p18r0i>;
    /**
     * A bounty curator is accepted.
     */
    "CuratorAccepted": Anonymize<I70sc1pdo8vtos>;
}>;
export declare const BountiesEvent: GetEnum<BountiesEvent>;
export type Id9idaj83175f9 = {
    "index": number;
    "bond": bigint;
};
export type Ie1semicfuv5uu = {
    "index": number;
    "beneficiary": SS58String;
};
export type If25fjs9o37co1 = {
    "index": number;
    "payout": bigint;
    "beneficiary": SS58String;
};
export type I70sc1pdo8vtos = {
    "bounty_id": number;
    "curator": SS58String;
};
export type Ia9p5bg6p18r0i = {
    "bounty_id": number;
};
export type ChildBountiesEvent = Enum<{
    /**
     * A child-bounty is added.
     */
    "Added": Anonymize<I60p8l86a8cm59>;
    /**
     * A child-bounty is awarded to a beneficiary.
     */
    "Awarded": Anonymize<I3m3sk2lgcabvp>;
    /**
     * A child-bounty is claimed by beneficiary.
     */
    "Claimed": Anonymize<I5pf572duh4oeg>;
    /**
     * A child-bounty is cancelled.
     */
    "Canceled": Anonymize<I60p8l86a8cm59>;
}>;
export declare const ChildBountiesEvent: GetEnum<ChildBountiesEvent>;
export type I60p8l86a8cm59 = {
    "index": number;
    "child_index": number;
};
export type I3m3sk2lgcabvp = {
    "index": number;
    "child_index": number;
    "beneficiary": SS58String;
};
export type I5pf572duh4oeg = {
    "index": number;
    "child_index": number;
    "payout": bigint;
    "beneficiary": SS58String;
};
export type BagsListEvent = Enum<{
    /**
     * Moved an account from one bag to another.
     */
    "Rebagged": Anonymize<I37454vatvmm1l>;
    /**
     * Updated the score of some account to the given amount.
     */
    "ScoreUpdated": Anonymize<Iblau1qa7u7fet>;
}>;
export declare const BagsListEvent: GetEnum<BagsListEvent>;
export type I37454vatvmm1l = {
    "who": SS58String;
    "from": bigint;
    "to": bigint;
};
export type Iblau1qa7u7fet = {
    "who": SS58String;
    "new_score": bigint;
};
export type Id9v43dv1m5j6r = AnonymousEnum<{
    /**
     * A pool has been created.
     */
    "Created": Anonymize<I1ti389kf8t6oi>;
    /**
     * A member has became bonded in a pool.
     */
    "Bonded": Anonymize<If4nnre373amul>;
    /**
     * A payout has been made to a member.
     */
    "PaidOut": Anonymize<I55kbor0ocqk6h>;
    /**
     * A member has unbonded from their pool.
     *
     * - `balance` is the corresponding balance of the number of points that has been
     * requested to be unbonded (the argument of the `unbond` transaction) from the bonded
     * pool.
     * - `points` is the number of points that are issued as a result of `balance` being
     * dissolved into the corresponding unbonding pool.
     * - `era` is the era in which the balance will be unbonded.
     * In the absence of slashing, these values will match. In the presence of slashing, the
     * number of points that are issued in the unbonding pool will be less than the amount
     * requested to be unbonded.
     */
    "Unbonded": Anonymize<Idsj9cg7j96kpc>;
    /**
     * A member has withdrawn from their pool.
     *
     * The given number of `points` have been dissolved in return of `balance`.
     *
     * Similar to `Unbonded` event, in the absence of slashing, the ratio of point to balance
     * will be 1.
     */
    "Withdrawn": Anonymize<Ido4u9drncfaml>;
    /**
     * A pool has been destroyed.
     */
    "Destroyed": Anonymize<I931cottvong90>;
    /**
     * The state of a pool has changed
     */
    "StateChanged": Anonymize<Ie8c7ctks8ur2p>;
    /**
     * A member has been removed from a pool.
     *
     * The removal can be voluntary (withdrawn all unbonded funds) or involuntary (kicked).
     */
    "MemberRemoved": Anonymize<I7vqogd77mmdlm>;
    /**
     * The roles of a pool have been updated to the given new roles. Note that the depositor
     * can never change.
     */
    "RolesUpdated": Anonymize<I6mik29s5073td>;
    /**
     * The active balance of pool `pool_id` has been slashed to `balance`.
     */
    "PoolSlashed": Anonymize<I2m0sqmb75cnpb>;
    /**
     * The unbond pool at `era` of pool `pool_id` has been slashed to `balance`.
     */
    "UnbondingPoolSlashed": Anonymize<I49agc5b62mehu>;
    /**
     * A pool's commission setting has been changed.
     */
    "PoolCommissionUpdated": Anonymize<Iatq9jda4hq6pg>;
    /**
     * A pool's maximum commission setting has been changed.
     */
    "PoolMaxCommissionUpdated": Anonymize<I8cbluptqo8kbp>;
    /**
     * A pool's commission `change_rate` has been changed.
     */
    "PoolCommissionChangeRateUpdated": Anonymize<I6t5r359eagicn>;
    /**
     * Pool commission claim permission has been updated.
     */
    "PoolCommissionClaimPermissionUpdated": Anonymize<I3ihan8icf0c5k>;
    /**
     * Pool commission has been claimed.
     */
    "PoolCommissionClaimed": Anonymize<I2g87evcjlgmqi>;
    /**
     * Topped up deficit in frozen ED of the reward pool.
     */
    "MinBalanceDeficitAdjusted": Anonymize<Ieg1oc56mamrl5>;
    /**
     * Claimed excess frozen ED of af the reward pool.
     */
    "MinBalanceExcessAdjusted": Anonymize<Ieg1oc56mamrl5>;
}>;
export type I1ti389kf8t6oi = {
    "depositor": SS58String;
    "pool_id": number;
};
export type If4nnre373amul = {
    "member": SS58String;
    "pool_id": number;
    "bonded": bigint;
    "joined": boolean;
};
export type I55kbor0ocqk6h = {
    "member": SS58String;
    "pool_id": number;
    "payout": bigint;
};
export type Idsj9cg7j96kpc = {
    "member": SS58String;
    "pool_id": number;
    "balance": bigint;
    "points": bigint;
    "era": number;
};
export type Ido4u9drncfaml = {
    "member": SS58String;
    "pool_id": number;
    "balance": bigint;
    "points": bigint;
};
export type I931cottvong90 = {
    "pool_id": number;
};
export type Ie8c7ctks8ur2p = {
    "pool_id": number;
    "new_state": NominationPoolsPoolState;
};
export type NominationPoolsPoolState = Enum<{
    "Open": undefined;
    "Blocked": undefined;
    "Destroying": undefined;
}>;
export declare const NominationPoolsPoolState: GetEnum<NominationPoolsPoolState>;
export type I7vqogd77mmdlm = {
    "pool_id": number;
    "member": SS58String;
};
export type I6mik29s5073td = {
    "root"?: Anonymize<Ihfphjolmsqq1>;
    "bouncer"?: Anonymize<Ihfphjolmsqq1>;
    "nominator"?: Anonymize<Ihfphjolmsqq1>;
};
export type I2m0sqmb75cnpb = {
    "pool_id": number;
    "balance": bigint;
};
export type I49agc5b62mehu = {
    "pool_id": number;
    "era": number;
    "balance": bigint;
};
export type Iatq9jda4hq6pg = {
    "pool_id": number;
    "current"?: Anonymize<Ie8iutm7u02lmj>;
};
export type Ie8iutm7u02lmj = (Anonymize<I7svnfko10tq2e>) | undefined;
export type I8cbluptqo8kbp = {
    "pool_id": number;
    "max_commission": number;
};
export type I6t5r359eagicn = {
    "pool_id": number;
    "change_rate": Anonymize<I82n31imqd56r6>;
};
export type I82n31imqd56r6 = {
    "max_increase": number;
    "min_delay": bigint;
};
export type I3ihan8icf0c5k = {
    "pool_id": number;
    "permission"?: Anonymize<I16m1kn78dee7v>;
};
export type I16m1kn78dee7v = (NominationPoolsCommissionClaimPermission) | undefined;
export type NominationPoolsCommissionClaimPermission = Enum<{
    "Permissionless": undefined;
    "Account": SS58String;
}>;
export declare const NominationPoolsCommissionClaimPermission: GetEnum<NominationPoolsCommissionClaimPermission>;
export type I2g87evcjlgmqi = {
    "pool_id": number;
    "commission": bigint;
};
export type Ieg1oc56mamrl5 = {
    "pool_id": number;
    "amount": bigint;
};
export type I93jig937vec0q = AnonymousEnum<{
    /**
     * Scheduled some task.
     */
    "Scheduled": Anonymize<I229jvdlbdhm94>;
    /**
     * Canceled some task.
     */
    "Canceled": Anonymize<I229jvdlbdhm94>;
    /**
     * Dispatched some task.
     */
    "Dispatched": Anonymize<I4q514k7hotnla>;
    /**
     * Set a retry configuration for some task.
     */
    "RetrySet": Anonymize<I349gm6qoac50o>;
    /**
     * Cancel a retry configuration for some task.
     */
    "RetryCancelled": Anonymize<I4cdcnl6pft57b>;
    /**
     * The call for the provided hash was not found so the task has been aborted.
     */
    "CallUnavailable": Anonymize<I4cdcnl6pft57b>;
    /**
     * The given task was unable to be renewed since the agenda is full at that block.
     */
    "PeriodicFailed": Anonymize<I4cdcnl6pft57b>;
    /**
     * The given task was unable to be retried since the agenda is full at that block or there
     * was not enough weight to reschedule it.
     */
    "RetryFailed": Anonymize<I4cdcnl6pft57b>;
    /**
     * The given task can never be executed since it is overweight.
     */
    "PermanentlyOverweight": Anonymize<I4cdcnl6pft57b>;
}>;
export type I229jvdlbdhm94 = {
    "when": bigint;
    "index": number;
};
export type I4q514k7hotnla = {
    "task": Anonymize<I6cs1itejju2vv>;
    "id"?: Anonymize<I4s6vifaf8k998>;
    "result": Anonymize<I5stn0hvret66s>;
};
export type I6cs1itejju2vv = [bigint, number];
export type I349gm6qoac50o = {
    "task": Anonymize<I6cs1itejju2vv>;
    "id"?: Anonymize<I4s6vifaf8k998>;
    "period": bigint;
    "retries": number;
};
export type I4cdcnl6pft57b = {
    "task": Anonymize<I6cs1itejju2vv>;
    "id"?: Anonymize<I4s6vifaf8k998>;
};
export type OffencesEvent = Enum<{
    /**
     * There is an offence reported of the given `kind` happened at the `session_index` and
     * (kind-specific) time slot. This event is not deposited for duplicate slashes.
     * \[kind, timeslot\].
     */
    "Offence": Anonymize<Iempvdlhc5ih6g>;
}>;
export declare const OffencesEvent: GetEnum<OffencesEvent>;
export type Iempvdlhc5ih6g = {
    "kind": FixedSizeBinary<16>;
    "timeslot": Binary;
};
export type I9ulgod11dfvq5 = AnonymousEnum<{
    /**
     * This pallet, or a specific call is now paused.
     */
    "CallPaused": Anonymize<Iba7pefg0d11kh>;
    /**
     * This pallet, or a specific call is now unpaused.
     */
    "CallUnpaused": Anonymize<Iba7pefg0d11kh>;
}>;
export type Iba7pefg0d11kh = {
    "full_name": Anonymize<Idkbvh6dahk1v7>;
};
export type I9jqrili6gan6u = AnonymousEnum<{
    /**
     * A new heartbeat was received from `AuthorityId`.
     */
    "HeartbeatReceived": Anonymize<I6niuoceqveh04>;
    /**
     * At the end of the session, no offence was committed.
     */
    "AllGood": undefined;
    /**
     * At the end of the session, at least one validator was found to be offline.
     */
    "SomeOffline": Anonymize<I311vp8270bfmr>;
}>;
export type I6niuoceqveh04 = {
    "authority_id": FixedSizeBinary<32>;
};
export type I311vp8270bfmr = {
    "offline": Array<Anonymize<Idi27pva6ajg4>>;
};
export type Idi27pva6ajg4 = [SS58String, Anonymize<Ifekshcrgkl12g>];
export type Ifekshcrgkl12g = {
    "total": bigint;
    "own": bigint;
    "others": Anonymize<I252o97fo263q7>;
};
export type I252o97fo263q7 = Array<{
    "who": SS58String;
    "value": bigint;
}>;
export type I9ec49dohok6av = AnonymousEnum<{
    /**
     * A name was set or reset (which will remove all judgements).
     */
    "IdentitySet": Anonymize<I4cbvqmqadhrea>;
    /**
     * A name was cleared, and the given balance returned.
     */
    "IdentityCleared": Anonymize<Iep1lmt6q3s6r3>;
    /**
     * A name was removed and the given balance slashed.
     */
    "IdentityKilled": Anonymize<Iep1lmt6q3s6r3>;
    /**
     * A judgement was asked from a registrar.
     */
    "JudgementRequested": Anonymize<I1fac16213rie2>;
    /**
     * A judgement request was retracted.
     */
    "JudgementUnrequested": Anonymize<I1fac16213rie2>;
    /**
     * A judgement was given by a registrar.
     */
    "JudgementGiven": Anonymize<Ifjt77oc391o43>;
    /**
     * A registrar was added.
     */
    "RegistrarAdded": Anonymize<Itvt1jsipv0lc>;
    /**
     * A sub-identity was added to an identity and the deposit paid.
     */
    "SubIdentityAdded": Anonymize<Ick3mveut33f44>;
    /**
     * A sub-identity was removed from an identity and the deposit freed.
     */
    "SubIdentityRemoved": Anonymize<Ick3mveut33f44>;
    /**
     * A sub-identity was cleared, and the given deposit repatriated from the
     * main identity account to the sub-identity account.
     */
    "SubIdentityRevoked": Anonymize<Ick3mveut33f44>;
    /**
     * A username authority was added.
     */
    "AuthorityAdded": Anonymize<I2rg5btjrsqec0>;
    /**
     * A username authority was removed.
     */
    "AuthorityRemoved": Anonymize<I2rg5btjrsqec0>;
    /**
     * A username was set for `who`.
     */
    "UsernameSet": Anonymize<Ibdqerrooruuq9>;
    /**
     * A username was queued, but `who` must accept it prior to `expiration`.
     */
    "UsernameQueued": Anonymize<Ifb1u4u75pnv4d>;
    /**
     * A queued username passed its expiration without being claimed and was removed.
     */
    "PreapprovalExpired": Anonymize<I7ieadb293k6b4>;
    /**
     * A username was set as a primary and can be looked up from `who`.
     */
    "PrimaryUsernameSet": Anonymize<Ibdqerrooruuq9>;
    /**
     * A dangling username (as in, a username corresponding to an account that has removed its
     * identity) has been removed.
     */
    "DanglingUsernameRemoved": Anonymize<Ibdqerrooruuq9>;
}>;
export type Iep1lmt6q3s6r3 = {
    "who": SS58String;
    "deposit": bigint;
};
export type I1fac16213rie2 = {
    "who": SS58String;
    "registrar_index": number;
};
export type Ifjt77oc391o43 = {
    "target": SS58String;
    "registrar_index": number;
};
export type Itvt1jsipv0lc = {
    "registrar_index": number;
};
export type Ick3mveut33f44 = {
    "sub": SS58String;
    "main": SS58String;
    "deposit": bigint;
};
export type I2rg5btjrsqec0 = {
    "authority": SS58String;
};
export type Ibdqerrooruuq9 = {
    "who": SS58String;
    "username": Binary;
};
export type Ifb1u4u75pnv4d = {
    "who": SS58String;
    "username": Binary;
    "expiration": bigint;
};
export type I7ieadb293k6b4 = {
    "whose": SS58String;
};
export type I1fgi2uu12f9d9 = AnonymousEnum<{
    /**
     * Batch of dispatches did not complete fully. Index of first failing dispatch given, as
     * well as the error.
     */
    "BatchInterrupted": Anonymize<Iflou98pkqhgp1>;
    /**
     * Batch of dispatches completed fully with no error.
     */
    "BatchCompleted": undefined;
    /**
     * Batch of dispatches completed but has errors.
     */
    "BatchCompletedWithErrors": undefined;
    /**
     * A single item within a Batch of dispatches has completed with no error.
     */
    "ItemCompleted": undefined;
    /**
     * A single item within a Batch of dispatches has completed with error.
     */
    "ItemFailed": Anonymize<Ieosut54dhd8pc>;
    /**
     * A call was dispatched.
     */
    "DispatchedAs": Anonymize<Ibguhqka712ouh>;
}>;
export type Iflou98pkqhgp1 = {
    "index": number;
    "error": Anonymize<Ik9f7r9ibbik9>;
};
export type Ieosut54dhd8pc = {
    "error": Anonymize<Ik9f7r9ibbik9>;
};
export type Ibguhqka712ouh = {
    "result": Anonymize<I5stn0hvret66s>;
};
export type I1vafc8g7b7gkb = AnonymousEnum<{
    /**
     * A new multisig operation has begun.
     */
    "NewMultisig": Anonymize<Iep27ialq4a7o7>;
    /**
     * A multisig operation has been approved by someone.
     */
    "MultisigApproval": Anonymize<I9pa9lkcl3m04m>;
    /**
     * A multisig operation has been executed.
     */
    "MultisigExecuted": Anonymize<I1g53hjmqmckm1>;
    /**
     * A multisig operation has been cancelled.
     */
    "MultisigCancelled": Anonymize<Ic9sq0g5877186>;
}>;
export type I9pa9lkcl3m04m = {
    "approving": SS58String;
    "timepoint": Anonymize<I83nkmvi3lsg6r>;
    "multisig": SS58String;
    "call_hash": FixedSizeBinary<32>;
};
export type I83nkmvi3lsg6r = {
    "height": bigint;
    "index": number;
};
export type I1g53hjmqmckm1 = {
    "approving": SS58String;
    "timepoint": Anonymize<I83nkmvi3lsg6r>;
    "multisig": SS58String;
    "call_hash": FixedSizeBinary<32>;
    "result": Anonymize<I5stn0hvret66s>;
};
export type Ic9sq0g5877186 = {
    "cancelling": SS58String;
    "timepoint": Anonymize<I83nkmvi3lsg6r>;
    "multisig": SS58String;
    "call_hash": FixedSizeBinary<32>;
};
export type Ifbmgqcmcn6k0k = AnonymousEnum<{
    /**
     * A proxy was executed correctly, with the given.
     */
    "ProxyExecuted": Anonymize<Ibguhqka712ouh>;
    /**
     * A pure account has been created by new proxy with given
     * disambiguation index and proxy type.
     */
    "PureCreated": Anonymize<Ica53a2fsmlu8g>;
    /**
     * An announcement was placed to make a call in the future.
     */
    "Announced": Anonymize<I2ur0oeqg495j8>;
    /**
     * A proxy was added.
     */
    "ProxyAdded": Anonymize<I71qkr273g0pbg>;
    /**
     * A proxy was removed.
     */
    "ProxyRemoved": Anonymize<I71qkr273g0pbg>;
}>;
export type Ica53a2fsmlu8g = {
    "pure": SS58String;
    "who": SS58String;
    "proxy_type": Anonymize<I1bpip5bh5877p>;
    "disambiguation_index": number;
};
export type I1bpip5bh5877p = AnonymousEnum<{
    "Any": undefined;
    "NonTransfer": undefined;
    "Governance": undefined;
    "Staking": undefined;
}>;
export type I71qkr273g0pbg = {
    "delegator": SS58String;
    "delegatee": SS58String;
    "proxy_type": Anonymize<I1bpip5bh5877p>;
    "delay": bigint;
};
export type I4eco4p4dqdnac = AnonymousEnum<{
    "NodeRegistered": Anonymize<I6ah8cnfnbkuqo>;
    "MainNodeRegistered": Anonymize<I6ah8cnfnbkuqo>;
    "NodeUnregistered": Anonymize<I6ah8cnfnbkuqo>;
    /**
     * Emitted when multiple nodes are unregistered in a batch
     */
    "NodeUnregisteredBatch": Anonymize<Iafscmv8tjf0ou>;
    "NodeStatusUpdated": Anonymize<I95f1d94gdec1o>;
    /**
     * Fee charging status changed
     */
    "FeeChargingStatusChanged": Anonymize<I94dejtmu6d72i>;
    /**
     * Fee percentage changed
     */
    "FeePercentageChanged": Anonymize<I9fblj87mudkiv>;
    /**
     * Node type fee updated
     */
    "NodeTypeFeeUpdated": Anonymize<I2oet9jl0tboi4>;
    "NodeTypeDisabledChanged": Anonymize<Icimuh915fen06>;
    "NodeOwnerSwapped": Anonymize<Itdoblp90lfe2>;
    "DeregistrationConsensusReached": Anonymize<I6ah8cnfnbkuqo>;
    "DeregistrationConsensusFailed": Anonymize<I6ah8cnfnbkuqo>;
    "AccountBanStatusChanged": Anonymize<I2i9ihlf6tlsua>;
    "WhitelistUpdated": undefined;
    /**
     * A node was successfully verified
     */
    "NodeVerified": Anonymize<I5sa3bg1srbtcp>;
    /**
     * A coldkey node was successfully verified
     */
    "ColdkeyNodeVerified": Anonymize<I5sa3bg1srbtcp>;
    /**
     * Emitted when the de-registration status is changed
     */
    "DeregistrationStatusChanged": Anonymize<I94dejtmu6d72i>;
}>;
export type I6ah8cnfnbkuqo = {
    "node_id": Binary;
};
export type Iafscmv8tjf0ou = {
    /**
     * Number of nodes that were unregistered
     */
    "count": number;
};
export type I95f1d94gdec1o = {
    "node_id": Binary;
    "status": Anonymize<I2jkc6fd285bq3>;
};
export type I2jkc6fd285bq3 = AnonymousEnum<{
    "Online": undefined;
    "Degraded": undefined;
    "Offline": undefined;
}>;
export type I94dejtmu6d72i = {
    "enabled": boolean;
};
export type I9fblj87mudkiv = {
    "new_percentage": number;
};
export type I2oet9jl0tboi4 = {
    "node_type": Anonymize<I9ea6lu6bbueo9>;
    "fee": bigint;
};
export type I9ea6lu6bbueo9 = AnonymousEnum<{
    "Validator": undefined;
    "StorageMiner": undefined;
    "StorageS3": undefined;
    "ComputeMiner": undefined;
    "GpuMiner": undefined;
}>;
export type Icimuh915fen06 = {
    "node_type": Anonymize<I9ea6lu6bbueo9>;
    "disabled": boolean;
};
export type Itdoblp90lfe2 = {
    "node_id": Binary;
    "new_owner": SS58String;
};
export type I2i9ihlf6tlsua = {
    "account": SS58String;
    "banned": boolean;
};
export type I5sa3bg1srbtcp = {
    "node_id": Binary;
    "owner": SS58String;
};
export type Iau0en1i5l2f3e = AnonymousEnum<{
    "BenchmarkStarted": Anonymize<I6ah8cnfnbkuqo>;
    "BenchmarkCompleted": Anonymize<Idenpluu9g8b8j>;
    "BenchmarkFailed": Anonymize<Idrt2apfs11eis>;
    "NodeSpecsStored": Anonymize<I6ah8cnfnbkuqo>;
    "SignedPayloadProcessed": Anonymize<I4q8er4unru0b9>;
    "PinCheckMetricsUpdated": Anonymize<I6ah8cnfnbkuqo>;
    "PurgeDeregisteredNodesStatusChanged": Anonymize<I94dejtmu6d72i>;
    /**
     * Emitted when storage size is below 2TB.
     */
    "StorageBelowTwoTB": Anonymize<I6ah8cnfnbkuqo>;
    /**
     * Emitted when primary network interface is not provided.
     */
    "NoPrimaryNetworkInterface": Anonymize<I6ah8cnfnbkuqo>;
    /**
     * Emitted when disks array is empty.
     */
    "EmptyDisksArray": Anonymize<I6ah8cnfnbkuqo>;
    "MemoryExceedsFiveTB": Anonymize<I6ah8cnfnbkuqo>;
    "ConsensusReached": Anonymize<I8sqgsmt3nkhst>;
    "ConsensusFailed": Anonymize<Iu15sgmdgsi1p>;
}>;
export type Idenpluu9g8b8j = {
    "node_id": Binary;
    "metrics": {
        "cpu_score": number;
        "memory_score": number;
        "storage_score": number;
        "disk_score": number;
        "network_score": number;
    };
    "final_score": number;
};
export type Idrt2apfs11eis = {
    "node_id": Binary;
    "error": Enum<{
        "LockAcquisitionFailed": undefined;
        "HardwareCheckFailed": undefined;
        "BenchmarkExecutionFailed": undefined;
        "MetricsNotFound": undefined;
    }>;
};
export type I4q8er4unru0b9 = {
    "signer": FixedSizeBinary<32>;
    "payload": Binary;
    "signature": Binary;
    "node_id": Binary;
};
export type I8sqgsmt3nkhst = {
    "miner_id": Binary;
    "total_pin_checks": number;
    "successful_pin_checks": number;
};
export type Iu15sgmdgsi1p = {
    "miner_id": Binary;
};
export type Iespmrk3s62imr = AnonymousEnum<{
    /**
     * Emitted when hot keys are updated
     */
    "HotKeysUpdated": Anonymize<I7v7gll3do8k87>;
    /**
     * Emitted when a payload is signed and processed
     */
    "SignedPayloadProcessed": Anonymize<I4etue4v1vop9d>;
    /**
     * Emitted when storage is updated
     */
    "StorageUpdated": Anonymize<I3p9almsc035kf>;
    /**
     * Emitted when validator trust points are updated
     */
    "ValidatorTrustUpdated": Anonymize<Ic8slrb9jkor44>;
    /**
     * A validator was added to the whitelist
     */
    "WhitelistedValidatorAdded": Anonymize<I9acqruh7322g2>;
    /**
     * A validator was removed from the whitelist
     */
    "WhitelistedValidatorRemoved": Anonymize<I9acqruh7322g2>;
}>;
export type I7v7gll3do8k87 = {
    "count": number;
    "validators": number;
    "miners": number;
};
export type I4etue4v1vop9d = {
    /**
     * The signer's key
     */
    "signer": FixedSizeBinary<32>;
    /**
     * The payload that was signed
     */
    "payload": Binary;
    /**
     * The signature
     */
    "signature": Binary;
    /**
     * Number of hot keys processed
     */
    "hot_keys_count"?: Anonymize<I4arjljr6dpflb>;
};
export type I3p9almsc035kf = {
    /**
     * Number of UIDs in storage
     */
    "uids_count": number;
};
export type Ic8slrb9jkor44 = {
    "validator": SS58String;
    "points": number;
};
export type I9acqruh7322g2 = {
    "validator": SS58String;
};
export type I9jban0pha1pe7 = AnonymousEnum<{
    /**
     * CDN location added
     */
    "CdnLocationAdded": Anonymize<Ic5b47dj4coa3r>;
    /**
     * Auto-renewal status updated
     */
    "AutoRenewalUpdated": Anonymize<I4pplpbc9ri87h>;
    "SubscriptionTransferred": Anonymize<Idfddce516cam8>;
    "TokensBurned": Anonymize<I3qt1hgg4djhgb>;
    "PackageSuspensionSet": Anonymize<I4jk88c81fdpj7>;
    "PinRequested": Anonymize<Iblmvi7rns4hat>;
    "UnpinRequestAdded": Anonymize<I1ncftf0dda44b>;
    "StorageRequestAdded": Anonymize<I4017m8vg7mg77>;
    "StoragePlanPriceUpdated": Anonymize<Ifbfri4ebdp100>;
    "ComputePlanPriceUpdated": Anonymize<Ia0ou717s993mj>;
    "PointTransactionRecorded": Anonymize<I81ecksq9ft26q>;
    "PlanPurchased": Anonymize<Ifg11tc1e56rdc>;
    "FileHashCleanedUp": Anonymize<Ib7rbng5pdr5s8>;
    "PricePerGbUpdated": Anonymize<I6h5nf3idmn898>;
    "PricePerBandwidthUpdated": Anonymize<I6h5nf3idmn898>;
    "StorageSubscriptionCancelled": Anonymize<I4cbvqmqadhrea>;
    "ComputeSubscriptionCancelled": Anonymize<I4cbvqmqadhrea>;
    "BackupEnabled": Anonymize<I3l0mkl2i9jnf2>;
    "BackupDisabled": Anonymize<I3l0mkl2i9jnf2>;
    "OSDiskImageUrlSet": Anonymize<Ibjfehbtn97bsa>;
    "PlanPriceUpdated": Anonymize<I5spuldj7iqfb2>;
    /**
     * Specific miner request fee updated
     */
    "SpecificMinerRequestFeeUpdated": Anonymize<Ib1ilbm5ipoh62>;
    "BatchDeposited": Anonymize<Iercff15akpdf4>;
    "CreditsConsumed": Anonymize<I9vi4snjoo3h4b>;
    "StorageOperationsStatusChanged": Anonymize<I94dejtmu6d72i>;
    /**
     * Purchase plan status was changed
     */
    "PurchasePlanStatusChanged": Anonymize<I94dejtmu6d72i>;
}>;
export type Ic5b47dj4coa3r = {
    "id": number;
};
export type I4pplpbc9ri87h = {
    "who": SS58String;
    "subscription_id": number;
    "enabled": boolean;
};
export type Idfddce516cam8 = {
    "from": SS58String;
    "to": SS58String;
    "subscription_id": number;
};
export type I4jk88c81fdpj7 = [FixedSizeBinary<32>, boolean];
export type Iblmvi7rns4hat = {
    "who": SS58String;
    "file_hash": Binary;
    "replicas": number;
};
export type I1ncftf0dda44b = {
    "caller": SS58String;
    "owner": SS58String;
    "file_hash": Binary;
};
export type I4017m8vg7mg77 = {
    "caller": SS58String;
    "owner": SS58String;
    "files_input": Anonymize<Ibefmjheg1a3em>;
};
export type Ibefmjheg1a3em = Array<{
    "file_hash": Binary;
    "file_name": Binary;
}>;
export type Ifbfri4ebdp100 = {
    "plan_id": FixedSizeBinary<32>;
    "new_price_per_gb": number;
};
export type Ia0ou717s993mj = {
    "plan_id": FixedSizeBinary<32>;
    "new_price_per_block": number;
};
export type I81ecksq9ft26q = {
    "who": SS58String;
    "transaction_type": Anonymize<Ia9h92356vsmef>;
    "amount": bigint;
};
export type Ia9h92356vsmef = AnonymousEnum<{
    "Purchase": undefined;
    "Subscription": undefined;
    "Refund": undefined;
    "Transfer": undefined;
}>;
export type Ifg11tc1e56rdc = {
    "caller": SS58String;
    "owner": SS58String;
    "plan_id": FixedSizeBinary<32>;
    "location_id"?: Anonymize<I4arjljr6dpflb>;
    "selected_image_name"?: Anonymize<Iabpgqcjikia83>;
    "cloud_init_cid"?: Anonymize<Iabpgqcjikia83>;
};
export type Ib7rbng5pdr5s8 = {
    "subscription_id": number;
    "file_hash": Binary;
};
export type I6h5nf3idmn898 = {
    "price": bigint;
};
export type I3l0mkl2i9jnf2 = {
    "caller": SS58String;
    "account": SS58String;
};
export type Ibjfehbtn97bsa = {
    "os_name": Binary;
    "url": Binary;
};
export type Ib1ilbm5ipoh62 = {
    "fee": bigint;
};
export type Iercff15akpdf4 = {
    "owner": SS58String;
    "batch_id": bigint;
};
export type I9vi4snjoo3h4b = {
    "owner": SS58String;
    "credits": bigint;
};
export type I1mkips9o62jhg = AnonymousEnum<{
    /**
     * A sub account has been added
     */
    "SubAccountAdded": Anonymize<Idsvjrg7b991is>;
    /**
     * A sub account has been removed
     */
    "SubAccountRemoved": Anonymize<Ie4intrc3n8jfu>;
    /**
     * A sub account's role has been updated
     */
    "SubAccountRoleUpdated": Anonymize<I1etdvmasu1v94>;
}>;
export type Idsvjrg7b991is = {
    "main": SS58String;
    "sub": SS58String;
    "role": Anonymize<I15h251r958qnn>;
};
export type I15h251r958qnn = AnonymousEnum<{
    "Upload": undefined;
    "UploadDelete": undefined;
    "None": undefined;
}>;
export type Ie4intrc3n8jfu = {
    "main": SS58String;
    "sub": SS58String;
};
export type I1etdvmasu1v94 = {
    "main": SS58String;
    "sub": SS58String;
    "new_role": Anonymize<I15h251r958qnn>;
};
export type Ia263kraiqgd7u = AnonymousEnum<{
    /**
     * Notification sent (sender, recipient, block number)
     */
    "NotificationSent": Anonymize<Ib6f67cbu0ud37>;
    /**
     * Notification marked as read (recipient, index)
     */
    "NotificationRead": Anonymize<I6ouflveob4eli>;
    "SubscriptionHasEnded": Anonymize<I1kk4k738d2nd8>;
    "SubscriptionEndingSoon": Anonymize<I1kk4k738d2nd8>;
    "AccountBanned": Anonymize<Icbccs0ug47ilf>;
}>;
export type Ib6f67cbu0ud37 = [SS58String, SS58String, bigint];
export type I1kk4k738d2nd8 = {
    "recipient": SS58String;
    "subscription_id": number;
    "expired_at": bigint;
};
export type I3pp8f8uhsees6 = AnonymousEnum<{
    /**
     * A public item was added or updated. [who, item]
     */
    "PublicItemSet": Anonymize<I92tce08cbhnmn>;
    /**
     * A private item was added or updated. [who, item]
     */
    "PrivateItemSet": Anonymize<I92tce08cbhnmn>;
    /**
     * A username was set. [who, username]
     */
    "UsernameSet": Anonymize<I92tce08cbhnmn>;
    "DataPublicKeySet": SS58String;
    /**
     * A message public key was set. [who]
     */
    "MessagePublicKeySet": SS58String;
}>;
export type I92tce08cbhnmn = [SS58String, Binary];
export type If1tghl0loi5k7 = AnonymousEnum<{
    "SomethingStored": Anonymize<I2motmr03c9658>;
    "RankingsUpdated": Anonymize<Iafscmv8tjf0ou>;
    "RewardDistributed": Anonymize<Ic262ibdoec56a>;
    "RankDistributionLimitUpdated": Anonymize<I1il5mj68vvsms>;
}>;
export type I2motmr03c9658 = {
    "something": number;
    "who": SS58String;
};
export type Icc8a3tvhmo74f = AnonymousEnum<{
    "MintedAccountCredits": Anonymize<Id5fm4p8lj5qgi>;
    "BurnedAccountCredits": Anonymize<Id5fm4p8lj5qgi>;
    "AuthorityAdded": Anonymize<I4cbvqmqadhrea>;
    "AuthorityRemoved": Anonymize<I4cbvqmqadhrea>;
    "ConvertedToCredits": Anonymize<Id5fm4p8lj5qgi>;
    "CreditLocked": Anonymize<I88fot44bnslov>;
    "CreditFulfilled": Anonymize<Ieci754e21flil>;
    "AlphaPriceSet": Anonymize<Id7sgl9r2a73an>;
    "MinLockAmountSet": Anonymize<Id5fm4p8lj5qgi>;
    /**
     * Event emitted when a referral discount is applied
     */
    "ReferralDiscountApplied": Anonymize<I3vte5us4num84>;
    "ConvertedToAlpha": Anonymize<Id5fm4p8lj5qgi>;
    "IncreasedUserBalance": Anonymize<I8vi912pe5tcr7>;
}>;
export type I88fot44bnslov = {
    "who": SS58String;
    "amount": bigint;
    "id": bigint;
};
export type Ieci754e21flil = {
    "account_id": SS58String;
    "id": bigint;
    "tx_hash": Binary;
};
export type Id7sgl9r2a73an = {
    "price": bigint;
    "who": SS58String;
};
export type I3vte5us4num84 = {
    "referral_code": Binary;
    "ref_owner": SS58String;
    "discount_amount": bigint;
};
export type I8vi912pe5tcr7 = {
    "who": SS58String;
    "marketplace_credit_amount": bigint;
    "alpha_amount": bigint;
};
export type I5474kjbb5l04k = AnonymousEnum<{
    /**
     * A new space was created [space_id, owner]
     */
    "SpaceCreated": Anonymize<I96rqo4i9p11oo>;
    /**
     * A member was added to a space [space_id, member]
     */
    "MemberAdded": Anonymize<I96rqo4i9p11oo>;
    /**
     * A manifest digest was updated [repo_name, image_name, tag, digest]
     */
    "ManifestDigestUpdated": Anonymize<I7bn9n98cqhjfq>;
    /**
     * A new mapping of image name + digest to CID was stored
     */
    "ImageDigestToCidStored": Anonymize<Ia6h3b4okf7ksl>;
    /**
     * Digest information successfully stored
     */
    "DigestInfoStored": Anonymize<I2pjn1un8imcq7>;
}>;
export type I7bn9n98cqhjfq = FixedSizeArray<4, Binary>;
export type Ia6h3b4okf7ksl = {
    "who": SS58String;
    "image_name": Binary;
    "digest": Binary;
    "cid": Binary;
};
export type I2pjn1un8imcq7 = {
    "who": SS58String;
    "digest": Binary;
    "digest_type": Anonymize<I74v6trvb7j58h>;
    "cid": Binary;
};
export type I74v6trvb7j58h = AnonymousEnum<{
    "File": undefined;
    "Json": undefined;
}>;
export type Ibdesbk77aplmk = AnonymousEnum<{
    /**
     * Guardian attested a deposit (vote for success)
     */
    "DepositAttested": Anonymize<I1tckflje7cjv>;
    /**
     * Deposit completed - hAlpha credited to recipient
     */
    "DepositCompleted": Anonymize<Ib5s1ffmflb3qm>;
    /**
     * Deposit cancelled by admin after stuck
     */
    "DepositCancelled": Anonymize<I99kjujp4cntp>;
    /**
     * User created a withdrawal request (hAlpha burned)
     */
    "WithdrawalRequestCreated": Anonymize<I4tti5pllg262l>;
    /**
     * Withdrawal request marked as failed by admin (hAlpha manually minted back)
     */
    "WithdrawalRequestFailed": Anonymize<Ifs1i5fk9cqvr6>;
    /**
     * Admin manually minted hAlpha to a recipient (for stuck withdrawals)
     */
    "AdminManualMint": Anonymize<Ifkr43tqovhaij>;
    /**
     * Bridge paused
     */
    "Paused": undefined;
    /**
     * Bridge unpaused
     */
    "Unpaused": undefined;
    /**
     * Global mint cap updated
     */
    "GlobalMintCapUpdated": Anonymize<If0m30u84ipduc>;
    /**
     * Guardians and threshold updated atomically
     */
    "GuardiansUpdated": Anonymize<Iart6p0ogm1a4g>;
    /**
     * Minimum withdrawal amount updated
     */
    "MinWithdrawalAmountUpdated": Anonymize<If8q631vdal219>;
    /**
     * Deposit record cleaned up after TTL
     */
    "DepositCleanedUp": Anonymize<Ifs1i5fk9cqvr6>;
    /**
     * Withdrawal request record cleaned up after TTL
     */
    "WithdrawalRequestCleanedUp": Anonymize<Ifs1i5fk9cqvr6>;
    /**
     * Cleanup TTL updated
     */
    "CleanupTTLUpdated": Anonymize<Iaqm07nd3jnjm3>;
}>;
export type I1tckflje7cjv = {
    "id": FixedSizeBinary<32>;
    "guardian": SS58String;
};
export type Ib5s1ffmflb3qm = {
    "id": FixedSizeBinary<32>;
    "recipient": SS58String;
    "amount": bigint;
};
export type I99kjujp4cntp = {
    "id": FixedSizeBinary<32>;
    "reason": Anonymize<I8tfql2anqh1fg>;
};
export type I8tfql2anqh1fg = AnonymousEnum<{
    "AdminEmergency": undefined;
}>;
export type I4tti5pllg262l = {
    "id": FixedSizeBinary<32>;
    "sender": SS58String;
    "recipient": SS58String;
    "amount": bigint;
};
export type Ifkr43tqovhaij = {
    "recipient": SS58String;
    "amount": bigint;
    /**
     * Optional deposit ID for audit trail
     */
    "deposit_id"?: Anonymize<I4s6vifaf8k998>;
};
export type If0m30u84ipduc = {
    "new_cap": bigint;
};
export type Iart6p0ogm1a4g = {
    "guardians": Anonymize<Ia2lhg7l2hilo3>;
    "approve_threshold": number;
};
export type If8q631vdal219 = {
    "old_amount": bigint;
    "new_amount": bigint;
};
export type Iaqm07nd3jnjm3 = {
    "old_ttl": bigint;
    "new_ttl": bigint;
};
export type Ic3avj73bju5u2 = AnonymousEnum<{
    "IpAssigned": Anonymize<I91984ic727015>;
    "IpReturned": Anonymize<I38bt9hnqlio44>;
    "IpRetrieved": Anonymize<I38bt9hnqlio44>;
    "IpAdded": Anonymize<I91984ic727015>;
    "IpRemoved": Anonymize<I91984ic727015>;
}>;
export type I91984ic727015 = {
    "ip": Binary;
};
export type I38bt9hnqlio44 = {
    "vm_uuid": Binary;
    "ip": Binary;
};
export type I3koatptgmpvu6 = AnonymousEnum<{
    "SomethingStored": Anonymize<I2motmr03c9658>;
    "StorageRequestUpdated": Anonymize<I1udjuelukvhag>;
    "UnpinRequestCompleted": Anonymize<I1udjuelukvhag>;
    "PinningEnabledChanged": Anonymize<I94dejtmu6d72i>;
    "MinerProfilesUpdated": Anonymize<I1lhs3d4ekov9p>;
    "StorageRequestsCleared": undefined;
    "ReputationPointsUpdated": Anonymize<Ia2msbpam1cji1>;
    "RotationStatusChanged": boolean;
    /**
     * A user's storage request was removed due to IPFS unavailability
     */
    "IpfsUnavailable": Anonymize<I7ckaemrn32ju>;
    "UserProfileUpdated": Anonymize<Idu6bl8365ot38>;
    "UsersProfilesUpdated": undefined;
    "MinersProfilesUpdated": undefined;
    "MinerProfileUpdated": Anonymize<I2k4l82jgghpug>;
    /**
     * Emitted when validator is rotated at the beginning of a new epoch.
     */
    "ValidatorRotated": Anonymize<Ic6k2eeen6ajgt>;
    /**
     * Emitted when storage requests are closed by the validator
     */
    "StorageRequestsClosed": Anonymize<I8ri442nsb40lv>;
    /**
     * Emitted when unpin requests are closed by the validator
     */
    "UnpinRequestsClosed": Anonymize<I8ri442nsb40lv>;
}>;
export type I1udjuelukvhag = {
    "owner": SS58String;
    "file_hash": Binary;
    "file_size": bigint;
};
export type I1lhs3d4ekov9p = {
    "miner_count": number;
};
export type Ia2msbpam1cji1 = {
    "coldkey": SS58String;
    "points": number;
};
export type I7ckaemrn32ju = {
    "owner": SS58String;
    "file_hash": Binary;
};
export type Idu6bl8365ot38 = {
    "owner": SS58String;
    "cid": Binary;
};
export type I2k4l82jgghpug = {
    "miner_node_id": Binary;
    "cid": Binary;
};
export type Ic6k2eeen6ajgt = {
    "new_validator": SS58String;
    "epoch_start_block": bigint;
};
export type I8ri442nsb40lv = {
    "validator": SS58String;
    "file_hashes": Anonymize<Itom7fk49o0c9>;
};
export type I146vjraq6ao3p = AnonymousEnum<{
    /**
     * A new CRUSH epoch was published.
     */
    "CrushMapPublished": Anonymize<Ibnl9iu19ttf33>;
    /**
     * Miner stats were updated for a bucket.
     */
    "MinerStatsUpdated": Anonymize<I3btqr02g3j6t5>;
    /**
     * Attestations were submitted for a bucket.
     */
    "AttestationsSubmitted": Anonymize<I60f9q2drfiblu>;
    /**
     * Attestation commitment was submitted for an epoch.
     */
    "AttestationCommitmentSubmitted": Anonymize<Idb9q16jbip9cv>;
    /**
     * A child node was registered under a family.
     */
    "ChildRegistered": Anonymize<Id7emp2djki762>;
    /**
     * A child node was deregistered and entered unbonding.
     */
    "ChildDeregistered": Anonymize<Idff3go57k37mm>;
    /**
     * A child’s deposit was unbonded and released.
     */
    "ChildUnbonded": Anonymize<Ie4guudbjqttqv>;
    /**
     * Node weights were updated for a bucket.
     */
    "NodeWeightsUpdated": Anonymize<I3btqr02g3j6t5>;
    /**
     * Family weights were recomputed for a bucket.
     */
    "FamilyWeightsComputed": Anonymize<I7uk77lejof7mb>;
    /**
     * Registration lockup was enabled/disabled by admin.
     */
    "LockupEnabledSet": Anonymize<I94dejtmu6d72i>;
    /**
     * Base child deposit floor was set by admin.
     */
    "BaseChildDepositSet": Anonymize<I1fm7b684mo0pb>;
    /**
     * A warden was registered and authorized to submit attestations.
     */
    "WardenRegistered": Anonymize<Idftouvduud2qb>;
    /**
     * A warden was deregistered and can no longer submit attestations.
     */
    "WardenDeregistered": Anonymize<Ifsg9bn8i41e00>;
    /**
     * Old attestation buckets were pruned.
     */
    "AttestationBucketsPruned": Anonymize<I4u87dkg0ej74m>;
}>;
export type Ibnl9iu19ttf33 = {
    "epoch": bigint;
    "miners": number;
    "root": FixedSizeBinary<32>;
};
export type I3btqr02g3j6t5 = {
    "bucket": number;
    "updates": number;
};
export type I60f9q2drfiblu = {
    "bucket": number;
    "count": number;
};
export type Idb9q16jbip9cv = {
    "epoch": bigint;
    "attestation_count": number;
    "attestation_merkle_root": FixedSizeBinary<32>;
    "warden_pubkey_merkle_root": FixedSizeBinary<32>;
};
export type Id7emp2djki762 = {
    "family": SS58String;
    "child": SS58String;
    "node_id": FixedSizeBinary<32>;
    "deposit": bigint;
};
export type Idff3go57k37mm = {
    "family": SS58String;
    "child": SS58String;
    "node_id": FixedSizeBinary<32>;
    "unbonding_end": bigint;
    "cooldown_end": bigint;
};
export type Ie4guudbjqttqv = {
    "family": SS58String;
    "child": SS58String;
    "node_id": FixedSizeBinary<32>;
    "amount": bigint;
};
export type I7uk77lejof7mb = {
    "bucket": number;
    "families": number;
};
export type I1fm7b684mo0pb = {
    "deposit": bigint;
};
export type Idftouvduud2qb = {
    "warden_pubkey": FixedSizeBinary<32>;
    "registered_at": bigint;
};
export type Ifsg9bn8i41e00 = {
    "warden_pubkey": FixedSizeBinary<32>;
    "deregistered_at": bigint;
};
export type I4u87dkg0ej74m = {
    "pruned_count": number;
    "oldest_remaining": number;
};
export type Ifip05kcrl65am = Array<Anonymize<I6cs1itejju2vv>>;
export type I3qklfjubrljqh = {
    "owner": SS58String;
    "issuer": SS58String;
    "admin": SS58String;
    "freezer": SS58String;
    "supply": bigint;
    "deposit": bigint;
    "min_balance": bigint;
    "is_sufficient": boolean;
    "accounts": number;
    "sufficients": number;
    "approvals": number;
    "status": Enum<{
        "Live": undefined;
        "Frozen": undefined;
        "Destroying": undefined;
    }>;
};
export type Iag3f1hum3p4c8 = {
    "balance": bigint;
    "status": Enum<{
        "Liquid": undefined;
        "Frozen": undefined;
        "Blocked": undefined;
    }>;
    "reason": Enum<{
        "Consumer": undefined;
        "Sufficient": undefined;
        "DepositHeld": bigint;
        "DepositRefunded": undefined;
        "DepositFrom": Anonymize<I95l2k9b1re95f>;
    }>;
};
export type I4s6jkha20aoh0 = {
    "amount": bigint;
    "deposit": bigint;
};
export type I6lsoh4c5um3u5 = [bigint, SS58String, SS58String];
export type I78s05f59eoi8b = {
    "deposit": bigint;
    "name": Binary;
    "symbol": Binary;
    "decimals": number;
    "is_frozen": boolean;
};
export type Icg2f7lij7mhun = Array<{
    "id": WestendRuntimeRuntimeHoldReason;
    "amount": bigint;
}>;
export type WestendRuntimeRuntimeHoldReason = Enum<{
    "Preimage": PreimagePalletHoldReason;
}>;
export declare const WestendRuntimeRuntimeHoldReason: GetEnum<WestendRuntimeRuntimeHoldReason>;
export type I2l1ctuihi2mfd = Array<{
    "id": WestendRuntimeRuntimeFreezeReason;
    "amount": bigint;
}>;
export type WestendRuntimeRuntimeFreezeReason = Enum<{
    "NominationPools": NominationPoolsPalletFreezeReason;
}>;
export declare const WestendRuntimeRuntimeFreezeReason: GetEnum<WestendRuntimeRuntimeFreezeReason>;
export type NominationPoolsPalletFreezeReason = Enum<{
    "PoolMinBalance": undefined;
}>;
export declare const NominationPoolsPalletFreezeReason: GetEnum<NominationPoolsPalletFreezeReason>;
export type BabeDigestsNextConfigDescriptor = Enum<{
    "V1": Anonymize<I8jnd4d8ip6djo>;
}>;
export declare const BabeDigestsNextConfigDescriptor: GetEnum<BabeDigestsNextConfigDescriptor>;
export type Idq7or56ds2f13 = (BabeDigestsPreDigest) | undefined;
export type BabeDigestsPreDigest = Enum<{
    "Primary": {
        "authority_index": number;
        "slot": bigint;
        "vrf_signature": {
            "pre_output": FixedSizeBinary<32>;
            "proof": FixedSizeBinary<64>;
        };
    };
    "SecondaryPlain": {
        "authority_index": number;
        "slot": bigint;
    };
    "SecondaryVRF": {
        "authority_index": number;
        "slot": bigint;
        "vrf_signature": {
            "pre_output": FixedSizeBinary<32>;
            "proof": FixedSizeBinary<64>;
        };
    };
}>;
export declare const BabeDigestsPreDigest: GetEnum<BabeDigestsPreDigest>;
export type Ia24s7cuas271t = AnonymousEnum<{
    "Live": undefined;
    "PendingPause": {
        "scheduled_at": bigint;
        "delay": bigint;
    };
    "Paused": undefined;
    "PendingResume": {
        "scheduled_at": bigint;
        "delay": bigint;
    };
}>;
export type I30cqmm2kaidet = {
    "scheduled_at": bigint;
    "delay": bigint;
    "next_authorities": Anonymize<I3geksg000c171>;
    "forced"?: Anonymize<I35p85j063s0il>;
};
export type Iff9heri56m1mb = [SS58String, bigint, boolean];
export type I6mhebgj62g585 = Array<[number, PreimagesBounded, SS58String]>;
export type I3vhcedhm4hpvm = [Anonymize<Ia2lhg7l2hilo3>, bigint];
export type Ianoje3qpmo6md = AnonymousEnum<{
    "Ongoing": {
        "end": bigint;
        "proposal": PreimagesBounded;
        "threshold": Anonymize<Ivbp9821csvot>;
        "delay": bigint;
        "tally": {
            "ayes": bigint;
            "nays": bigint;
            "turnout": bigint;
        };
    };
    "Finished": {
        "approved": boolean;
        "end": bigint;
    };
}>;
export type Ia3t44vpf24cgg = AnonymousEnum<{
    "Direct": {
        "votes": Array<[number, Anonymize<Ia9hdots6g53fs>]>;
        "delegations": Anonymize<I538qha8r4j3ii>;
        "prior": Anonymize<I2j729bmgsdiuo>;
    };
    "Delegating": {
        "balance": bigint;
        "target": SS58String;
        "conviction": VotingConviction;
        "delegations": Anonymize<I538qha8r4j3ii>;
        "prior": Anonymize<I2j729bmgsdiuo>;
    };
}>;
export type I538qha8r4j3ii = {
    "votes": bigint;
    "capital": bigint;
};
export type VotingConviction = Enum<{
    "None": undefined;
    "Locked1x": undefined;
    "Locked2x": undefined;
    "Locked3x": undefined;
    "Locked4x": undefined;
    "Locked5x": undefined;
    "Locked6x": undefined;
}>;
export declare const VotingConviction: GetEnum<VotingConviction>;
export type I5rsgtofmn5lli = [PreimagesBounded, Anonymize<Ivbp9821csvot>];
export type I4nfjdef0ibh44 = [bigint, Anonymize<Ia2lhg7l2hilo3>];
export type If4gigsesqmr49 = AnonymousEnum<{
    "System": Anonymize<Iekve0i6djpd9f>;
    "Timestamp": Anonymize<I7d75gqfg6jh9c>;
    "Sudo": Anonymize<Ifhveqc2vs0its>;
    "Assets": Anonymize<Ibst48ouacp9pu>;
    "Balances": Anonymize<I9fktnrlinnre4>;
    "Babe": Anonymize<I51vts28k29dlt>;
    "Grandpa": Anonymize<I5euviv4mm0m1h>;
    "Indices": Anonymize<Iehgup0qh1t3vb>;
    "Democracy": Anonymize<I6a6pet7i0s1k9>;
    "Council": Anonymize<I31kl3f1t2gm2d>;
    "Vesting": Anonymize<Ipooq4a014iq3>;
    "Elections": Anonymize<I6ab0pou3i8npt>;
    "ElectionProviderMultiPhase": Anonymize<I15soeogelbbbh>;
    "Staking": Anonymize<I9p7hu9tlck2uk>;
    "Session": Anonymize<Ia7mlrjeasn8qd>;
    "Treasury": Anonymize<I82abq3hsudkhd>;
    "Bounties": Anonymize<Id3i1hd0p5rkpe>;
    "ChildBounties": Anonymize<Iq2t6ejghtjp4>;
    "BagsList": Anonymize<Iddr6fva4nhp6t>;
    "NominationPools": Anonymize<I5optopuv2imd3>;
    "Scheduler": Anonymize<Iav5p1kohai2ld>;
    "Preimage": Anonymize<If81ks88t5mpk5>;
    "TxPause": Anonymize<Ieci88jft3cpv9>;
    "ImOnline": Anonymize<I4ajpuk9u575ko>;
    "Identity": Anonymize<Id4c1d4j757ojr>;
    "Utility": Anonymize<Ibmunqn0a7cftp>;
    "Multisig": Anonymize<I9otac0gkq8htr>;
    "Ethereum": Anonymize<Icu3fce0sripq4>;
    "EVM": Anonymize<I816pc1os2b38d>;
    "DynamicFee": Anonymize<Ie18f12l062q2m>;
    "BaseFee": Anonymize<I2aqcjbjlffus>;
    "HotfixSufficients": Anonymize<Ibt56711n0s799>;
    "Proxy": Anonymize<I52uc2hlov119i>;
    "Registration": Anonymize<I25up9680hc62l>;
    "ExecutionUnit": Anonymize<I38f3g1rtihufr>;
    "Metagraph": Anonymize<Iege5uhb98da5f>;
    "Marketplace": Anonymize<If40ds04ce1tf>;
    "SubAccount": Anonymize<Ie1s8d7rc54d79>;
    "Notifications": Anonymize<Ia2v9fnslducq5>;
    "AccountProfile": Anonymize<I6vn20en55t8sa>;
    "Utils": Anonymize<Ifssa3g4o3ro7r>;
    "RankingStorage": Anonymize<If18kioql47l8j>;
    "RankingCompute": Anonymize<If18kioql47l8j>;
    "RankingValidators": Anonymize<If18kioql47l8j>;
    "Credits": Anonymize<Idfi3eu3jc3icv>;
    "ContainerRegistry": Anonymize<I1str8i2jc1f9f>;
    "AlphaBridge": Anonymize<I7lo258er1fjig>;
    "PalletIp": Anonymize<I4vmas8antd12l>;
    "IpfsPallet": Anonymize<Icm50dar8ebmm2>;
    "Arion": Anonymize<I3qt48j97a00ls>;
}>;
export type Ifhveqc2vs0its = AnonymousEnum<{
    /**
     * Authenticates the sudo key and dispatches a function call with `Root` origin.
     */
    "sudo": Anonymize<Ico5mjpqfgtpuj>;
    /**
     * Authenticates the sudo key and dispatches a function call with `Root` origin.
     * This function does not check the weight of the call, and instead allows the
     * Sudo user to specify the weight of the call.
     *
     * The dispatch origin for this call must be _Signed_.
     */
    "sudo_unchecked_weight": Anonymize<I46s97719jsq03>;
    /**
     * Authenticates the current sudo key and sets the given AccountId (`new`) as the new sudo
     * key.
     */
    "set_key": Anonymize<I79cmnv5q6b3p>;
    /**
     * Authenticates the sudo key and dispatches a function call with `Signed` origin from
     * a given account.
     *
     * The dispatch origin for this call must be _Signed_.
     */
    "sudo_as": Anonymize<If1fboivengemn>;
    /**
     * Permanently removes the sudo key.
     *
     * **This cannot be un-done.**
     */
    "remove_key": undefined;
}>;
export type Ico5mjpqfgtpuj = {
    "call": TxCallData;
};
export type I46s97719jsq03 = {
    "call": TxCallData;
    "weight": Anonymize<I4q39t5hn830vp>;
};
export type I79cmnv5q6b3p = {
    "new": Anonymize<I4su1fqci7afjt>;
};
export type I4su1fqci7afjt = AnonymousEnum<{
    "Id": SS58String;
    "Index": number;
    "Raw": Binary;
    "Address32": FixedSizeBinary<32>;
    "Address20": FixedSizeBinary<20>;
}>;
export type If1fboivengemn = {
    "who": Anonymize<I4su1fqci7afjt>;
    "call": TxCallData;
};
export type Ibst48ouacp9pu = AnonymousEnum<{
    /**
     * Issue a new class of fungible assets from a public origin.
     *
     * This new asset class has no assets initially and its owner is the origin.
     *
     * The origin must conform to the configured `CreateOrigin` and have sufficient funds free.
     *
     * Funds of sender are reserved by `AssetDeposit`.
     *
     * Parameters:
     * - `id`: The identifier of the new asset. This must not be currently in use to identify
     * an existing asset. If [`NextAssetId`] is set, then this must be equal to it.
     * - `admin`: The admin of this class of assets. The admin is the initial address of each
     * member of the asset class's admin team.
     * - `min_balance`: The minimum balance of this new asset that any single account must
     * have. If an account's balance is reduced below this, then it collapses to zero.
     *
     * Emits `Created` event when successful.
     *
     * Weight: `O(1)`
     */
    "create": Anonymize<Ibh0d53vr9icth>;
    /**
     * Issue a new class of fungible assets from a privileged origin.
     *
     * This new asset class has no assets initially.
     *
     * The origin must conform to `ForceOrigin`.
     *
     * Unlike `create`, no funds are reserved.
     *
     * - `id`: The identifier of the new asset. This must not be currently in use to identify
     * an existing asset. If [`NextAssetId`] is set, then this must be equal to it.
     * - `owner`: The owner of this class of assets. The owner has full superuser permissions
     * over this asset, but may later change and configure the permissions using
     * `transfer_ownership` and `set_team`.
     * - `min_balance`: The minimum balance of this new asset that any single account must
     * have. If an account's balance is reduced below this, then it collapses to zero.
     *
     * Emits `ForceCreated` event when successful.
     *
     * Weight: `O(1)`
     */
    "force_create": Anonymize<I2sr30isvv1i3a>;
    /**
     * Start the process of destroying a fungible asset class.
     *
     * `start_destroy` is the first in a series of extrinsics that should be called, to allow
     * destruction of an asset class.
     *
     * The origin must conform to `ForceOrigin` or must be `Signed` by the asset's `owner`.
     *
     * - `id`: The identifier of the asset to be destroyed. This must identify an existing
     * asset.
     *
     * The asset class must be frozen before calling `start_destroy`.
     */
    "start_destroy": Anonymize<I4ov6e94l79mbg>;
    /**
     * Destroy all accounts associated with a given asset.
     *
     * `destroy_accounts` should only be called after `start_destroy` has been called, and the
     * asset is in a `Destroying` state.
     *
     * Due to weight restrictions, this function may need to be called multiple times to fully
     * destroy all accounts. It will destroy `RemoveItemsLimit` accounts at a time.
     *
     * - `id`: The identifier of the asset to be destroyed. This must identify an existing
     * asset.
     *
     * Each call emits the `Event::DestroyedAccounts` event.
     */
    "destroy_accounts": Anonymize<I4ov6e94l79mbg>;
    /**
     * Destroy all approvals associated with a given asset up to the max (T::RemoveItemsLimit).
     *
     * `destroy_approvals` should only be called after `start_destroy` has been called, and the
     * asset is in a `Destroying` state.
     *
     * Due to weight restrictions, this function may need to be called multiple times to fully
     * destroy all approvals. It will destroy `RemoveItemsLimit` approvals at a time.
     *
     * - `id`: The identifier of the asset to be destroyed. This must identify an existing
     * asset.
     *
     * Each call emits the `Event::DestroyedApprovals` event.
     */
    "destroy_approvals": Anonymize<I4ov6e94l79mbg>;
    /**
     * Complete destroying asset and unreserve currency.
     *
     * `finish_destroy` should only be called after `start_destroy` has been called, and the
     * asset is in a `Destroying` state. All accounts or approvals should be destroyed before
     * hand.
     *
     * - `id`: The identifier of the asset to be destroyed. This must identify an existing
     * asset.
     *
     * Each successful call emits the `Event::Destroyed` event.
     */
    "finish_destroy": Anonymize<I4ov6e94l79mbg>;
    /**
     * Mint assets of a particular class.
     *
     * The origin must be Signed and the sender must be the Issuer of the asset `id`.
     *
     * - `id`: The identifier of the asset to have some amount minted.
     * - `beneficiary`: The account to be credited with the minted assets.
     * - `amount`: The amount of the asset to be minted.
     *
     * Emits `Issued` event when successful.
     *
     * Weight: `O(1)`
     * Modes: Pre-existing balance of `beneficiary`; Account pre-existence of `beneficiary`.
     */
    "mint": Anonymize<I4mq3ssndm1dbu>;
    /**
     * Reduce the balance of `who` by as much as possible up to `amount` assets of `id`.
     *
     * Origin must be Signed and the sender should be the Manager of the asset `id`.
     *
     * Bails with `NoAccount` if the `who` is already dead.
     *
     * - `id`: The identifier of the asset to have some amount burned.
     * - `who`: The account to be debited from.
     * - `amount`: The maximum amount by which `who`'s balance should be reduced.
     *
     * Emits `Burned` with the actual amount burned. If this takes the balance to below the
     * minimum for the asset, then the amount burned is increased to take it to zero.
     *
     * Weight: `O(1)`
     * Modes: Post-existence of `who`; Pre & post Zombie-status of `who`.
     */
    "burn": Anonymize<I45oruu1f0aihd>;
    /**
     * Move some assets from the sender account to another.
     *
     * Origin must be Signed.
     *
     * - `id`: The identifier of the asset to have some amount transferred.
     * - `target`: The account to be credited.
     * - `amount`: The amount by which the sender's balance of assets should be reduced and
     * `target`'s balance increased. The amount actually transferred may be slightly greater in
     * the case that the transfer would otherwise take the sender balance above zero but below
     * the minimum balance. Must be greater than zero.
     *
     * Emits `Transferred` with the actual amount transferred. If this takes the source balance
     * to below the minimum for the asset, then the amount transferred is increased to take it
     * to zero.
     *
     * Weight: `O(1)`
     * Modes: Pre-existence of `target`; Post-existence of sender; Account pre-existence of
     * `target`.
     */
    "transfer": Anonymize<I80oivsrvtnpf1>;
    /**
     * Move some assets from the sender account to another, keeping the sender account alive.
     *
     * Origin must be Signed.
     *
     * - `id`: The identifier of the asset to have some amount transferred.
     * - `target`: The account to be credited.
     * - `amount`: The amount by which the sender's balance of assets should be reduced and
     * `target`'s balance increased. The amount actually transferred may be slightly greater in
     * the case that the transfer would otherwise take the sender balance above zero but below
     * the minimum balance. Must be greater than zero.
     *
     * Emits `Transferred` with the actual amount transferred. If this takes the source balance
     * to below the minimum for the asset, then the amount transferred is increased to take it
     * to zero.
     *
     * Weight: `O(1)`
     * Modes: Pre-existence of `target`; Post-existence of sender; Account pre-existence of
     * `target`.
     */
    "transfer_keep_alive": Anonymize<I80oivsrvtnpf1>;
    /**
     * Move some assets from one account to another.
     *
     * Origin must be Signed and the sender should be the Admin of the asset `id`.
     *
     * - `id`: The identifier of the asset to have some amount transferred.
     * - `source`: The account to be debited.
     * - `dest`: The account to be credited.
     * - `amount`: The amount by which the `source`'s balance of assets should be reduced and
     * `dest`'s balance increased. The amount actually transferred may be slightly greater in
     * the case that the transfer would otherwise take the `source` balance above zero but
     * below the minimum balance. Must be greater than zero.
     *
     * Emits `Transferred` with the actual amount transferred. If this takes the source balance
     * to below the minimum for the asset, then the amount transferred is increased to take it
     * to zero.
     *
     * Weight: `O(1)`
     * Modes: Pre-existence of `dest`; Post-existence of `source`; Account pre-existence of
     * `dest`.
     */
    "force_transfer": Anonymize<I5vhombd5v3q3i>;
    /**
     * Disallow further unprivileged transfers of an asset `id` from an account `who`. `who`
     * must already exist as an entry in `Account`s of the asset. If you want to freeze an
     * account that does not have an entry, use `touch_other` first.
     *
     * Origin must be Signed and the sender should be the Freezer of the asset `id`.
     *
     * - `id`: The identifier of the asset to be frozen.
     * - `who`: The account to be frozen.
     *
     * Emits `Frozen`.
     *
     * Weight: `O(1)`
     */
    "freeze": Anonymize<Ifn5slgv2scogq>;
    /**
     * Allow unprivileged transfers to and from an account again.
     *
     * Origin must be Signed and the sender should be the Admin of the asset `id`.
     *
     * - `id`: The identifier of the asset to be frozen.
     * - `who`: The account to be unfrozen.
     *
     * Emits `Thawed`.
     *
     * Weight: `O(1)`
     */
    "thaw": Anonymize<Ifn5slgv2scogq>;
    /**
     * Disallow further unprivileged transfers for the asset class.
     *
     * Origin must be Signed and the sender should be the Freezer of the asset `id`.
     *
     * - `id`: The identifier of the asset to be frozen.
     *
     * Emits `Frozen`.
     *
     * Weight: `O(1)`
     */
    "freeze_asset": Anonymize<I4ov6e94l79mbg>;
    /**
     * Allow unprivileged transfers for the asset again.
     *
     * Origin must be Signed and the sender should be the Admin of the asset `id`.
     *
     * - `id`: The identifier of the asset to be thawed.
     *
     * Emits `Thawed`.
     *
     * Weight: `O(1)`
     */
    "thaw_asset": Anonymize<I4ov6e94l79mbg>;
    /**
     * Change the Owner of an asset.
     *
     * Origin must be Signed and the sender should be the Owner of the asset `id`.
     *
     * - `id`: The identifier of the asset.
     * - `owner`: The new Owner of this asset.
     *
     * Emits `OwnerChanged`.
     *
     * Weight: `O(1)`
     */
    "transfer_ownership": Anonymize<I2sh1vq7mki6oa>;
    /**
     * Change the Issuer, Admin and Freezer of an asset.
     *
     * Origin must be Signed and the sender should be the Owner of the asset `id`.
     *
     * - `id`: The identifier of the asset to be frozen.
     * - `issuer`: The new Issuer of this asset.
     * - `admin`: The new Admin of this asset.
     * - `freezer`: The new Freezer of this asset.
     *
     * Emits `TeamChanged`.
     *
     * Weight: `O(1)`
     */
    "set_team": Anonymize<I2vkf0rft09hc1>;
    /**
     * Set the metadata for an asset.
     *
     * Origin must be Signed and the sender should be the Owner of the asset `id`.
     *
     * Funds of sender are reserved according to the formula:
     * `MetadataDepositBase + MetadataDepositPerByte * (name.len + symbol.len)` taking into
     * account any already reserved funds.
     *
     * - `id`: The identifier of the asset to update.
     * - `name`: The user friendly name of this asset. Limited in length by `StringLimit`.
     * - `symbol`: The exchange symbol for this asset. Limited in length by `StringLimit`.
     * - `decimals`: The number of decimals this asset uses to represent one unit.
     *
     * Emits `MetadataSet`.
     *
     * Weight: `O(1)`
     */
    "set_metadata": Anonymize<I87vll2k0a91o2>;
    /**
     * Clear the metadata for an asset.
     *
     * Origin must be Signed and the sender should be the Owner of the asset `id`.
     *
     * Any deposit is freed for the asset owner.
     *
     * - `id`: The identifier of the asset to clear.
     *
     * Emits `MetadataCleared`.
     *
     * Weight: `O(1)`
     */
    "clear_metadata": Anonymize<I4ov6e94l79mbg>;
    /**
     * Force the metadata for an asset to some value.
     *
     * Origin must be ForceOrigin.
     *
     * Any deposit is left alone.
     *
     * - `id`: The identifier of the asset to update.
     * - `name`: The user friendly name of this asset. Limited in length by `StringLimit`.
     * - `symbol`: The exchange symbol for this asset. Limited in length by `StringLimit`.
     * - `decimals`: The number of decimals this asset uses to represent one unit.
     *
     * Emits `MetadataSet`.
     *
     * Weight: `O(N + S)` where N and S are the length of the name and symbol respectively.
     */
    "force_set_metadata": Anonymize<Iekaug5vo6n1jh>;
    /**
     * Clear the metadata for an asset.
     *
     * Origin must be ForceOrigin.
     *
     * Any deposit is returned.
     *
     * - `id`: The identifier of the asset to clear.
     *
     * Emits `MetadataCleared`.
     *
     * Weight: `O(1)`
     */
    "force_clear_metadata": Anonymize<I4ov6e94l79mbg>;
    /**
     * Alter the attributes of a given asset.
     *
     * Origin must be `ForceOrigin`.
     *
     * - `id`: The identifier of the asset.
     * - `owner`: The new Owner of this asset.
     * - `issuer`: The new Issuer of this asset.
     * - `admin`: The new Admin of this asset.
     * - `freezer`: The new Freezer of this asset.
     * - `min_balance`: The minimum balance of this new asset that any single account must
     * have. If an account's balance is reduced below this, then it collapses to zero.
     * - `is_sufficient`: Whether a non-zero balance of this asset is deposit of sufficient
     * value to account for the state bloat associated with its balance storage. If set to
     * `true`, then non-zero balances may be stored without a `consumer` reference (and thus
     * an ED in the Balances pallet or whatever else is used to control user-account state
     * growth).
     * - `is_frozen`: Whether this asset class is frozen except for permissioned/admin
     * instructions.
     *
     * Emits `AssetStatusChanged` with the identity of the asset.
     *
     * Weight: `O(1)`
     */
    "force_asset_status": Anonymize<Ie54ng68f2kek5>;
    /**
     * Approve an amount of asset for transfer by a delegated third-party account.
     *
     * Origin must be Signed.
     *
     * Ensures that `ApprovalDeposit` worth of `Currency` is reserved from signing account
     * for the purpose of holding the approval. If some non-zero amount of assets is already
     * approved from signing account to `delegate`, then it is topped up or unreserved to
     * meet the right value.
     *
     * NOTE: The signing account does not need to own `amount` of assets at the point of
     * making this call.
     *
     * - `id`: The identifier of the asset.
     * - `delegate`: The account to delegate permission to transfer asset.
     * - `amount`: The amount of asset that may be transferred by `delegate`. If there is
     * already an approval in place, then this acts additively.
     *
     * Emits `ApprovedTransfer` on success.
     *
     * Weight: `O(1)`
     */
    "approve_transfer": Anonymize<I2cjplfh6m2djj>;
    /**
     * Cancel all of some asset approved for delegated transfer by a third-party account.
     *
     * Origin must be Signed and there must be an approval in place between signer and
     * `delegate`.
     *
     * Unreserves any deposit previously reserved by `approve_transfer` for the approval.
     *
     * - `id`: The identifier of the asset.
     * - `delegate`: The account delegated permission to transfer asset.
     *
     * Emits `ApprovalCancelled` on success.
     *
     * Weight: `O(1)`
     */
    "cancel_approval": Anonymize<I7efm6ceeotvpk>;
    /**
     * Cancel all of some asset approved for delegated transfer by a third-party account.
     *
     * Origin must be either ForceOrigin or Signed origin with the signer being the Admin
     * account of the asset `id`.
     *
     * Unreserves any deposit previously reserved by `approve_transfer` for the approval.
     *
     * - `id`: The identifier of the asset.
     * - `delegate`: The account delegated permission to transfer asset.
     *
     * Emits `ApprovalCancelled` on success.
     *
     * Weight: `O(1)`
     */
    "force_cancel_approval": Anonymize<I2ei6jes8e1vjr>;
    /**
     * Transfer some asset balance from a previously delegated account to some third-party
     * account.
     *
     * Origin must be Signed and there must be an approval in place by the `owner` to the
     * signer.
     *
     * If the entire amount approved for transfer is transferred, then any deposit previously
     * reserved by `approve_transfer` is unreserved.
     *
     * - `id`: The identifier of the asset.
     * - `owner`: The account which previously approved for a transfer of at least `amount` and
     * from which the asset balance will be withdrawn.
     * - `destination`: The account to which the asset balance of `amount` will be transferred.
     * - `amount`: The amount of assets to transfer.
     *
     * Emits `TransferredApproved` on success.
     *
     * Weight: `O(1)`
     */
    "transfer_approved": Anonymize<Icquq3o4hcmj65>;
    /**
     * Create an asset account for non-provider assets.
     *
     * A deposit will be taken from the signer account.
     *
     * - `origin`: Must be Signed; the signer account must have sufficient funds for a deposit
     * to be taken.
     * - `id`: The identifier of the asset for the account to be created.
     *
     * Emits `Touched` event when successful.
     */
    "touch": Anonymize<I4ov6e94l79mbg>;
    /**
     * Return the deposit (if any) of an asset account or a consumer reference (if any) of an
     * account.
     *
     * The origin must be Signed.
     *
     * - `id`: The identifier of the asset for which the caller would like the deposit
     * refunded.
     * - `allow_burn`: If `true` then assets may be destroyed in order to complete the refund.
     *
     * Emits `Refunded` event when successful.
     */
    "refund": Anonymize<Ib98qbv23c0tst>;
    /**
     * Sets the minimum balance of an asset.
     *
     * Only works if there aren't any accounts that are holding the asset or if
     * the new value of `min_balance` is less than the old one.
     *
     * Origin must be Signed and the sender has to be the Owner of the
     * asset `id`.
     *
     * - `id`: The identifier of the asset.
     * - `min_balance`: The new value of `min_balance`.
     *
     * Emits `AssetMinBalanceChanged` event when successful.
     */
    "set_min_balance": Anonymize<Iebdnbvufodnev>;
    /**
     * Create an asset account for `who`.
     *
     * A deposit will be taken from the signer account.
     *
     * - `origin`: Must be Signed by `Freezer` or `Admin` of the asset `id`; the signer account
     * must have sufficient funds for a deposit to be taken.
     * - `id`: The identifier of the asset for the account to be created.
     * - `who`: The account to be created.
     *
     * Emits `Touched` event when successful.
     */
    "touch_other": Anonymize<Ifn5slgv2scogq>;
    /**
     * Return the deposit (if any) of a target asset account. Useful if you are the depositor.
     *
     * The origin must be Signed and either the account owner, depositor, or asset `Admin`. In
     * order to burn a non-zero balance of the asset, the caller must be the account and should
     * use `refund`.
     *
     * - `id`: The identifier of the asset for the account holding a deposit.
     * - `who`: The account to refund.
     *
     * Emits `Refunded` event when successful.
     */
    "refund_other": Anonymize<Ifn5slgv2scogq>;
    /**
     * Disallow further unprivileged transfers of an asset `id` to and from an account `who`.
     *
     * Origin must be Signed and the sender should be the Freezer of the asset `id`.
     *
     * - `id`: The identifier of the account's asset.
     * - `who`: The account to be unblocked.
     *
     * Emits `Blocked`.
     *
     * Weight: `O(1)`
     */
    "block": Anonymize<Ifn5slgv2scogq>;
}>;
export type Ibh0d53vr9icth = {
    "id": bigint;
    "admin": Anonymize<I4su1fqci7afjt>;
    "min_balance": bigint;
};
export type I2sr30isvv1i3a = {
    "id": bigint;
    "owner": Anonymize<I4su1fqci7afjt>;
    "is_sufficient": boolean;
    "min_balance": bigint;
};
export type I4ov6e94l79mbg = {
    "id": bigint;
};
export type I4mq3ssndm1dbu = {
    "id": bigint;
    "beneficiary": Anonymize<I4su1fqci7afjt>;
    "amount": bigint;
};
export type I45oruu1f0aihd = {
    "id": bigint;
    "who": Anonymize<I4su1fqci7afjt>;
    "amount": bigint;
};
export type I80oivsrvtnpf1 = {
    "id": bigint;
    "target": Anonymize<I4su1fqci7afjt>;
    "amount": bigint;
};
export type I5vhombd5v3q3i = {
    "id": bigint;
    "source": Anonymize<I4su1fqci7afjt>;
    "dest": Anonymize<I4su1fqci7afjt>;
    "amount": bigint;
};
export type Ifn5slgv2scogq = {
    "id": bigint;
    "who": Anonymize<I4su1fqci7afjt>;
};
export type I2sh1vq7mki6oa = {
    "id": bigint;
    "owner": Anonymize<I4su1fqci7afjt>;
};
export type I2vkf0rft09hc1 = {
    "id": bigint;
    "issuer": Anonymize<I4su1fqci7afjt>;
    "admin": Anonymize<I4su1fqci7afjt>;
    "freezer": Anonymize<I4su1fqci7afjt>;
};
export type I87vll2k0a91o2 = {
    "id": bigint;
    "name": Binary;
    "symbol": Binary;
    "decimals": number;
};
export type Iekaug5vo6n1jh = {
    "id": bigint;
    "name": Binary;
    "symbol": Binary;
    "decimals": number;
    "is_frozen": boolean;
};
export type Ie54ng68f2kek5 = {
    "id": bigint;
    "owner": Anonymize<I4su1fqci7afjt>;
    "issuer": Anonymize<I4su1fqci7afjt>;
    "admin": Anonymize<I4su1fqci7afjt>;
    "freezer": Anonymize<I4su1fqci7afjt>;
    "min_balance": bigint;
    "is_sufficient": boolean;
    "is_frozen": boolean;
};
export type I2cjplfh6m2djj = {
    "id": bigint;
    "delegate": Anonymize<I4su1fqci7afjt>;
    "amount": bigint;
};
export type I7efm6ceeotvpk = {
    "id": bigint;
    "delegate": Anonymize<I4su1fqci7afjt>;
};
export type I2ei6jes8e1vjr = {
    "id": bigint;
    "owner": Anonymize<I4su1fqci7afjt>;
    "delegate": Anonymize<I4su1fqci7afjt>;
};
export type Icquq3o4hcmj65 = {
    "id": bigint;
    "owner": Anonymize<I4su1fqci7afjt>;
    "destination": Anonymize<I4su1fqci7afjt>;
    "amount": bigint;
};
export type Ib98qbv23c0tst = {
    "id": bigint;
    "allow_burn": boolean;
};
export type Iebdnbvufodnev = {
    "id": bigint;
    "min_balance": bigint;
};
export type I9fktnrlinnre4 = AnonymousEnum<{
    /**
     * Transfer some liquid free balance to another account.
     *
     * `transfer_allow_death` will set the `FreeBalance` of the sender and receiver.
     * If the sender's account is below the existential deposit as a result
     * of the transfer, the account will be reaped.
     *
     * The dispatch origin for this call must be `Signed` by the transactor.
     */
    "transfer_allow_death": Anonymize<I65i612een2ak>;
    /**
     * Exactly as `transfer_allow_death`, except the origin must be root and the source account
     * may be specified.
     */
    "force_transfer": Anonymize<I5vvf47ira6s09>;
    /**
     * Same as the [`transfer_allow_death`] call, but with a check that the transfer will not
     * kill the origin account.
     *
     * 99% of the time you want [`transfer_allow_death`] instead.
     *
     * [`transfer_allow_death`]: struct.Pallet.html#method.transfer
     */
    "transfer_keep_alive": Anonymize<I65i612een2ak>;
    /**
     * Transfer the entire transferable balance from the caller account.
     *
     * NOTE: This function only attempts to transfer _transferable_ balances. This means that
     * any locked, reserved, or existential deposits (when `keep_alive` is `true`), will not be
     * transferred by this function. To ensure that this function results in a killed account,
     * you might need to prepare the account by removing any reference counters, storage
     * deposits, etc...
     *
     * The dispatch origin of this call must be Signed.
     *
     * - `dest`: The recipient of the transfer.
     * - `keep_alive`: A boolean to determine if the `transfer_all` operation should send all
     * of the funds the account has, causing the sender account to be killed (false), or
     * transfer everything except at least the existential deposit, which will guarantee to
     * keep the sender account alive (true).
     */
    "transfer_all": Anonymize<I5ns79ftlq8cnl>;
    /**
     * Unreserve some balance from a user by force.
     *
     * Can only be called by ROOT.
     */
    "force_unreserve": Anonymize<I59ofijoau4bjh>;
    /**
     * Upgrade a specified account.
     *
     * - `origin`: Must be `Signed`.
     * - `who`: The account to be upgraded.
     *
     * This will waive the transaction fee if at least all but 10% of the accounts needed to
     * be upgraded. (We let some not have to be upgraded just in order to allow for the
     * possibility of churn).
     */
    "upgrade_accounts": Anonymize<Ibmr18suc9ikh9>;
    /**
     * Set the regular balance of a given account.
     *
     * The dispatch origin for this call is `root`.
     */
    "force_set_balance": Anonymize<Ieka2e164ntfss>;
    /**
     * Adjust the total issuance in a saturating way.
     *
     * Can only be called by root and always needs a positive `delta`.
     *
     * # Example
     */
    "force_adjust_total_issuance": Anonymize<I5u8olqbbvfnvf>;
    /**
     * Burn the specified liquid free balance from the origin account.
     *
     * If the origin's account ends up below the existential deposit as a result
     * of the burn and `keep_alive` is false, the account will be reaped.
     *
     * Unlike sending funds to a _burn_ address, which merely makes the funds inaccessible,
     * this `burn` operation will reduce total issuance by the amount _burned_.
     */
    "burn": Anonymize<I5utcetro501ir>;
}>;
export type I65i612een2ak = {
    "dest": Anonymize<I4su1fqci7afjt>;
    "value": bigint;
};
export type I5vvf47ira6s09 = {
    "source": Anonymize<I4su1fqci7afjt>;
    "dest": Anonymize<I4su1fqci7afjt>;
    "value": bigint;
};
export type I5ns79ftlq8cnl = {
    "dest": Anonymize<I4su1fqci7afjt>;
    "keep_alive": boolean;
};
export type I59ofijoau4bjh = {
    "who": Anonymize<I4su1fqci7afjt>;
    "amount": bigint;
};
export type Ieka2e164ntfss = {
    "who": Anonymize<I4su1fqci7afjt>;
    "new_free": bigint;
};
export type I51vts28k29dlt = AnonymousEnum<{
    /**
     * Report authority equivocation/misbehavior. This method will verify
     * the equivocation proof and validate the given key ownership proof
     * against the extracted offender. If both are valid, the offence will
     * be reported.
     */
    "report_equivocation": Anonymize<I5tnpomjhli8ea>;
    /**
     * Report authority equivocation/misbehavior. This method will verify
     * the equivocation proof and validate the given key ownership proof
     * against the extracted offender. If both are valid, the offence will
     * be reported.
     * This extrinsic must be called unsigned and it is expected that only
     * block authors will call it (validated in `ValidateUnsigned`), as such
     * if the block author is defined it will be defined as the equivocation
     * reporter.
     */
    "report_equivocation_unsigned": Anonymize<I5tnpomjhli8ea>;
    /**
     * Plan an epoch config change. The epoch config change is recorded and will be enacted on
     * the next call to `enact_epoch_change`. The config will be activated one epoch after.
     * Multiple calls to this method will replace any existing planned config change that had
     * not been enacted yet.
     */
    "plan_config_change": Anonymize<I9fin09kkg0jaj>;
}>;
export type I5tnpomjhli8ea = {
    "equivocation_proof": Anonymize<I55620scbn6g1k>;
    "key_owner_proof": Anonymize<I3ia7aufsoj0l1>;
};
export type I55620scbn6g1k = {
    "offender": FixedSizeBinary<32>;
    "slot": bigint;
    "first_header": Anonymize<Idcpi3jpt0c03v>;
    "second_header": Anonymize<Idcpi3jpt0c03v>;
};
export type Idcpi3jpt0c03v = {
    "parent_hash": FixedSizeBinary<32>;
    "number": bigint;
    "state_root": FixedSizeBinary<32>;
    "extrinsics_root": FixedSizeBinary<32>;
    "digest": Anonymize<I4mddgoa69c0a2>;
};
export type I3ia7aufsoj0l1 = {
    "session": number;
    "trie_nodes": Anonymize<Itom7fk49o0c9>;
    "validator_count": number;
};
export type I9fin09kkg0jaj = {
    "config": BabeDigestsNextConfigDescriptor;
};
export type I5euviv4mm0m1h = AnonymousEnum<{
    /**
     * Report voter equivocation/misbehavior. This method will verify the
     * equivocation proof and validate the given key ownership proof
     * against the extracted offender. If both are valid, the offence
     * will be reported.
     */
    "report_equivocation": Anonymize<Iar76998r89ou1>;
    /**
     * Report voter equivocation/misbehavior. This method will verify the
     * equivocation proof and validate the given key ownership proof
     * against the extracted offender. If both are valid, the offence
     * will be reported.
     *
     * This extrinsic must be called unsigned and it is expected that only
     * block authors will call it (validated in `ValidateUnsigned`), as such
     * if the block author is defined it will be defined as the equivocation
     * reporter.
     */
    "report_equivocation_unsigned": Anonymize<Iar76998r89ou1>;
    /**
     * Note that the current authority set of the GRANDPA finality gadget has stalled.
     *
     * This will trigger a forced authority set change at the beginning of the next session, to
     * be enacted `delay` blocks after that. The `delay` should be high enough to safely assume
     * that the block signalling the forced change will not be re-orged e.g. 1000 blocks.
     * The block production rate (which may be slowed down because of finality lagging) should
     * be taken into account when choosing the `delay`. The GRANDPA voters based on the new
     * authority will start voting on top of `best_finalized_block_number` for new finalized
     * blocks. `best_finalized_block_number` should be the highest of the latest finalized
     * block of all validators of the new authority set.
     *
     * Only callable by root.
     */
    "note_stalled": Anonymize<Ichu6a94bm67kd>;
}>;
export type Iar76998r89ou1 = {
    "equivocation_proof": Anonymize<Ifh2vvcsf9090p>;
    "key_owner_proof": Anonymize<I3ia7aufsoj0l1>;
};
export type Ifh2vvcsf9090p = {
    "set_id": bigint;
    "equivocation": Enum<{
        "Prevote": {
            "round_number": bigint;
            "identity": FixedSizeBinary<32>;
            "first": [{
                "target_hash": FixedSizeBinary<32>;
                "target_number": bigint;
            }, FixedSizeBinary<64>];
            "second": [{
                "target_hash": FixedSizeBinary<32>;
                "target_number": bigint;
            }, FixedSizeBinary<64>];
        };
        "Precommit": {
            "round_number": bigint;
            "identity": FixedSizeBinary<32>;
            "first": [{
                "target_hash": FixedSizeBinary<32>;
                "target_number": bigint;
            }, FixedSizeBinary<64>];
            "second": [{
                "target_hash": FixedSizeBinary<32>;
                "target_number": bigint;
            }, FixedSizeBinary<64>];
        };
    }>;
};
export type Ichu6a94bm67kd = {
    "delay": bigint;
    "best_finalized_block_number": bigint;
};
export type Iehgup0qh1t3vb = AnonymousEnum<{
    /**
     * Assign an previously unassigned index.
     *
     * Payment: `Deposit` is reserved from the sender account.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * - `index`: the index to be claimed. This must not be in use.
     *
     * Emits `IndexAssigned` if successful.
     *
     * ## Complexity
     * - `O(1)`.
     */
    "claim": Anonymize<I666bl2fqjkejo>;
    /**
     * Assign an index already owned by the sender to another account. The balance reservation
     * is effectively transferred to the new account.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * - `index`: the index to be re-assigned. This must be owned by the sender.
     * - `new`: the new owner of the index. This function is a no-op if it is equal to sender.
     *
     * Emits `IndexAssigned` if successful.
     *
     * ## Complexity
     * - `O(1)`.
     */
    "transfer": Anonymize<I1u3ac7lafvv5b>;
    /**
     * Free up an index owned by the sender.
     *
     * Payment: Any previous deposit placed for the index is unreserved in the sender account.
     *
     * The dispatch origin for this call must be _Signed_ and the sender must own the index.
     *
     * - `index`: the index to be freed. This must be owned by the sender.
     *
     * Emits `IndexFreed` if successful.
     *
     * ## Complexity
     * - `O(1)`.
     */
    "free": Anonymize<I666bl2fqjkejo>;
    /**
     * Force an index to an account. This doesn't require a deposit. If the index is already
     * held, then any deposit is reimbursed to its current owner.
     *
     * The dispatch origin for this call must be _Root_.
     *
     * - `index`: the index to be (re-)assigned.
     * - `new`: the new owner of the index. This function is a no-op if it is equal to sender.
     * - `freeze`: if set to `true`, will freeze the index so it cannot be transferred.
     *
     * Emits `IndexAssigned` if successful.
     *
     * ## Complexity
     * - `O(1)`.
     */
    "force_transfer": Anonymize<I5teebeg0opib2>;
    /**
     * Freeze an index so it will always point to the sender account. This consumes the
     * deposit.
     *
     * The dispatch origin for this call must be _Signed_ and the signing account must have a
     * non-frozen account `index`.
     *
     * - `index`: the index to be frozen in place.
     *
     * Emits `IndexFrozen` if successful.
     *
     * ## Complexity
     * - `O(1)`.
     */
    "freeze": Anonymize<I666bl2fqjkejo>;
}>;
export type I1u3ac7lafvv5b = {
    "new": Anonymize<I4su1fqci7afjt>;
    "index": number;
};
export type I5teebeg0opib2 = {
    "new": Anonymize<I4su1fqci7afjt>;
    "index": number;
    "freeze": boolean;
};
export type I6a6pet7i0s1k9 = AnonymousEnum<{
    /**
     * Propose a sensitive action to be taken.
     *
     * The dispatch origin of this call must be _Signed_ and the sender must
     * have funds to cover the deposit.
     *
     * - `proposal_hash`: The hash of the proposal preimage.
     * - `value`: The amount of deposit (must be at least `MinimumDeposit`).
     *
     * Emits `Proposed`.
     */
    "propose": Anonymize<I1moso5oagpiea>;
    /**
     * Signals agreement with a particular proposal.
     *
     * The dispatch origin of this call must be _Signed_ and the sender
     * must have funds to cover the deposit, equal to the original deposit.
     *
     * - `proposal`: The index of the proposal to second.
     */
    "second": Anonymize<Ibeb4n9vpjefp3>;
    /**
     * Vote in a referendum. If `vote.is_aye()`, the vote is to enact the proposal;
     * otherwise it is a vote to keep the status quo.
     *
     * The dispatch origin of this call must be _Signed_.
     *
     * - `ref_index`: The index of the referendum to vote for.
     * - `vote`: The vote configuration.
     */
    "vote": Anonymize<Id7murq9s9fg6h>;
    /**
     * Schedule an emergency cancellation of a referendum. Cannot happen twice to the same
     * referendum.
     *
     * The dispatch origin of this call must be `CancellationOrigin`.
     *
     * -`ref_index`: The index of the referendum to cancel.
     *
     * Weight: `O(1)`.
     */
    "emergency_cancel": Anonymize<Ied9mja4bq7va8>;
    /**
     * Schedule a referendum to be tabled once it is legal to schedule an external
     * referendum.
     *
     * The dispatch origin of this call must be `ExternalOrigin`.
     *
     * - `proposal_hash`: The preimage hash of the proposal.
     */
    "external_propose": Anonymize<I4f7jul8ljs54r>;
    /**
     * Schedule a majority-carries referendum to be tabled next once it is legal to schedule
     * an external referendum.
     *
     * The dispatch of this call must be `ExternalMajorityOrigin`.
     *
     * - `proposal_hash`: The preimage hash of the proposal.
     *
     * Unlike `external_propose`, blacklisting has no effect on this and it may replace a
     * pre-scheduled `external_propose` call.
     *
     * Weight: `O(1)`
     */
    "external_propose_majority": Anonymize<I4f7jul8ljs54r>;
    /**
     * Schedule a negative-turnout-bias referendum to be tabled next once it is legal to
     * schedule an external referendum.
     *
     * The dispatch of this call must be `ExternalDefaultOrigin`.
     *
     * - `proposal_hash`: The preimage hash of the proposal.
     *
     * Unlike `external_propose`, blacklisting has no effect on this and it may replace a
     * pre-scheduled `external_propose` call.
     *
     * Weight: `O(1)`
     */
    "external_propose_default": Anonymize<I4f7jul8ljs54r>;
    /**
     * Schedule the currently externally-proposed majority-carries referendum to be tabled
     * immediately. If there is no externally-proposed referendum currently, or if there is one
     * but it is not a majority-carries referendum then it fails.
     *
     * The dispatch of this call must be `FastTrackOrigin`.
     *
     * - `proposal_hash`: The hash of the current external proposal.
     * - `voting_period`: The period that is allowed for voting on this proposal. Increased to
     * Must be always greater than zero.
     * For `FastTrackOrigin` must be equal or greater than `FastTrackVotingPeriod`.
     * - `delay`: The number of block after voting has ended in approval and this should be
     * enacted. This doesn't have a minimum amount.
     *
     * Emits `Started`.
     *
     * Weight: `O(1)`
     */
    "fast_track": Anonymize<I1gk9fmne451rl>;
    /**
     * Veto and blacklist the external proposal hash.
     *
     * The dispatch origin of this call must be `VetoOrigin`.
     *
     * - `proposal_hash`: The preimage hash of the proposal to veto and blacklist.
     *
     * Emits `Vetoed`.
     *
     * Weight: `O(V + log(V))` where V is number of `existing vetoers`
     */
    "veto_external": Anonymize<I2ev73t79f46tb>;
    /**
     * Remove a referendum.
     *
     * The dispatch origin of this call must be _Root_.
     *
     * - `ref_index`: The index of the referendum to cancel.
     *
     * # Weight: `O(1)`.
     */
    "cancel_referendum": Anonymize<Ied9mja4bq7va8>;
    /**
     * Delegate the voting power (with some given conviction) of the sending account.
     *
     * The balance delegated is locked for as long as it's delegated, and thereafter for the
     * time appropriate for the conviction's lock period.
     *
     * The dispatch origin of this call must be _Signed_, and the signing account must either:
     * - be delegating already; or
     * - have no voting activity (if there is, then it will need to be removed/consolidated
     * through `reap_vote` or `unvote`).
     *
     * - `to`: The account whose voting the `target` account's voting power will follow.
     * - `conviction`: The conviction that will be attached to the delegated votes. When the
     * account is undelegated, the funds will be locked for the corresponding period.
     * - `balance`: The amount of the account's balance to be used in delegating. This must not
     * be more than the account's current balance.
     *
     * Emits `Delegated`.
     *
     * Weight: `O(R)` where R is the number of referendums the voter delegating to has
     * voted on. Weight is charged as if maximum votes.
     */
    "delegate": Anonymize<I1736r1jp6plpc>;
    /**
     * Undelegate the voting power of the sending account.
     *
     * Tokens may be unlocked following once an amount of time consistent with the lock period
     * of the conviction with which the delegation was issued.
     *
     * The dispatch origin of this call must be _Signed_ and the signing account must be
     * currently delegating.
     *
     * Emits `Undelegated`.
     *
     * Weight: `O(R)` where R is the number of referendums the voter delegating to has
     * voted on. Weight is charged as if maximum votes.
     */
    "undelegate": undefined;
    /**
     * Clears all public proposals.
     *
     * The dispatch origin of this call must be _Root_.
     *
     * Weight: `O(1)`.
     */
    "clear_public_proposals": undefined;
    /**
     * Unlock tokens that have an expired lock.
     *
     * The dispatch origin of this call must be _Signed_.
     *
     * - `target`: The account to remove the lock on.
     *
     * Weight: `O(R)` with R number of vote of target.
     */
    "unlock": Anonymize<If31vrl50nund3>;
    /**
     * Remove a vote for a referendum.
     *
     * If:
     * - the referendum was cancelled, or
     * - the referendum is ongoing, or
     * - the referendum has ended such that
     * - the vote of the account was in opposition to the result; or
     * - there was no conviction to the account's vote; or
     * - the account made a split vote
     * ...then the vote is removed cleanly and a following call to `unlock` may result in more
     * funds being available.
     *
     * If, however, the referendum has ended and:
     * - it finished corresponding to the vote of the account, and
     * - the account made a standard vote with conviction, and
     * - the lock period of the conviction is not over
     * ...then the lock will be aggregated into the overall account's lock, which may involve
     * *overlocking* (where the two locks are combined into a single lock that is the maximum
     * of both the amount locked and the time is it locked for).
     *
     * The dispatch origin of this call must be _Signed_, and the signer must have a vote
     * registered for referendum `index`.
     *
     * - `index`: The index of referendum of the vote to be removed.
     *
     * Weight: `O(R + log R)` where R is the number of referenda that `target` has voted on.
     * Weight is calculated for the maximum number of vote.
     */
    "remove_vote": Anonymize<I666bl2fqjkejo>;
    /**
     * Remove a vote for a referendum.
     *
     * If the `target` is equal to the signer, then this function is exactly equivalent to
     * `remove_vote`. If not equal to the signer, then the vote must have expired,
     * either because the referendum was cancelled, because the voter lost the referendum or
     * because the conviction period is over.
     *
     * The dispatch origin of this call must be _Signed_.
     *
     * - `target`: The account of the vote to be removed; this account must have voted for
     * referendum `index`.
     * - `index`: The index of referendum of the vote to be removed.
     *
     * Weight: `O(R + log R)` where R is the number of referenda that `target` has voted on.
     * Weight is calculated for the maximum number of vote.
     */
    "remove_other_vote": Anonymize<I6s1n1athh0bbq>;
    /**
     * Permanently place a proposal into the blacklist. This prevents it from ever being
     * proposed again.
     *
     * If called on a queued public or external proposal, then this will result in it being
     * removed. If the `ref_index` supplied is an active referendum with the proposal hash,
     * then it will be cancelled.
     *
     * The dispatch origin of this call must be `BlacklistOrigin`.
     *
     * - `proposal_hash`: The proposal hash to blacklist permanently.
     * - `ref_index`: An ongoing referendum whose hash is `proposal_hash`, which will be
     * cancelled.
     *
     * Weight: `O(p)` (though as this is an high-privilege dispatch, we assume it has a
     * reasonable value).
     */
    "blacklist": Anonymize<I3v9h9f3mpm1l8>;
    /**
     * Remove a proposal.
     *
     * The dispatch origin of this call must be `CancelProposalOrigin`.
     *
     * - `prop_index`: The index of the proposal to cancel.
     *
     * Weight: `O(p)` where `p = PublicProps::<T>::decode_len()`
     */
    "cancel_proposal": Anonymize<I9mnj4k4u8ls2c>;
    /**
     * Set or clear a metadata of a proposal or a referendum.
     *
     * Parameters:
     * - `origin`: Must correspond to the `MetadataOwner`.
     * - `ExternalOrigin` for an external proposal with the `SuperMajorityApprove`
     * threshold.
     * - `ExternalDefaultOrigin` for an external proposal with the `SuperMajorityAgainst`
     * threshold.
     * - `ExternalMajorityOrigin` for an external proposal with the `SimpleMajority`
     * threshold.
     * - `Signed` by a creator for a public proposal.
     * - `Signed` to clear a metadata for a finished referendum.
     * - `Root` to set a metadata for an ongoing referendum.
     * - `owner`: an identifier of a metadata owner.
     * - `maybe_hash`: The hash of an on-chain stored preimage. `None` to clear a metadata.
     */
    "set_metadata": Anonymize<I2kt2u1flctk2q>;
}>;
export type I1moso5oagpiea = {
    "proposal": PreimagesBounded;
    "value": bigint;
};
export type Ibeb4n9vpjefp3 = {
    "proposal": number;
};
export type Id7murq9s9fg6h = {
    "ref_index": number;
    "vote": Anonymize<Ia9hdots6g53fs>;
};
export type I4f7jul8ljs54r = {
    "proposal": PreimagesBounded;
};
export type I1gk9fmne451rl = {
    "proposal_hash": FixedSizeBinary<32>;
    "voting_period": bigint;
    "delay": bigint;
};
export type I1736r1jp6plpc = {
    "to": Anonymize<I4su1fqci7afjt>;
    "conviction": VotingConviction;
    "balance": bigint;
};
export type If31vrl50nund3 = {
    "target": Anonymize<I4su1fqci7afjt>;
};
export type I6s1n1athh0bbq = {
    "target": Anonymize<I4su1fqci7afjt>;
    "index": number;
};
export type I3v9h9f3mpm1l8 = {
    "proposal_hash": FixedSizeBinary<32>;
    "maybe_ref_index"?: Anonymize<I4arjljr6dpflb>;
};
export type I2kt2u1flctk2q = {
    "owner": Anonymize<I2itl2k1j2q8nf>;
    "maybe_hash"?: Anonymize<I4s6vifaf8k998>;
};
export type I31kl3f1t2gm2d = AnonymousEnum<{
    /**
     * Set the collective's membership.
     *
     * - `new_members`: The new member list. Be nice to the chain and provide it sorted.
     * - `prime`: The prime member whose vote sets the default.
     * - `old_count`: The upper bound for the previous number of members in storage. Used for
     * weight estimation.
     *
     * The dispatch of this call must be `SetMembersOrigin`.
     *
     * NOTE: Does not enforce the expected `MaxMembers` limit on the amount of members, but
     * the weight estimations rely on it to estimate dispatchable weight.
     *
     * # WARNING:
     *
     * The `pallet-collective` can also be managed by logic outside of the pallet through the
     * implementation of the trait [`ChangeMembers`].
     * Any call to `set_members` must be careful that the member set doesn't get out of sync
     * with other logic managing the member set.
     *
     * ## Complexity:
     * - `O(MP + N)` where:
     * - `M` old-members-count (code- and governance-bounded)
     * - `N` new-members-count (code- and governance-bounded)
     * - `P` proposals-count (code-bounded)
     */
    "set_members": Anonymize<I38jfk5li8iang>;
    /**
     * Dispatch a proposal from a member using the `Member` origin.
     *
     * Origin must be a member of the collective.
     *
     * ## Complexity:
     * - `O(B + M + P)` where:
     * - `B` is `proposal` size in bytes (length-fee-bounded)
     * - `M` members-count (code-bounded)
     * - `P` complexity of dispatching `proposal`
     */
    "execute": Anonymize<If9uk9cppuuifi>;
    /**
     * Add a new proposal to either be voted on or executed directly.
     *
     * Requires the sender to be member.
     *
     * `threshold` determines whether `proposal` is executed directly (`threshold < 2`)
     * or put up for voting.
     *
     * ## Complexity
     * - `O(B + M + P1)` or `O(B + M + P2)` where:
     * - `B` is `proposal` size in bytes (length-fee-bounded)
     * - `M` is members-count (code- and governance-bounded)
     * - branching is influenced by `threshold` where:
     * - `P1` is proposal execution complexity (`threshold < 2`)
     * - `P2` is proposals-count (code-bounded) (`threshold >= 2`)
     */
    "propose": Anonymize<I9q0ensvnonfmg>;
    /**
     * Add an aye or nay vote for the sender to the given proposal.
     *
     * Requires the sender to be a member.
     *
     * Transaction fees will be waived if the member is voting on any particular proposal
     * for the first time and the call is successful. Subsequent vote changes will charge a
     * fee.
     * ## Complexity
     * - `O(M)` where `M` is members-count (code- and governance-bounded)
     */
    "vote": Anonymize<I2dtrijkm5601t>;
    /**
     * Disapprove a proposal, close, and remove it from the system, regardless of its current
     * state.
     *
     * Must be called by the Root origin.
     *
     * Parameters:
     * * `proposal_hash`: The hash of the proposal that should be disapproved.
     *
     * ## Complexity
     * O(P) where P is the number of max proposals
     */
    "disapprove_proposal": Anonymize<I2ev73t79f46tb>;
    /**
     * Close a vote that is either approved, disapproved or whose voting period has ended.
     *
     * May be called by any signed account in order to finish voting and close the proposal.
     *
     * If called before the end of the voting period it will only close the vote if it is
     * has enough votes to be approved or disapproved.
     *
     * If called after the end of the voting period abstentions are counted as rejections
     * unless there is a prime member set and the prime member cast an approval.
     *
     * If the close operation completes successfully with disapproval, the transaction fee will
     * be waived. Otherwise execution of the approved operation will be charged to the caller.
     *
     * + `proposal_weight_bound`: The maximum amount of weight consumed by executing the closed
     * proposal.
     * + `length_bound`: The upper bound for the length of the proposal in storage. Checked via
     * `storage::read` so it is `size_of::<u32>() == 4` larger than the pure length.
     *
     * ## Complexity
     * - `O(B + M + P1 + P2)` where:
     * - `B` is `proposal` size in bytes (length-fee-bounded)
     * - `M` is members-count (code- and governance-bounded)
     * - `P1` is the complexity of `proposal` preimage.
     * - `P2` is proposal-count (code-bounded)
     */
    "close": Anonymize<Ib2obgji960euh>;
}>;
export type I38jfk5li8iang = {
    "new_members": Anonymize<Ia2lhg7l2hilo3>;
    "prime"?: Anonymize<Ihfphjolmsqq1>;
    "old_count": number;
};
export type If9uk9cppuuifi = {
    "proposal": TxCallData;
    "length_bound": number;
};
export type I9q0ensvnonfmg = {
    "threshold": number;
    "proposal": TxCallData;
    "length_bound": number;
};
export type I2dtrijkm5601t = {
    "proposal": FixedSizeBinary<32>;
    "index": number;
    "approve": boolean;
};
export type Ib2obgji960euh = {
    "proposal_hash": FixedSizeBinary<32>;
    "index": number;
    "proposal_weight_bound": Anonymize<I4q39t5hn830vp>;
    "length_bound": number;
};
export type Ipooq4a014iq3 = AnonymousEnum<{
    /**
     * Unlock any vested funds of the sender account.
     *
     * The dispatch origin for this call must be _Signed_ and the sender must have funds still
     * locked under this pallet.
     *
     * Emits either `VestingCompleted` or `VestingUpdated`.
     *
     * ## Complexity
     * - `O(1)`.
     */
    "vest": undefined;
    /**
     * Unlock any vested funds of a `target` account.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * - `target`: The account whose vested funds should be unlocked. Must have funds still
     * locked under this pallet.
     *
     * Emits either `VestingCompleted` or `VestingUpdated`.
     *
     * ## Complexity
     * - `O(1)`.
     */
    "vest_other": Anonymize<If31vrl50nund3>;
    /**
     * Create a vested transfer.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * - `target`: The account receiving the vested funds.
     * - `schedule`: The vesting schedule attached to the transfer.
     *
     * Emits `VestingCreated`.
     *
     * NOTE: This will unlock all schedules through the current block.
     *
     * ## Complexity
     * - `O(1)`.
     */
    "vested_transfer": Anonymize<Icviohnuu9eu8b>;
    /**
     * Force a vested transfer.
     *
     * The dispatch origin for this call must be _Root_.
     *
     * - `source`: The account whose funds should be transferred.
     * - `target`: The account that should be transferred the vested funds.
     * - `schedule`: The vesting schedule attached to the transfer.
     *
     * Emits `VestingCreated`.
     *
     * NOTE: This will unlock all schedules through the current block.
     *
     * ## Complexity
     * - `O(1)`.
     */
    "force_vested_transfer": Anonymize<I780ptnqsedf69>;
    /**
     * Merge two vesting schedules together, creating a new vesting schedule that unlocks over
     * the highest possible start and end blocks. If both schedules have already started the
     * current block will be used as the schedule start; with the caveat that if one schedule
     * is finished by the current block, the other will be treated as the new merged schedule,
     * unmodified.
     *
     * NOTE: If `schedule1_index == schedule2_index` this is a no-op.
     * NOTE: This will unlock all schedules through the current block prior to merging.
     * NOTE: If both schedules have ended by the current block, no new schedule will be created
     * and both will be removed.
     *
     * Merged schedule attributes:
     * - `starting_block`: `MAX(schedule1.starting_block, scheduled2.starting_block,
     * current_block)`.
     * - `ending_block`: `MAX(schedule1.ending_block, schedule2.ending_block)`.
     * - `locked`: `schedule1.locked_at(current_block) + schedule2.locked_at(current_block)`.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * - `schedule1_index`: index of the first schedule to merge.
     * - `schedule2_index`: index of the second schedule to merge.
     */
    "merge_schedules": Anonymize<Ict9ivhr2c5hv0>;
    /**
     * Force remove a vesting schedule
     *
     * The dispatch origin for this call must be _Root_.
     *
     * - `target`: An account that has a vesting schedule
     * - `schedule_index`: The vesting schedule index that should be removed
     */
    "force_remove_vesting_schedule": Anonymize<Ia5huiefjr1uhk>;
}>;
export type Icviohnuu9eu8b = {
    "target": Anonymize<I4su1fqci7afjt>;
    "schedule": Anonymize<I4sun88f8jcj4r>;
};
export type I4sun88f8jcj4r = {
    "locked": bigint;
    "per_block": bigint;
    "starting_block": bigint;
};
export type I780ptnqsedf69 = {
    "source": Anonymize<I4su1fqci7afjt>;
    "target": Anonymize<I4su1fqci7afjt>;
    "schedule": Anonymize<I4sun88f8jcj4r>;
};
export type Ict9ivhr2c5hv0 = {
    "schedule1_index": number;
    "schedule2_index": number;
};
export type Ia5huiefjr1uhk = {
    "target": Anonymize<I4su1fqci7afjt>;
    "schedule_index": number;
};
export type I6ab0pou3i8npt = AnonymousEnum<{
    /**
     * Vote for a set of candidates for the upcoming round of election. This can be called to
     * set the initial votes, or update already existing votes.
     *
     * Upon initial voting, `value` units of `who`'s balance is locked and a deposit amount is
     * reserved. The deposit is based on the number of votes and can be updated over time.
     *
     * The `votes` should:
     * - not be empty.
     * - be less than the number of possible candidates. Note that all current members and
     * runners-up are also automatically candidates for the next round.
     *
     * If `value` is more than `who`'s free balance, then the maximum of the two is used.
     *
     * The dispatch origin of this call must be signed.
     *
     * ### Warning
     *
     * It is the responsibility of the caller to **NOT** place all of their balance into the
     * lock and keep some for further operations.
     */
    "vote": Anonymize<Iaa13icjlsj13d>;
    /**
     * Remove `origin` as a voter.
     *
     * This removes the lock and returns the deposit.
     *
     * The dispatch origin of this call must be signed and be a voter.
     */
    "remove_voter": undefined;
    /**
     * Submit oneself for candidacy. A fixed amount of deposit is recorded.
     *
     * All candidates are wiped at the end of the term. They either become a member/runner-up,
     * or leave the system while their deposit is slashed.
     *
     * The dispatch origin of this call must be signed.
     *
     * ### Warning
     *
     * Even if a candidate ends up being a member, they must call [`Call::renounce_candidacy`]
     * to get their deposit back. Losing the spot in an election will always lead to a slash.
     *
     * The number of current candidates must be provided as witness data.
     * ## Complexity
     * O(C + log(C)) where C is candidate_count.
     */
    "submit_candidacy": Anonymize<I98vh5ccjtf1ev>;
    /**
     * Renounce one's intention to be a candidate for the next election round. 3 potential
     * outcomes exist:
     *
     * - `origin` is a candidate and not elected in any set. In this case, the deposit is
     * unreserved, returned and origin is removed as a candidate.
     * - `origin` is a current runner-up. In this case, the deposit is unreserved, returned and
     * origin is removed as a runner-up.
     * - `origin` is a current member. In this case, the deposit is unreserved and origin is
     * removed as a member, consequently not being a candidate for the next round anymore.
     * Similar to [`remove_member`](Self::remove_member), if replacement runners exists, they
     * are immediately used. If the prime is renouncing, then no prime will exist until the
     * next round.
     *
     * The dispatch origin of this call must be signed, and have one of the above roles.
     * The type of renouncing must be provided as witness data.
     *
     * ## Complexity
     * - Renouncing::Candidate(count): O(count + log(count))
     * - Renouncing::Member: O(1)
     * - Renouncing::RunnerUp: O(1)
     */
    "renounce_candidacy": Anonymize<I3al0eab2u0gt2>;
    /**
     * Remove a particular member from the set. This is effective immediately and the bond of
     * the outgoing member is slashed.
     *
     * If a runner-up is available, then the best runner-up will be removed and replaces the
     * outgoing member. Otherwise, if `rerun_election` is `true`, a new phragmen election is
     * started, else, nothing happens.
     *
     * If `slash_bond` is set to true, the bond of the member being removed is slashed. Else,
     * it is returned.
     *
     * The dispatch origin of this call must be root.
     *
     * Note that this does not affect the designated block number of the next election.
     *
     * ## Complexity
     * - Check details of remove_and_replace_member() and do_phragmen().
     */
    "remove_member": Anonymize<Ib3prtfc334m1t>;
    /**
     * Clean all voters who are defunct (i.e. they do not serve any purpose at all). The
     * deposit of the removed voters are returned.
     *
     * This is an root function to be used only for cleaning the state.
     *
     * The dispatch origin of this call must be root.
     *
     * ## Complexity
     * - Check is_defunct_voter() details.
     */
    "clean_defunct_voters": Anonymize<I6fuug4i4r04hi>;
}>;
export type Iaa13icjlsj13d = {
    "votes": Anonymize<Ia2lhg7l2hilo3>;
    "value": bigint;
};
export type I98vh5ccjtf1ev = {
    "candidate_count": number;
};
export type I3al0eab2u0gt2 = {
    "renouncing": Enum<{
        "Member": undefined;
        "RunnerUp": undefined;
        "Candidate": number;
    }>;
};
export type Ib3prtfc334m1t = {
    "who": Anonymize<I4su1fqci7afjt>;
    "slash_bond": boolean;
    "rerun_election": boolean;
};
export type I6fuug4i4r04hi = {
    "num_voters": number;
    "num_defunct": number;
};
export type I15soeogelbbbh = AnonymousEnum<{
    /**
     * Submit a solution for the unsigned phase.
     *
     * The dispatch origin fo this call must be __none__.
     *
     * This submission is checked on the fly. Moreover, this unsigned solution is only
     * validated when submitted to the pool from the **local** node. Effectively, this means
     * that only active validators can submit this transaction when authoring a block (similar
     * to an inherent).
     *
     * To prevent any incorrect solution (and thus wasted time/weight), this transaction will
     * panic if the solution submitted by the validator is invalid in any way, effectively
     * putting their authoring reward at risk.
     *
     * No deposit or reward is associated with this submission.
     */
    "submit_unsigned": Anonymize<I31k9f0jol8ko4>;
    /**
     * Set a new value for `MinimumUntrustedScore`.
     *
     * Dispatch origin must be aligned with `T::ForceOrigin`.
     *
     * This check can be turned off by setting the value to `None`.
     */
    "set_minimum_untrusted_score": Anonymize<I80q14um2s2ckg>;
    /**
     * Set a solution in the queue, to be handed out to the client of this pallet in the next
     * call to `ElectionProvider::elect`.
     *
     * This can only be set by `T::ForceOrigin`, and only when the phase is `Emergency`.
     *
     * The solution is not checked for any feasibility and is assumed to be trustworthy, as any
     * feasibility check itself can in principle cause the election process to fail (due to
     * memory/weight constrains).
     */
    "set_emergency_election_result": Anonymize<I5qs1t1erfi7u8>;
    /**
     * Submit a solution for the signed phase.
     *
     * The dispatch origin fo this call must be __signed__.
     *
     * The solution is potentially queued, based on the claimed score and processed at the end
     * of the signed phase.
     *
     * A deposit is reserved and recorded for the solution. Based on the outcome, the solution
     * might be rewarded, slashed, or get all or a part of the deposit back.
     */
    "submit": Anonymize<I9et13knvdvgpb>;
    /**
     * Trigger the governance fallback.
     *
     * This can only be called when [`Phase::Emergency`] is enabled, as an alternative to
     * calling [`Call::set_emergency_election_result`].
     */
    "governance_fallback": Anonymize<Ifsme8miqq9006>;
}>;
export type I31k9f0jol8ko4 = {
    "raw_solution": Anonymize<I7je4n92ump862>;
    "witness": Anonymize<Iasd2iat48n080>;
};
export type I7je4n92ump862 = {
    "solution": {
        "votes1": Array<Anonymize<I5g2vv0ckl2m8b>>;
        "votes2": Array<[number, Anonymize<I5g2vv0ckl2m8b>, number]>;
        "votes3": Array<[number, FixedSizeArray<2, Anonymize<I5g2vv0ckl2m8b>>, number]>;
        "votes4": Array<[number, FixedSizeArray<3, Anonymize<I5g2vv0ckl2m8b>>, number]>;
        "votes5": Array<[number, FixedSizeArray<4, Anonymize<I5g2vv0ckl2m8b>>, number]>;
        "votes6": Array<[number, FixedSizeArray<5, Anonymize<I5g2vv0ckl2m8b>>, number]>;
        "votes7": Array<[number, FixedSizeArray<6, Anonymize<I5g2vv0ckl2m8b>>, number]>;
        "votes8": Array<[number, FixedSizeArray<7, Anonymize<I5g2vv0ckl2m8b>>, number]>;
        "votes9": Array<[number, FixedSizeArray<8, Anonymize<I5g2vv0ckl2m8b>>, number]>;
        "votes10": Array<[number, FixedSizeArray<9, Anonymize<I5g2vv0ckl2m8b>>, number]>;
        "votes11": Array<[number, FixedSizeArray<10, Anonymize<I5g2vv0ckl2m8b>>, number]>;
        "votes12": Array<[number, FixedSizeArray<11, Anonymize<I5g2vv0ckl2m8b>>, number]>;
        "votes13": Array<[number, FixedSizeArray<12, Anonymize<I5g2vv0ckl2m8b>>, number]>;
        "votes14": Array<[number, FixedSizeArray<13, Anonymize<I5g2vv0ckl2m8b>>, number]>;
        "votes15": Array<[number, FixedSizeArray<14, Anonymize<I5g2vv0ckl2m8b>>, number]>;
        "votes16": Array<[number, FixedSizeArray<15, Anonymize<I5g2vv0ckl2m8b>>, number]>;
    };
    "score": Anonymize<I8s6n43okuj2b1>;
    "round": number;
};
export type Iasd2iat48n080 = {
    "voters": number;
    "targets": number;
};
export type I80q14um2s2ckg = {
    "maybe_next_score"?: (Anonymize<I8s6n43okuj2b1>) | undefined;
};
export type I5qs1t1erfi7u8 = {
    "supports": Anonymize<I4bboqsv44evel>;
};
export type I4bboqsv44evel = Array<[SS58String, {
    "total": bigint;
    "voters": Anonymize<Iba9inugg1atvo>;
}]>;
export type I9et13knvdvgpb = {
    "raw_solution": Anonymize<I7je4n92ump862>;
};
export type Ifsme8miqq9006 = {
    "maybe_max_voters"?: Anonymize<I4arjljr6dpflb>;
    "maybe_max_targets"?: Anonymize<I4arjljr6dpflb>;
};
export type I9p7hu9tlck2uk = AnonymousEnum<{
    /**
     * Take the origin account as a stash and lock up `value` of its balance. `controller` will
     * be the account that controls it.
     *
     * `value` must be more than the `minimum_balance` specified by `T::Currency`.
     *
     * The dispatch origin for this call must be _Signed_ by the stash account.
     *
     * Emits `Bonded`.
     * ## Complexity
     * - Independent of the arguments. Moderate complexity.
     * - O(1).
     * - Three extra DB entries.
     *
     * NOTE: Two of the storage writes (`Self::bonded`, `Self::payee`) are _never_ cleaned
     * unless the `origin` falls below _existential deposit_ (or equal to 0) and gets removed
     * as dust.
     */
    "bond": Anonymize<I2eip8tc75dpje>;
    /**
     * Add some extra amount that have appeared in the stash `free_balance` into the balance up
     * for staking.
     *
     * The dispatch origin for this call must be _Signed_ by the stash, not the controller.
     *
     * Use this if there are additional funds in your stash account that you wish to bond.
     * Unlike [`bond`](Self::bond) or [`unbond`](Self::unbond) this function does not impose
     * any limitation on the amount that can be added.
     *
     * Emits `Bonded`.
     *
     * ## Complexity
     * - Independent of the arguments. Insignificant complexity.
     * - O(1).
     */
    "bond_extra": Anonymize<I564va64vtidbq>;
    /**
     * Schedule a portion of the stash to be unlocked ready for transfer out after the bond
     * period ends. If this leaves an amount actively bonded less than
     * T::Currency::minimum_balance(), then it is increased to the full amount.
     *
     * The dispatch origin for this call must be _Signed_ by the controller, not the stash.
     *
     * Once the unlock period is done, you can call `withdraw_unbonded` to actually move
     * the funds out of management ready for transfer.
     *
     * No more than a limited number of unlocking chunks (see `MaxUnlockingChunks`)
     * can co-exists at the same time. If there are no unlocking chunks slots available
     * [`Call::withdraw_unbonded`] is called to remove some of the chunks (if possible).
     *
     * If a user encounters the `InsufficientBond` error when calling this extrinsic,
     * they should call `chill` first in order to free up their bonded funds.
     *
     * Emits `Unbonded`.
     *
     * See also [`Call::withdraw_unbonded`].
     */
    "unbond": Anonymize<Ie5v6njpckr05b>;
    /**
     * Remove any unlocked chunks from the `unlocking` queue from our management.
     *
     * This essentially frees up that balance to be used by the stash account to do whatever
     * it wants.
     *
     * The dispatch origin for this call must be _Signed_ by the controller.
     *
     * Emits `Withdrawn`.
     *
     * See also [`Call::unbond`].
     *
     * ## Parameters
     *
     * - `num_slashing_spans` indicates the number of metadata slashing spans to clear when
     * this call results in a complete removal of all the data related to the stash account.
     * In this case, the `num_slashing_spans` must be larger or equal to the number of
     * slashing spans associated with the stash account in the [`SlashingSpans`] storage type,
     * otherwise the call will fail. The call weight is directly proportional to
     * `num_slashing_spans`.
     *
     * ## Complexity
     * O(S) where S is the number of slashing spans to remove
     * NOTE: Weight annotation is the kill scenario, we refund otherwise.
     */
    "withdraw_unbonded": Anonymize<I328av3j0bgmjb>;
    /**
     * Declare the desire to validate for the origin controller.
     *
     * Effects will be felt at the beginning of the next era.
     *
     * The dispatch origin for this call must be _Signed_ by the controller, not the stash.
     */
    "validate": Anonymize<I4tuqm9ato907i>;
    /**
     * Declare the desire to nominate `targets` for the origin controller.
     *
     * Effects will be felt at the beginning of the next era.
     *
     * The dispatch origin for this call must be _Signed_ by the controller, not the stash.
     *
     * ## Complexity
     * - The transaction's complexity is proportional to the size of `targets` (N)
     * which is capped at CompactAssignments::LIMIT (T::MaxNominations).
     * - Both the reads and writes follow a similar pattern.
     */
    "nominate": Anonymize<I19iomcbdrerea>;
    /**
     * Declare no desire to either validate or nominate.
     *
     * Effects will be felt at the beginning of the next era.
     *
     * The dispatch origin for this call must be _Signed_ by the controller, not the stash.
     *
     * ## Complexity
     * - Independent of the arguments. Insignificant complexity.
     * - Contains one read.
     * - Writes are limited to the `origin` account key.
     */
    "chill": undefined;
    /**
     * (Re-)set the payment target for a controller.
     *
     * Effects will be felt instantly (as soon as this function is completed successfully).
     *
     * The dispatch origin for this call must be _Signed_ by the controller, not the stash.
     *
     * ## Complexity
     * - O(1)
     * - Independent of the arguments. Insignificant complexity.
     * - Contains a limited number of reads.
     * - Writes are limited to the `origin` account key.
     * ---------
     */
    "set_payee": Anonymize<I9dgmcnuamt5p8>;
    /**
     * (Re-)sets the controller of a stash to the stash itself. This function previously
     * accepted a `controller` argument to set the controller to an account other than the
     * stash itself. This functionality has now been removed, now only setting the controller
     * to the stash, if it is not already.
     *
     * Effects will be felt instantly (as soon as this function is completed successfully).
     *
     * The dispatch origin for this call must be _Signed_ by the stash, not the controller.
     *
     * ## Complexity
     * O(1)
     * - Independent of the arguments. Insignificant complexity.
     * - Contains a limited number of reads.
     * - Writes are limited to the `origin` account key.
     */
    "set_controller": undefined;
    /**
     * Sets the ideal number of validators.
     *
     * The dispatch origin must be Root.
     *
     * ## Complexity
     * O(1)
     */
    "set_validator_count": Anonymize<I3vh014cqgmrfd>;
    /**
     * Increments the ideal number of validators up to maximum of
     * `ElectionProviderBase::MaxWinners`.
     *
     * The dispatch origin must be Root.
     *
     * ## Complexity
     * Same as [`Self::set_validator_count`].
     */
    "increase_validator_count": Anonymize<Ifhs60omlhvt3>;
    /**
     * Scale up the ideal number of validators by a factor up to maximum of
     * `ElectionProviderBase::MaxWinners`.
     *
     * The dispatch origin must be Root.
     *
     * ## Complexity
     * Same as [`Self::set_validator_count`].
     */
    "scale_validator_count": Anonymize<If34udpd5e57vi>;
    /**
     * Force there to be no new eras indefinitely.
     *
     * The dispatch origin must be Root.
     *
     * # Warning
     *
     * The election process starts multiple blocks before the end of the era.
     * Thus the election process may be ongoing when this is called. In this case the
     * election will continue until the next era is triggered.
     *
     * ## Complexity
     * - No arguments.
     * - Weight: O(1)
     */
    "force_no_eras": undefined;
    /**
     * Force there to be a new era at the end of the next session. After this, it will be
     * reset to normal (non-forced) behaviour.
     *
     * The dispatch origin must be Root.
     *
     * # Warning
     *
     * The election process starts multiple blocks before the end of the era.
     * If this is called just before a new era is triggered, the election process may not
     * have enough blocks to get a result.
     *
     * ## Complexity
     * - No arguments.
     * - Weight: O(1)
     */
    "force_new_era": undefined;
    /**
     * Set the validators who cannot be slashed (if any).
     *
     * The dispatch origin must be Root.
     */
    "set_invulnerables": Anonymize<I39t01nnod9109>;
    /**
     * Force a current staker to become completely unstaked, immediately.
     *
     * The dispatch origin must be Root.
     *
     * ## Parameters
     *
     * - `num_slashing_spans`: Refer to comments on [`Call::withdraw_unbonded`] for more
     * details.
     */
    "force_unstake": Anonymize<Ie5vbnd9198quk>;
    /**
     * Force there to be a new era at the end of sessions indefinitely.
     *
     * The dispatch origin must be Root.
     *
     * # Warning
     *
     * The election process starts multiple blocks before the end of the era.
     * If this is called just before a new era is triggered, the election process may not
     * have enough blocks to get a result.
     */
    "force_new_era_always": undefined;
    /**
     * Cancel enactment of a deferred slash.
     *
     * Can be called by the `T::AdminOrigin`.
     *
     * Parameters: era and indices of the slashes for that era to kill.
     */
    "cancel_deferred_slash": Anonymize<I3h6murn8bd4v5>;
    /**
     * Pay out next page of the stakers behind a validator for the given era.
     *
     * - `validator_stash` is the stash account of the validator.
     * - `era` may be any era between `[current_era - history_depth; current_era]`.
     *
     * The origin of this call must be _Signed_. Any account can call this function, even if
     * it is not one of the stakers.
     *
     * The reward payout could be paged in case there are too many nominators backing the
     * `validator_stash`. This call will payout unpaid pages in an ascending order. To claim a
     * specific page, use `payout_stakers_by_page`.`
     *
     * If all pages are claimed, it returns an error `InvalidPage`.
     */
    "payout_stakers": Anonymize<I6k6jf8ncesuu3>;
    /**
     * Rebond a portion of the stash scheduled to be unlocked.
     *
     * The dispatch origin must be signed by the controller.
     *
     * ## Complexity
     * - Time complexity: O(L), where L is unlocking chunks
     * - Bounded by `MaxUnlockingChunks`.
     */
    "rebond": Anonymize<Ie5v6njpckr05b>;
    /**
     * Remove all data structures concerning a staker/stash once it is at a state where it can
     * be considered `dust` in the staking system. The requirements are:
     *
     * 1. the `total_balance` of the stash is below existential deposit.
     * 2. or, the `ledger.total` of the stash is below existential deposit.
     * 3. or, existential deposit is zero and either `total_balance` or `ledger.total` is zero.
     *
     * The former can happen in cases like a slash; the latter when a fully unbonded account
     * is still receiving staking rewards in `RewardDestination::Staked`.
     *
     * It can be called by anyone, as long as `stash` meets the above requirements.
     *
     * Refunds the transaction fees upon successful execution.
     *
     * ## Parameters
     *
     * - `num_slashing_spans`: Refer to comments on [`Call::withdraw_unbonded`] for more
     * details.
     */
    "reap_stash": Anonymize<Ie5vbnd9198quk>;
    /**
     * Remove the given nominations from the calling validator.
     *
     * Effects will be felt at the beginning of the next era.
     *
     * The dispatch origin for this call must be _Signed_ by the controller, not the stash.
     *
     * - `who`: A list of nominator stash accounts who are nominating this validator which
     * should no longer be nominating this validator.
     *
     * Note: Making this call only makes sense if you first set the validator preferences to
     * block any further nominations.
     */
    "kick": Anonymize<I6rqcpg80db1fb>;
    /**
     * Update the various staking configurations .
     *
     * * `min_nominator_bond`: The minimum active bond needed to be a nominator.
     * * `min_validator_bond`: The minimum active bond needed to be a validator.
     * * `max_nominator_count`: The max number of users who can be a nominator at once. When
     * set to `None`, no limit is enforced.
     * * `max_validator_count`: The max number of users who can be a validator at once. When
     * set to `None`, no limit is enforced.
     * * `chill_threshold`: The ratio of `max_nominator_count` or `max_validator_count` which
     * should be filled in order for the `chill_other` transaction to work.
     * * `min_commission`: The minimum amount of commission that each validators must maintain.
     * This is checked only upon calling `validate`. Existing validators are not affected.
     *
     * RuntimeOrigin must be Root to call this function.
     *
     * NOTE: Existing nominators and validators will not be affected by this update.
     * to kick people under the new limits, `chill_other` should be called.
     */
    "set_staking_configs": Anonymize<If1qr0kbbl298c>;
    /**
     * Declare a `controller` to stop participating as either a validator or nominator.
     *
     * Effects will be felt at the beginning of the next era.
     *
     * The dispatch origin for this call must be _Signed_, but can be called by anyone.
     *
     * If the caller is the same as the controller being targeted, then no further checks are
     * enforced, and this function behaves just like `chill`.
     *
     * If the caller is different than the controller being targeted, the following conditions
     * must be met:
     *
     * * `controller` must belong to a nominator who has become non-decodable,
     *
     * Or:
     *
     * * A `ChillThreshold` must be set and checked which defines how close to the max
     * nominators or validators we must reach before users can start chilling one-another.
     * * A `MaxNominatorCount` and `MaxValidatorCount` must be set which is used to determine
     * how close we are to the threshold.
     * * A `MinNominatorBond` and `MinValidatorBond` must be set and checked, which determines
     * if this is a person that should be chilled because they have not met the threshold
     * bond required.
     *
     * This can be helpful if bond requirements are updated, and we need to remove old users
     * who do not satisfy these requirements.
     */
    "chill_other": Anonymize<Idl3umm12u5pa>;
    /**
     * Force a validator to have at least the minimum commission. This will not affect a
     * validator who already has a commission greater than or equal to the minimum. Any account
     * can call this.
     */
    "force_apply_min_commission": Anonymize<I5ont0141q9ss5>;
    /**
     * Sets the minimum amount of commission that each validators must maintain.
     *
     * This call has lower privilege requirements than `set_staking_config` and can be called
     * by the `T::AdminOrigin`. Root can always call this.
     */
    "set_min_commission": Anonymize<I3vh014cqgmrfd>;
    /**
     * Pay out a page of the stakers behind a validator for the given era and page.
     *
     * - `validator_stash` is the stash account of the validator.
     * - `era` may be any era between `[current_era - history_depth; current_era]`.
     * - `page` is the page index of nominators to pay out with value between 0 and
     * `num_nominators / T::MaxExposurePageSize`.
     *
     * The origin of this call must be _Signed_. Any account can call this function, even if
     * it is not one of the stakers.
     *
     * If a validator has more than [`Config::MaxExposurePageSize`] nominators backing
     * them, then the list of nominators is paged, with each page being capped at
     * [`Config::MaxExposurePageSize`.] If a validator has more than one page of nominators,
     * the call needs to be made for each page separately in order for all the nominators
     * backing a validator to receive the reward. The nominators are not sorted across pages
     * and so it should not be assumed the highest staker would be on the topmost page and vice
     * versa. If rewards are not claimed in [`Config::HistoryDepth`] eras, they are lost.
     */
    "payout_stakers_by_page": Anonymize<Ie6j49utvii126>;
    /**
     * Migrates an account's `RewardDestination::Controller` to
     * `RewardDestination::Account(controller)`.
     *
     * Effects will be felt instantly (as soon as this function is completed successfully).
     *
     * This will waive the transaction fee if the `payee` is successfully migrated.
     */
    "update_payee": Anonymize<I3v6ks33uluhnj>;
    /**
     * Updates a batch of controller accounts to their corresponding stash account if they are
     * not the same. Ignores any controller accounts that do not exist, and does not operate if
     * the stash and controller are already the same.
     *
     * Effects will be felt instantly (as soon as this function is completed successfully).
     *
     * The dispatch origin must be `T::AdminOrigin`.
     */
    "deprecate_controller_batch": Anonymize<I3kiiim1cds68i>;
    /**
     * Restores the state of a ledger which is in an inconsistent state.
     *
     * The requirements to restore a ledger are the following:
     * * The stash is bonded; or
     * * The stash is not bonded but it has a staking lock left behind; or
     * * If the stash has an associated ledger and its state is inconsistent; or
     * * If the ledger is not corrupted *but* its staking lock is out of sync.
     *
     * The `maybe_*` input parameters will overwrite the corresponding data and metadata of the
     * ledger associated with the stash. If the input parameters are not set, the ledger will
     * be reset values from on-chain state.
     */
    "restore_ledger": Anonymize<I4k60mkh2r6jjg>;
}>;
export type I2eip8tc75dpje = {
    "value": bigint;
    "payee": StakingRewardDestination;
};
export type I564va64vtidbq = {
    "max_additional": bigint;
};
export type I328av3j0bgmjb = {
    "num_slashing_spans": number;
};
export type I4tuqm9ato907i = {
    "prefs": Anonymize<I9o7ssi9vmhmgr>;
};
export type I19iomcbdrerea = {
    "targets": Anonymize<I2iqvvm6adorej>;
};
export type I2iqvvm6adorej = Array<Anonymize<I4su1fqci7afjt>>;
export type I9dgmcnuamt5p8 = {
    "payee": StakingRewardDestination;
};
export type I3vh014cqgmrfd = {
    "new": number;
};
export type Ifhs60omlhvt3 = {
    "additional": number;
};
export type If34udpd5e57vi = {
    "factor": number;
};
export type I39t01nnod9109 = {
    "invulnerables": Anonymize<Ia2lhg7l2hilo3>;
};
export type Ie5vbnd9198quk = {
    "stash": SS58String;
    "num_slashing_spans": number;
};
export type I3h6murn8bd4v5 = {
    "era": number;
    "slash_indices": Anonymize<Icgljjb6j82uhn>;
};
export type I6k6jf8ncesuu3 = {
    "validator_stash": SS58String;
    "era": number;
};
export type I6rqcpg80db1fb = {
    "who": Anonymize<I2iqvvm6adorej>;
};
export type If1qr0kbbl298c = {
    "min_nominator_bond": StakingPalletConfigOpBig;
    "min_validator_bond": StakingPalletConfigOpBig;
    "max_nominator_count": StakingPalletConfigOp;
    "max_validator_count": StakingPalletConfigOp;
    "chill_threshold": StakingPalletConfigOp;
    "min_commission": StakingPalletConfigOp;
    "max_staked_rewards": StakingPalletConfigOp;
};
export type StakingPalletConfigOpBig = Enum<{
    "Noop": undefined;
    "Set": bigint;
    "Remove": undefined;
}>;
export declare const StakingPalletConfigOpBig: GetEnum<StakingPalletConfigOpBig>;
export type StakingPalletConfigOp = Enum<{
    "Noop": undefined;
    "Set": number;
    "Remove": undefined;
}>;
export declare const StakingPalletConfigOp: GetEnum<StakingPalletConfigOp>;
export type I5ont0141q9ss5 = {
    "validator_stash": SS58String;
};
export type Ie6j49utvii126 = {
    "validator_stash": SS58String;
    "era": number;
    "page": number;
};
export type I3v6ks33uluhnj = {
    "controller": SS58String;
};
export type I3kiiim1cds68i = {
    "controllers": Anonymize<Ia2lhg7l2hilo3>;
};
export type I4k60mkh2r6jjg = {
    "stash": SS58String;
    "maybe_controller"?: Anonymize<Ihfphjolmsqq1>;
    "maybe_total"?: Anonymize<I35p85j063s0il>;
    "maybe_unlocking"?: (Anonymize<I9nc4v1upo2c8e>) | undefined;
};
export type I9nc4v1upo2c8e = Array<{
    "value": bigint;
    "era": number;
}>;
export type Ia7mlrjeasn8qd = AnonymousEnum<{
    /**
     * Sets the session key(s) of the function caller to `keys`.
     * Allows an account to set its session key prior to becoming a validator.
     * This doesn't take effect until the next session.
     *
     * The dispatch origin of this function must be signed.
     *
     * ## Complexity
     * - `O(1)`. Actual cost depends on the number of length of `T::Keys::key_ids()` which is
     * fixed.
     */
    "set_keys": Anonymize<I7b38nnt67hfdg>;
    /**
     * Removes any session key(s) of the function caller.
     *
     * This doesn't take effect until the next session.
     *
     * The dispatch origin of this function must be Signed and the account must be either be
     * convertible to a validator ID using the chain's typical addressing system (this usually
     * means being a controller account) or directly convertible into a validator ID (which
     * usually means being a stash account).
     *
     * ## Complexity
     * - `O(1)` in number of key types. Actual cost depends on the number of length of
     * `T::Keys::key_ids()` which is fixed.
     */
    "purge_keys": undefined;
}>;
export type I7b38nnt67hfdg = {
    "keys": Anonymize<Ifngji0jpcpvpj>;
    "proof": Binary;
};
export type Ifngji0jpcpvpj = {
    "babe": FixedSizeBinary<32>;
    "grandpa": FixedSizeBinary<32>;
    "im_online": FixedSizeBinary<32>;
};
export type I82abq3hsudkhd = AnonymousEnum<{
    /**
     * Propose and approve a spend of treasury funds.
     *
     * ## Dispatch Origin
     *
     * Must be [`Config::SpendOrigin`] with the `Success` value being at least `amount`.
     *
     * ### Details
     * NOTE: For record-keeping purposes, the proposer is deemed to be equivalent to the
     * beneficiary.
     *
     * ### Parameters
     * - `amount`: The amount to be transferred from the treasury to the `beneficiary`.
     * - `beneficiary`: The destination account for the transfer.
     *
     * ## Events
     *
     * Emits [`Event::SpendApproved`] if successful.
     */
    "spend_local": Anonymize<I7fcl4aua07ato>;
    /**
     * Force a previously approved proposal to be removed from the approval queue.
     *
     * ## Dispatch Origin
     *
     * Must be [`Config::RejectOrigin`].
     *
     * ## Details
     *
     * The original deposit will no longer be returned.
     *
     * ### Parameters
     * - `proposal_id`: The index of a proposal
     *
     * ### Complexity
     * - O(A) where `A` is the number of approvals
     *
     * ### Errors
     * - [`Error::ProposalNotApproved`]: The `proposal_id` supplied was not found in the
     * approval queue, i.e., the proposal has not been approved. This could also mean the
     * proposal does not exist altogether, thus there is no way it would have been approved
     * in the first place.
     */
    "remove_approval": Anonymize<Icm9m0qeemu66d>;
    /**
     * Propose and approve a spend of treasury funds.
     *
     * ## Dispatch Origin
     *
     * Must be [`Config::SpendOrigin`] with the `Success` value being at least
     * `amount` of `asset_kind` in the native asset. The amount of `asset_kind` is converted
     * for assertion using the [`Config::BalanceConverter`].
     *
     * ## Details
     *
     * Create an approved spend for transferring a specific `amount` of `asset_kind` to a
     * designated beneficiary. The spend must be claimed using the `payout` dispatchable within
     * the [`Config::PayoutPeriod`].
     *
     * ### Parameters
     * - `asset_kind`: An indicator of the specific asset class to be spent.
     * - `amount`: The amount to be transferred from the treasury to the `beneficiary`.
     * - `beneficiary`: The beneficiary of the spend.
     * - `valid_from`: The block number from which the spend can be claimed. It can refer to
     * the past if the resulting spend has not yet expired according to the
     * [`Config::PayoutPeriod`]. If `None`, the spend can be claimed immediately after
     * approval.
     *
     * ## Events
     *
     * Emits [`Event::AssetSpendApproved`] if successful.
     */
    "spend": Anonymize<Iff30ongi0pbsu>;
    /**
     * Claim a spend.
     *
     * ## Dispatch Origin
     *
     * Must be signed
     *
     * ## Details
     *
     * Spends must be claimed within some temporal bounds. A spend may be claimed within one
     * [`Config::PayoutPeriod`] from the `valid_from` block.
     * In case of a payout failure, the spend status must be updated with the `check_status`
     * dispatchable before retrying with the current function.
     *
     * ### Parameters
     * - `index`: The spend index.
     *
     * ## Events
     *
     * Emits [`Event::Paid`] if successful.
     */
    "payout": Anonymize<I666bl2fqjkejo>;
    /**
     * Check the status of the spend and remove it from the storage if processed.
     *
     * ## Dispatch Origin
     *
     * Must be signed.
     *
     * ## Details
     *
     * The status check is a prerequisite for retrying a failed payout.
     * If a spend has either succeeded or expired, it is removed from the storage by this
     * function. In such instances, transaction fees are refunded.
     *
     * ### Parameters
     * - `index`: The spend index.
     *
     * ## Events
     *
     * Emits [`Event::PaymentFailed`] if the spend payout has failed.
     * Emits [`Event::SpendProcessed`] if the spend payout has succeed.
     */
    "check_status": Anonymize<I666bl2fqjkejo>;
    /**
     * Void previously approved spend.
     *
     * ## Dispatch Origin
     *
     * Must be [`Config::RejectOrigin`].
     *
     * ## Details
     *
     * A spend void is only possible if the payout has not been attempted yet.
     *
     * ### Parameters
     * - `index`: The spend index.
     *
     * ## Events
     *
     * Emits [`Event::AssetSpendVoided`] if successful.
     */
    "void_spend": Anonymize<I666bl2fqjkejo>;
}>;
export type I7fcl4aua07ato = {
    "amount": bigint;
    "beneficiary": Anonymize<I4su1fqci7afjt>;
};
export type Icm9m0qeemu66d = {
    "proposal_id": number;
};
export type Iff30ongi0pbsu = {
    "amount": bigint;
    "beneficiary": SS58String;
    "valid_from"?: Anonymize<I35p85j063s0il>;
};
export type Id3i1hd0p5rkpe = AnonymousEnum<{
    /**
     * Propose a new bounty.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Payment: `TipReportDepositBase` will be reserved from the origin account, as well as
     * `DataDepositPerByte` for each byte in `reason`. It will be unreserved upon approval,
     * or slashed when rejected.
     *
     * - `curator`: The curator account whom will manage this bounty.
     * - `fee`: The curator fee.
     * - `value`: The total payment amount of this bounty, curator fee included.
     * - `description`: The description of this bounty.
     */
    "propose_bounty": Anonymize<I2a839vbf5817q>;
    /**
     * Approve a bounty proposal. At a later time, the bounty will be funded and become active
     * and the original deposit will be returned.
     *
     * May only be called from `T::SpendOrigin`.
     *
     * ## Complexity
     * - O(1).
     */
    "approve_bounty": Anonymize<Ia9p5bg6p18r0i>;
    /**
     * Propose a curator to a funded bounty.
     *
     * May only be called from `T::SpendOrigin`.
     *
     * ## Complexity
     * - O(1).
     */
    "propose_curator": Anonymize<I5rlb1eesbovji>;
    /**
     * Unassign curator from a bounty.
     *
     * This function can only be called by the `RejectOrigin` a signed origin.
     *
     * If this function is called by the `RejectOrigin`, we assume that the curator is
     * malicious or inactive. As a result, we will slash the curator when possible.
     *
     * If the origin is the curator, we take this as a sign they are unable to do their job and
     * they willingly give up. We could slash them, but for now we allow them to recover their
     * deposit and exit without issue. (We may want to change this if it is abused.)
     *
     * Finally, the origin can be anyone if and only if the curator is "inactive". This allows
     * anyone in the community to call out that a curator is not doing their due diligence, and
     * we should pick a new curator. In this case the curator should also be slashed.
     *
     * ## Complexity
     * - O(1).
     */
    "unassign_curator": Anonymize<Ia9p5bg6p18r0i>;
    /**
     * Accept the curator role for a bounty.
     * A deposit will be reserved from curator and refund upon successful payout.
     *
     * May only be called from the curator.
     *
     * ## Complexity
     * - O(1).
     */
    "accept_curator": Anonymize<Ia9p5bg6p18r0i>;
    /**
     * Award bounty to a beneficiary account. The beneficiary will be able to claim the funds
     * after a delay.
     *
     * The dispatch origin for this call must be the curator of this bounty.
     *
     * - `bounty_id`: Bounty ID to award.
     * - `beneficiary`: The beneficiary account whom will receive the payout.
     *
     * ## Complexity
     * - O(1).
     */
    "award_bounty": Anonymize<Ia96ru6pujbas0>;
    /**
     * Claim the payout from an awarded bounty after payout delay.
     *
     * The dispatch origin for this call must be the beneficiary of this bounty.
     *
     * - `bounty_id`: Bounty ID to claim.
     *
     * ## Complexity
     * - O(1).
     */
    "claim_bounty": Anonymize<Ia9p5bg6p18r0i>;
    /**
     * Cancel a proposed or active bounty. All the funds will be sent to treasury and
     * the curator deposit will be unreserved if possible.
     *
     * Only `T::RejectOrigin` is able to cancel a bounty.
     *
     * - `bounty_id`: Bounty ID to cancel.
     *
     * ## Complexity
     * - O(1).
     */
    "close_bounty": Anonymize<Ia9p5bg6p18r0i>;
    /**
     * Extend the expiry time of an active bounty.
     *
     * The dispatch origin for this call must be the curator of this bounty.
     *
     * - `bounty_id`: Bounty ID to extend.
     * - `remark`: additional information.
     *
     * ## Complexity
     * - O(1).
     */
    "extend_bounty_expiry": Anonymize<I90n6nnkpdahrh>;
}>;
export type I2a839vbf5817q = {
    "value": bigint;
    "description": Binary;
};
export type I5rlb1eesbovji = {
    "bounty_id": number;
    "curator": Anonymize<I4su1fqci7afjt>;
    "fee": bigint;
};
export type Ia96ru6pujbas0 = {
    "bounty_id": number;
    "beneficiary": Anonymize<I4su1fqci7afjt>;
};
export type I90n6nnkpdahrh = {
    "bounty_id": number;
    "remark": Binary;
};
export type Iq2t6ejghtjp4 = AnonymousEnum<{
    /**
     * Add a new child-bounty.
     *
     * The dispatch origin for this call must be the curator of parent
     * bounty and the parent bounty must be in "active" state.
     *
     * Child-bounty gets added successfully & fund gets transferred from
     * parent bounty to child-bounty account, if parent bounty has enough
     * funds, else the call fails.
     *
     * Upper bound to maximum number of active  child bounties that can be
     * added are managed via runtime trait config
     * [`Config::MaxActiveChildBountyCount`].
     *
     * If the call is success, the status of child-bounty is updated to
     * "Added".
     *
     * - `parent_bounty_id`: Index of parent bounty for which child-bounty is being added.
     * - `value`: Value for executing the proposal.
     * - `description`: Text description for the child-bounty.
     */
    "add_child_bounty": Anonymize<I8mk5kjgn02hi8>;
    /**
     * Propose curator for funded child-bounty.
     *
     * The dispatch origin for this call must be curator of parent bounty.
     *
     * Parent bounty must be in active state, for this child-bounty call to
     * work.
     *
     * Child-bounty must be in "Added" state, for processing the call. And
     * state of child-bounty is moved to "CuratorProposed" on successful
     * call completion.
     *
     * - `parent_bounty_id`: Index of parent bounty.
     * - `child_bounty_id`: Index of child bounty.
     * - `curator`: Address of child-bounty curator.
     * - `fee`: payment fee to child-bounty curator for execution.
     */
    "propose_curator": Anonymize<I5onpf3u0obsqb>;
    /**
     * Accept the curator role for the child-bounty.
     *
     * The dispatch origin for this call must be the curator of this
     * child-bounty.
     *
     * A deposit will be reserved from the curator and refund upon
     * successful payout or cancellation.
     *
     * Fee for curator is deducted from curator fee of parent bounty.
     *
     * Parent bounty must be in active state, for this child-bounty call to
     * work.
     *
     * Child-bounty must be in "CuratorProposed" state, for processing the
     * call. And state of child-bounty is moved to "Active" on successful
     * call completion.
     *
     * - `parent_bounty_id`: Index of parent bounty.
     * - `child_bounty_id`: Index of child bounty.
     */
    "accept_curator": Anonymize<I2gr10p66od9ch>;
    /**
     * Unassign curator from a child-bounty.
     *
     * The dispatch origin for this call can be either `RejectOrigin`, or
     * the curator of the parent bounty, or any signed origin.
     *
     * For the origin other than T::RejectOrigin and the child-bounty
     * curator, parent bounty must be in active state, for this call to
     * work. We allow child-bounty curator and T::RejectOrigin to execute
     * this call irrespective of the parent bounty state.
     *
     * If this function is called by the `RejectOrigin` or the
     * parent bounty curator, we assume that the child-bounty curator is
     * malicious or inactive. As a result, child-bounty curator deposit is
     * slashed.
     *
     * If the origin is the child-bounty curator, we take this as a sign
     * that they are unable to do their job, and are willingly giving up.
     * We could slash the deposit, but for now we allow them to unreserve
     * their deposit and exit without issue. (We may want to change this if
     * it is abused.)
     *
     * Finally, the origin can be anyone iff the child-bounty curator is
     * "inactive". Expiry update due of parent bounty is used to estimate
     * inactive state of child-bounty curator.
     *
     * This allows anyone in the community to call out that a child-bounty
     * curator is not doing their due diligence, and we should pick a new
     * one. In this case the child-bounty curator deposit is slashed.
     *
     * State of child-bounty is moved to Added state on successful call
     * completion.
     *
     * - `parent_bounty_id`: Index of parent bounty.
     * - `child_bounty_id`: Index of child bounty.
     */
    "unassign_curator": Anonymize<I2gr10p66od9ch>;
    /**
     * Award child-bounty to a beneficiary.
     *
     * The beneficiary will be able to claim the funds after a delay.
     *
     * The dispatch origin for this call must be the parent curator or
     * curator of this child-bounty.
     *
     * Parent bounty must be in active state, for this child-bounty call to
     * work.
     *
     * Child-bounty must be in active state, for processing the call. And
     * state of child-bounty is moved to "PendingPayout" on successful call
     * completion.
     *
     * - `parent_bounty_id`: Index of parent bounty.
     * - `child_bounty_id`: Index of child bounty.
     * - `beneficiary`: Beneficiary account.
     */
    "award_child_bounty": Anonymize<I5d9an59q96b9e>;
    /**
     * Claim the payout from an awarded child-bounty after payout delay.
     *
     * The dispatch origin for this call may be any signed origin.
     *
     * Call works independent of parent bounty state, No need for parent
     * bounty to be in active state.
     *
     * The Beneficiary is paid out with agreed bounty value. Curator fee is
     * paid & curator deposit is unreserved.
     *
     * Child-bounty must be in "PendingPayout" state, for processing the
     * call. And instance of child-bounty is removed from the state on
     * successful call completion.
     *
     * - `parent_bounty_id`: Index of parent bounty.
     * - `child_bounty_id`: Index of child bounty.
     */
    "claim_child_bounty": Anonymize<I2gr10p66od9ch>;
    /**
     * Cancel a proposed or active child-bounty. Child-bounty account funds
     * are transferred to parent bounty account. The child-bounty curator
     * deposit may be unreserved if possible.
     *
     * The dispatch origin for this call must be either parent curator or
     * `T::RejectOrigin`.
     *
     * If the state of child-bounty is `Active`, curator deposit is
     * unreserved.
     *
     * If the state of child-bounty is `PendingPayout`, call fails &
     * returns `PendingPayout` error.
     *
     * For the origin other than T::RejectOrigin, parent bounty must be in
     * active state, for this child-bounty call to work. For origin
     * T::RejectOrigin execution is forced.
     *
     * Instance of child-bounty is removed from the state on successful
     * call completion.
     *
     * - `parent_bounty_id`: Index of parent bounty.
     * - `child_bounty_id`: Index of child bounty.
     */
    "close_child_bounty": Anonymize<I2gr10p66od9ch>;
}>;
export type I8mk5kjgn02hi8 = {
    "parent_bounty_id": number;
    "value": bigint;
    "description": Binary;
};
export type I5onpf3u0obsqb = {
    "parent_bounty_id": number;
    "child_bounty_id": number;
    "curator": Anonymize<I4su1fqci7afjt>;
    "fee": bigint;
};
export type I2gr10p66od9ch = {
    "parent_bounty_id": number;
    "child_bounty_id": number;
};
export type I5d9an59q96b9e = {
    "parent_bounty_id": number;
    "child_bounty_id": number;
    "beneficiary": Anonymize<I4su1fqci7afjt>;
};
export type Iddr6fva4nhp6t = AnonymousEnum<{
    /**
     * Declare that some `dislocated` account has, through rewards or penalties, sufficiently
     * changed its score that it should properly fall into a different bag than its current
     * one.
     *
     * Anyone can call this function about any potentially dislocated account.
     *
     * Will always update the stored score of `dislocated` to the correct score, based on
     * `ScoreProvider`.
     *
     * If `dislocated` does not exists, it returns an error.
     */
    "rebag": Anonymize<Iepvl96j3rpblo>;
    /**
     * Move the caller's Id directly in front of `lighter`.
     *
     * The dispatch origin for this call must be _Signed_ and can only be called by the Id of
     * the account going in front of `lighter`. Fee is payed by the origin under all
     * circumstances.
     *
     * Only works if:
     *
     * - both nodes are within the same bag,
     * - and `origin` has a greater `Score` than `lighter`.
     */
    "put_in_front_of": Anonymize<Iems2cb8v3lka8>;
    /**
     * Same as [`Pallet::put_in_front_of`], but it can be called by anyone.
     *
     * Fee is paid by the origin under all circumstances.
     */
    "put_in_front_of_other": Anonymize<I4oh0ds0hgt386>;
}>;
export type Iepvl96j3rpblo = {
    "dislocated": Anonymize<I4su1fqci7afjt>;
};
export type Iems2cb8v3lka8 = {
    "lighter": Anonymize<I4su1fqci7afjt>;
};
export type I4oh0ds0hgt386 = {
    "heavier": Anonymize<I4su1fqci7afjt>;
    "lighter": Anonymize<I4su1fqci7afjt>;
};
export type I5optopuv2imd3 = AnonymousEnum<{
    /**
     * Stake funds with a pool. The amount to bond is transferred from the member to the
     * pools account and immediately increases the pools bond.
     *
     * # Note
     *
     * * An account can only be a member of a single pool.
     * * An account cannot join the same pool multiple times.
     * * This call will *not* dust the member account, so the member must have at least
     * `existential deposit + amount` in their account.
     * * Only a pool with [`PoolState::Open`] can be joined
     */
    "join": Anonymize<Ieg1oc56mamrl5>;
    /**
     * Bond `extra` more funds from `origin` into the pool to which they already belong.
     *
     * Additional funds can come from either the free balance of the account, of from the
     * accumulated rewards, see [`BondExtra`].
     *
     * Bonding extra funds implies an automatic payout of all pending rewards as well.
     * See `bond_extra_other` to bond pending rewards of `other` members.
     */
    "bond_extra": Anonymize<I2vu5vj7173ik9>;
    /**
     * A bonded member can use this to claim their payout based on the rewards that the pool
     * has accumulated since their last claimed payout (OR since joining if this is their first
     * time claiming rewards). The payout will be transferred to the member's account.
     *
     * The member will earn rewards pro rata based on the members stake vs the sum of the
     * members in the pools stake. Rewards do not "expire".
     *
     * See `claim_payout_other` to claim rewards on behalf of some `other` pool member.
     */
    "claim_payout": undefined;
    /**
     * Unbond up to `unbonding_points` of the `member_account`'s funds from the pool. It
     * implicitly collects the rewards one last time, since not doing so would mean some
     * rewards would be forfeited.
     *
     * Under certain conditions, this call can be dispatched permissionlessly (i.e. by any
     * account).
     *
     * # Conditions for a permissionless dispatch.
     *
     * * The pool is blocked and the caller is either the root or bouncer. This is refereed to
     * as a kick.
     * * The pool is destroying and the member is not the depositor.
     * * The pool is destroying, the member is the depositor and no other members are in the
     * pool.
     *
     * ## Conditions for permissioned dispatch (i.e. the caller is also the
     * `member_account`):
     *
     * * The caller is not the depositor.
     * * The caller is the depositor, the pool is destroying and no other members are in the
     * pool.
     *
     * # Note
     *
     * If there are too many unlocking chunks to unbond with the pool account,
     * [`Call::pool_withdraw_unbonded`] can be called to try and minimize unlocking chunks.
     * The [`StakingInterface::unbond`] will implicitly call [`Call::pool_withdraw_unbonded`]
     * to try to free chunks if necessary (ie. if unbound was called and no unlocking chunks
     * are available). However, it may not be possible to release the current unlocking chunks,
     * in which case, the result of this call will likely be the `NoMoreChunks` error from the
     * staking system.
     */
    "unbond": Anonymize<Id70c5vciftf2i>;
    /**
     * Call `withdraw_unbonded` for the pools account. This call can be made by any account.
     *
     * This is useful if there are too many unlocking chunks to call `unbond`, and some
     * can be cleared by withdrawing. In the case there are too many unlocking chunks, the user
     * would probably see an error like `NoMoreChunks` emitted from the staking system when
     * they attempt to unbond.
     */
    "pool_withdraw_unbonded": Anonymize<I36uoc8t9liv80>;
    /**
     * Withdraw unbonded funds from `member_account`. If no bonded funds can be unbonded, an
     * error is returned.
     *
     * Under certain conditions, this call can be dispatched permissionlessly (i.e. by any
     * account).
     *
     * # Conditions for a permissionless dispatch
     *
     * * The pool is in destroy mode and the target is not the depositor.
     * * The target is the depositor and they are the only member in the sub pools.
     * * The pool is blocked and the caller is either the root or bouncer.
     *
     * # Conditions for permissioned dispatch
     *
     * * The caller is the target and they are not the depositor.
     *
     * # Note
     *
     * - If the target is the depositor, the pool will be destroyed.
     * - If the pool has any pending slash, we also try to slash the member before letting them
     * withdraw. This calculation adds some weight overhead and is only defensive. In reality,
     * pool slashes must have been already applied via permissionless [`Call::apply_slash`].
     */
    "withdraw_unbonded": Anonymize<I9iq45aekjq7kb>;
    /**
     * Create a new delegation pool.
     *
     * # Arguments
     *
     * * `amount` - The amount of funds to delegate to the pool. This also acts of a sort of
     * deposit since the pools creator cannot fully unbond funds until the pool is being
     * destroyed.
     * * `index` - A disambiguation index for creating the account. Likely only useful when
     * creating multiple pools in the same extrinsic.
     * * `root` - The account to set as [`PoolRoles::root`].
     * * `nominator` - The account to set as the [`PoolRoles::nominator`].
     * * `bouncer` - The account to set as the [`PoolRoles::bouncer`].
     *
     * # Note
     *
     * In addition to `amount`, the caller will transfer the existential deposit; so the caller
     * needs at have at least `amount + existential_deposit` transferable.
     */
    "create": Anonymize<I26ne2mpnrbqa5>;
    /**
     * Create a new delegation pool with a previously used pool id
     *
     * # Arguments
     *
     * same as `create` with the inclusion of
     * * `pool_id` - `A valid PoolId.
     */
    "create_with_pool_id": Anonymize<I9tlpr80ot76ta>;
    /**
     * Nominate on behalf of the pool.
     *
     * The dispatch origin of this call must be signed by the pool nominator or the pool
     * root role.
     *
     * This directly forward the call to the staking pallet, on behalf of the pool bonded
     * account.
     *
     * # Note
     *
     * In addition to a `root` or `nominator` role of `origin`, pool's depositor needs to have
     * at least `depositor_min_bond` in the pool to start nominating.
     */
    "nominate": Anonymize<I47a2tsd2o2b1c>;
    /**
     * Set a new state for the pool.
     *
     * If a pool is already in the `Destroying` state, then under no condition can its state
     * change again.
     *
     * The dispatch origin of this call must be either:
     *
     * 1. signed by the bouncer, or the root role of the pool,
     * 2. if the pool conditions to be open are NOT met (as described by `ok_to_be_open`), and
     * then the state of the pool can be permissionlessly changed to `Destroying`.
     */
    "set_state": Anonymize<Ifc9k1s0e9nv8e>;
    /**
     * Set a new metadata for the pool.
     *
     * The dispatch origin of this call must be signed by the bouncer, or the root role of the
     * pool.
     */
    "set_metadata": Anonymize<I4ihj26hl75e5p>;
    /**
     * Update configurations for the nomination pools. The origin for this call must be
     * [`Config::AdminOrigin`].
     *
     * # Arguments
     *
     * * `min_join_bond` - Set [`MinJoinBond`].
     * * `min_create_bond` - Set [`MinCreateBond`].
     * * `max_pools` - Set [`MaxPools`].
     * * `max_members` - Set [`MaxPoolMembers`].
     * * `max_members_per_pool` - Set [`MaxPoolMembersPerPool`].
     * * `global_max_commission` - Set [`GlobalMaxCommission`].
     */
    "set_configs": Anonymize<I2dl8ekhm2t22h>;
    /**
     * Update the roles of the pool.
     *
     * The root is the only entity that can change any of the roles, including itself,
     * excluding the depositor, who can never change.
     *
     * It emits an event, notifying UIs of the role change. This event is quite relevant to
     * most pool members and they should be informed of changes to pool roles.
     */
    "update_roles": Anonymize<I13us5e5h5645o>;
    /**
     * Chill on behalf of the pool.
     *
     * The dispatch origin of this call can be signed by the pool nominator or the pool
     * root role, same as [`Pallet::nominate`].
     *
     * Under certain conditions, this call can be dispatched permissionlessly (i.e. by any
     * account).
     *
     * # Conditions for a permissionless dispatch:
     * * When pool depositor has less than `MinNominatorBond` staked, otherwise  pool members
     * are unable to unbond.
     *
     * # Conditions for permissioned dispatch:
     * * The caller has a nominator or root role of the pool.
     * This directly forward the call to the staking pallet, on behalf of the pool bonded
     * account.
     */
    "chill": Anonymize<I931cottvong90>;
    /**
     * `origin` bonds funds from `extra` for some pool member `member` into their respective
     * pools.
     *
     * `origin` can bond extra funds from free balance or pending rewards when `origin ==
     * other`.
     *
     * In the case of `origin != other`, `origin` can only bond extra pending rewards of
     * `other` members assuming set_claim_permission for the given member is
     * `PermissionlessCompound` or `PermissionlessAll`.
     */
    "bond_extra_other": Anonymize<Ic4h0nvtu79ch6>;
    /**
     * Allows a pool member to set a claim permission to allow or disallow permissionless
     * bonding and withdrawing.
     *
     * # Arguments
     *
     * * `origin` - Member of a pool.
     * * `permission` - The permission to be applied.
     */
    "set_claim_permission": Anonymize<I1ors0vru14it3>;
    /**
     * `origin` can claim payouts on some pool member `other`'s behalf.
     *
     * Pool member `other` must have a `PermissionlessWithdraw` or `PermissionlessAll` claim
     * permission for this call to be successful.
     */
    "claim_payout_other": Anonymize<I40s11r8nagn2g>;
    /**
     * Set the commission of a pool.
     * Both a commission percentage and a commission payee must be provided in the `current`
     * tuple. Where a `current` of `None` is provided, any current commission will be removed.
     *
     * - If a `None` is supplied to `new_commission`, existing commission will be removed.
     */
    "set_commission": Anonymize<I6bjj87fr5g9nl>;
    /**
     * Set the maximum commission of a pool.
     *
     * - Initial max can be set to any `Perbill`, and only smaller values thereafter.
     * - Current commission will be lowered in the event it is higher than a new max
     * commission.
     */
    "set_commission_max": Anonymize<I8cbluptqo8kbp>;
    /**
     * Set the commission change rate for a pool.
     *
     * Initial change rate is not bounded, whereas subsequent updates can only be more
     * restrictive than the current.
     */
    "set_commission_change_rate": Anonymize<I6t5r359eagicn>;
    /**
     * Claim pending commission.
     *
     * The dispatch origin of this call must be signed by the `root` role of the pool. Pending
     * commission is paid out and added to total claimed commission`. Total pending commission
     * is reset to zero. the current.
     */
    "claim_commission": Anonymize<I931cottvong90>;
    /**
     * Top up the deficit or withdraw the excess ED from the pool.
     *
     * When a pool is created, the pool depositor transfers ED to the reward account of the
     * pool. ED is subject to change and over time, the deposit in the reward account may be
     * insufficient to cover the ED deficit of the pool or vice-versa where there is excess
     * deposit to the pool. This call allows anyone to adjust the ED deposit of the
     * pool by either topping up the deficit or claiming the excess.
     */
    "adjust_pool_deposit": Anonymize<I931cottvong90>;
    /**
     * Set or remove a pool's commission claim permission.
     *
     * Determines who can claim the pool's pending commission. Only the `Root` role of the pool
     * is able to configure commission claim permissions.
     */
    "set_commission_claim_permission": Anonymize<I3ihan8icf0c5k>;
    /**
     * Apply a pending slash on a member.
     *
     * Fails unless [`crate::pallet::Config::StakeAdapter`] is of strategy type:
     * [`adapter::StakeStrategyType::Delegate`].
     *
     * The pending slash amount of the member must be equal or more than `ExistentialDeposit`.
     * This call can be dispatched permissionlessly (i.e. by any account). If the execution
     * is successful, fee is refunded and caller may be rewarded with a part of the slash
     * based on the [`crate::pallet::Config::StakeAdapter`] configuration.
     */
    "apply_slash": Anonymize<I7aouqn0g9m7gc>;
    /**
     * Migrates delegated funds from the pool account to the `member_account`.
     *
     * Fails unless [`crate::pallet::Config::StakeAdapter`] is of strategy type:
     * [`adapter::StakeStrategyType::Delegate`].
     *
     * This is a permission-less call and refunds any fee if claim is successful.
     *
     * If the pool has migrated to delegation based staking, the staked tokens of pool members
     * can be moved and held in their own account. See [`adapter::DelegateStake`]
     */
    "migrate_delegation": Anonymize<I7aouqn0g9m7gc>;
    /**
     * Migrate pool from [`adapter::StakeStrategyType::Transfer`] to
     * [`adapter::StakeStrategyType::Delegate`].
     *
     * Fails unless [`crate::pallet::Config::StakeAdapter`] is of strategy type:
     * [`adapter::StakeStrategyType::Delegate`].
     *
     * This call can be dispatched permissionlessly, and refunds any fee if successful.
     *
     * If the pool has already migrated to delegation based staking, this call will fail.
     */
    "migrate_pool_to_delegate_stake": Anonymize<I931cottvong90>;
}>;
export type I2vu5vj7173ik9 = {
    "extra": NominationPoolsBondExtra;
};
export type NominationPoolsBondExtra = Enum<{
    "FreeBalance": bigint;
    "Rewards": undefined;
}>;
export declare const NominationPoolsBondExtra: GetEnum<NominationPoolsBondExtra>;
export type Id70c5vciftf2i = {
    "member_account": Anonymize<I4su1fqci7afjt>;
    "unbonding_points": bigint;
};
export type I36uoc8t9liv80 = {
    "pool_id": number;
    "num_slashing_spans": number;
};
export type I9iq45aekjq7kb = {
    "member_account": Anonymize<I4su1fqci7afjt>;
    "num_slashing_spans": number;
};
export type I26ne2mpnrbqa5 = {
    "amount": bigint;
    "root": Anonymize<I4su1fqci7afjt>;
    "nominator": Anonymize<I4su1fqci7afjt>;
    "bouncer": Anonymize<I4su1fqci7afjt>;
};
export type I9tlpr80ot76ta = {
    "amount": bigint;
    "root": Anonymize<I4su1fqci7afjt>;
    "nominator": Anonymize<I4su1fqci7afjt>;
    "bouncer": Anonymize<I4su1fqci7afjt>;
    "pool_id": number;
};
export type I47a2tsd2o2b1c = {
    "pool_id": number;
    "validators": Anonymize<Ia2lhg7l2hilo3>;
};
export type Ifc9k1s0e9nv8e = {
    "pool_id": number;
    "state": NominationPoolsPoolState;
};
export type I4ihj26hl75e5p = {
    "pool_id": number;
    "metadata": Binary;
};
export type I2dl8ekhm2t22h = {
    "min_join_bond": StakingPalletConfigOpBig;
    "min_create_bond": StakingPalletConfigOpBig;
    "max_pools": StakingPalletConfigOp;
    "max_members": StakingPalletConfigOp;
    "max_members_per_pool": StakingPalletConfigOp;
    "global_max_commission": StakingPalletConfigOp;
};
export type I13us5e5h5645o = {
    "pool_id": number;
    "new_root": NominationPoolsConfigOp;
    "new_nominator": NominationPoolsConfigOp;
    "new_bouncer": NominationPoolsConfigOp;
};
export type NominationPoolsConfigOp = Enum<{
    "Noop": undefined;
    "Set": SS58String;
    "Remove": undefined;
}>;
export declare const NominationPoolsConfigOp: GetEnum<NominationPoolsConfigOp>;
export type Ic4h0nvtu79ch6 = {
    "member": Anonymize<I4su1fqci7afjt>;
    "extra": NominationPoolsBondExtra;
};
export type I1ors0vru14it3 = {
    "permission": NominationPoolsClaimPermission;
};
export type NominationPoolsClaimPermission = Enum<{
    "Permissioned": undefined;
    "PermissionlessCompound": undefined;
    "PermissionlessWithdraw": undefined;
    "PermissionlessAll": undefined;
}>;
export declare const NominationPoolsClaimPermission: GetEnum<NominationPoolsClaimPermission>;
export type I40s11r8nagn2g = {
    "other": SS58String;
};
export type I6bjj87fr5g9nl = {
    "pool_id": number;
    "new_commission"?: Anonymize<Ie8iutm7u02lmj>;
};
export type I7aouqn0g9m7gc = {
    "member_account": Anonymize<I4su1fqci7afjt>;
};
export type Iav5p1kohai2ld = AnonymousEnum<{
    /**
     * Anonymously schedule a task.
     */
    "schedule": Anonymize<I8e7g876q3bfql>;
    /**
     * Cancel an anonymously scheduled task.
     */
    "cancel": Anonymize<I229jvdlbdhm94>;
    /**
     * Schedule a named task.
     */
    "schedule_named": Anonymize<I9dm0i7fm6o3ac>;
    /**
     * Cancel a named scheduled task.
     */
    "cancel_named": Anonymize<Ifs1i5fk9cqvr6>;
    /**
     * Anonymously schedule a task after a delay.
     */
    "schedule_after": Anonymize<I8687goclso3lb>;
    /**
     * Schedule a named task after a delay.
     */
    "schedule_named_after": Anonymize<Ids6rugsrrgf4d>;
    /**
     * Set a retry configuration for a task so that, in case its scheduled run fails, it will
     * be retried after `period` blocks, for a total amount of `retries` retries or until it
     * succeeds.
     *
     * Tasks which need to be scheduled for a retry are still subject to weight metering and
     * agenda space, same as a regular task. If a periodic task fails, it will be scheduled
     * normally while the task is retrying.
     *
     * Tasks scheduled as a result of a retry for a periodic task are unnamed, non-periodic
     * clones of the original task. Their retry configuration will be derived from the
     * original task's configuration, but will have a lower value for `remaining` than the
     * original `total_retries`.
     */
    "set_retry": Anonymize<Iihueknplcvov>;
    /**
     * Set a retry configuration for a named task so that, in case its scheduled run fails, it
     * will be retried after `period` blocks, for a total amount of `retries` retries or until
     * it succeeds.
     *
     * Tasks which need to be scheduled for a retry are still subject to weight metering and
     * agenda space, same as a regular task. If a periodic task fails, it will be scheduled
     * normally while the task is retrying.
     *
     * Tasks scheduled as a result of a retry for a periodic task are unnamed, non-periodic
     * clones of the original task. Their retry configuration will be derived from the
     * original task's configuration, but will have a lower value for `remaining` than the
     * original `total_retries`.
     */
    "set_retry_named": Anonymize<Ifujo84eluf6dm>;
    /**
     * Removes the retry configuration of a task.
     */
    "cancel_retry": Anonymize<I1d9656ogitc3u>;
    /**
     * Cancel the retry configuration of a named task.
     */
    "cancel_retry_named": Anonymize<Ifs1i5fk9cqvr6>;
}>;
export type I8e7g876q3bfql = {
    "when": bigint;
    "maybe_periodic"?: Anonymize<I76de2jfh8ds4a>;
    "priority": number;
    "call": TxCallData;
};
export type I76de2jfh8ds4a = (Anonymize<I6cs1itejju2vv>) | undefined;
export type I9dm0i7fm6o3ac = {
    "id": FixedSizeBinary<32>;
    "when": bigint;
    "maybe_periodic"?: Anonymize<I76de2jfh8ds4a>;
    "priority": number;
    "call": TxCallData;
};
export type I8687goclso3lb = {
    "after": bigint;
    "maybe_periodic"?: Anonymize<I76de2jfh8ds4a>;
    "priority": number;
    "call": TxCallData;
};
export type Ids6rugsrrgf4d = {
    "id": FixedSizeBinary<32>;
    "after": bigint;
    "maybe_periodic"?: Anonymize<I76de2jfh8ds4a>;
    "priority": number;
    "call": TxCallData;
};
export type Iihueknplcvov = {
    "task": Anonymize<I6cs1itejju2vv>;
    "retries": number;
    "period": bigint;
};
export type Ifujo84eluf6dm = {
    "id": FixedSizeBinary<32>;
    "retries": number;
    "period": bigint;
};
export type I1d9656ogitc3u = {
    "task": Anonymize<I6cs1itejju2vv>;
};
export type Ieci88jft3cpv9 = AnonymousEnum<{
    /**
     * Pause a call.
     *
     * Can only be called by [`Config::PauseOrigin`].
     * Emits an [`Event::CallPaused`] event on success.
     */
    "pause": Anonymize<Iba7pefg0d11kh>;
    /**
     * Un-pause a call.
     *
     * Can only be called by [`Config::UnpauseOrigin`].
     * Emits an [`Event::CallUnpaused`] event on success.
     */
    "unpause": Anonymize<I2pjehun5ehh5i>;
}>;
export type I2pjehun5ehh5i = {
    "ident": Anonymize<Idkbvh6dahk1v7>;
};
export type I4ajpuk9u575ko = AnonymousEnum<{
    /**
     * ## Complexity:
     * - `O(K)` where K is length of `Keys` (heartbeat.validators_len)
     * - `O(K)`: decoding of length `K`
     */
    "heartbeat": Anonymize<I49p1tgb1igk6>;
}>;
export type I49p1tgb1igk6 = {
    "heartbeat": {
        "block_number": bigint;
        "session_index": number;
        "authority_index": number;
        "validators_len": number;
    };
    "signature": FixedSizeBinary<64>;
};
export type Id4c1d4j757ojr = AnonymousEnum<{
    /**
     * Add a registrar to the system.
     *
     * The dispatch origin for this call must be `T::RegistrarOrigin`.
     *
     * - `account`: the account of the registrar.
     *
     * Emits `RegistrarAdded` if successful.
     */
    "add_registrar": Anonymize<I73kffnn32g4c7>;
    /**
     * Set an account's identity information and reserve the appropriate deposit.
     *
     * If the account already has identity information, the deposit is taken as part payment
     * for the new deposit.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * - `info`: The identity information.
     *
     * Emits `IdentitySet` if successful.
     */
    "set_identity": Anonymize<I2kds5jji7slh8>;
    /**
     * Set the sub-accounts of the sender.
     *
     * Payment: Any aggregate balance reserved by previous `set_subs` calls will be returned
     * and an amount `SubAccountDeposit` will be reserved for each item in `subs`.
     *
     * The dispatch origin for this call must be _Signed_ and the sender must have a registered
     * identity.
     *
     * - `subs`: The identity's (new) sub-accounts.
     */
    "set_subs": Anonymize<Ia9mkdf6l44shb>;
    /**
     * Clear an account's identity info and all sub-accounts and return all deposits.
     *
     * Payment: All reserved balances on the account are returned.
     *
     * The dispatch origin for this call must be _Signed_ and the sender must have a registered
     * identity.
     *
     * Emits `IdentityCleared` if successful.
     */
    "clear_identity": undefined;
    /**
     * Request a judgement from a registrar.
     *
     * Payment: At most `max_fee` will be reserved for payment to the registrar if judgement
     * given.
     *
     * The dispatch origin for this call must be _Signed_ and the sender must have a
     * registered identity.
     *
     * - `reg_index`: The index of the registrar whose judgement is requested.
     * - `max_fee`: The maximum fee that may be paid. This should just be auto-populated as:
     *
     * ```nocompile
     * Self::registrars().get(reg_index).unwrap().fee
     * ```
     *
     * Emits `JudgementRequested` if successful.
     */
    "request_judgement": Anonymize<I9l2s4klu0831o>;
    /**
     * Cancel a previous request.
     *
     * Payment: A previously reserved deposit is returned on success.
     *
     * The dispatch origin for this call must be _Signed_ and the sender must have a
     * registered identity.
     *
     * - `reg_index`: The index of the registrar whose judgement is no longer requested.
     *
     * Emits `JudgementUnrequested` if successful.
     */
    "cancel_request": Anonymize<I2ctrt5nqb8o7c>;
    /**
     * Set the fee required for a judgement to be requested from a registrar.
     *
     * The dispatch origin for this call must be _Signed_ and the sender must be the account
     * of the registrar whose index is `index`.
     *
     * - `index`: the index of the registrar whose fee is to be set.
     * - `fee`: the new fee.
     */
    "set_fee": Anonymize<I711qahikocb1c>;
    /**
     * Change the account associated with a registrar.
     *
     * The dispatch origin for this call must be _Signed_ and the sender must be the account
     * of the registrar whose index is `index`.
     *
     * - `index`: the index of the registrar whose fee is to be set.
     * - `new`: the new account ID.
     */
    "set_account_id": Anonymize<I1u3ac7lafvv5b>;
    /**
     * Set the field information for a registrar.
     *
     * The dispatch origin for this call must be _Signed_ and the sender must be the account
     * of the registrar whose index is `index`.
     *
     * - `index`: the index of the registrar whose fee is to be set.
     * - `fields`: the fields that the registrar concerns themselves with.
     */
    "set_fields": Anonymize<Id6gojh30v9ib2>;
    /**
     * Provide a judgement for an account's identity.
     *
     * The dispatch origin for this call must be _Signed_ and the sender must be the account
     * of the registrar whose index is `reg_index`.
     *
     * - `reg_index`: the index of the registrar whose judgement is being made.
     * - `target`: the account whose identity the judgement is upon. This must be an account
     * with a registered identity.
     * - `judgement`: the judgement of the registrar of index `reg_index` about `target`.
     * - `identity`: The hash of the [`IdentityInformationProvider`] for that the judgement is
     * provided.
     *
     * Note: Judgements do not apply to a username.
     *
     * Emits `JudgementGiven` if successful.
     */
    "provide_judgement": Anonymize<I9h4cqmadpj7l0>;
    /**
     * Remove an account's identity and sub-account information and slash the deposits.
     *
     * Payment: Reserved balances from `set_subs` and `set_identity` are slashed and handled by
     * `Slash`. Verification request deposits are not returned; they should be cancelled
     * manually using `cancel_request`.
     *
     * The dispatch origin for this call must match `T::ForceOrigin`.
     *
     * - `target`: the account whose identity the judgement is upon. This must be an account
     * with a registered identity.
     *
     * Emits `IdentityKilled` if successful.
     */
    "kill_identity": Anonymize<If31vrl50nund3>;
    /**
     * Add the given account to the sender's subs.
     *
     * Payment: Balance reserved by a previous `set_subs` call for one sub will be repatriated
     * to the sender.
     *
     * The dispatch origin for this call must be _Signed_ and the sender must have a registered
     * sub identity of `sub`.
     */
    "add_sub": Anonymize<I29bkdd7n16li1>;
    /**
     * Alter the associated name of the given sub-account.
     *
     * The dispatch origin for this call must be _Signed_ and the sender must have a registered
     * sub identity of `sub`.
     */
    "rename_sub": Anonymize<I29bkdd7n16li1>;
    /**
     * Remove the given account from the sender's subs.
     *
     * Payment: Balance reserved by a previous `set_subs` call for one sub will be repatriated
     * to the sender.
     *
     * The dispatch origin for this call must be _Signed_ and the sender must have a registered
     * sub identity of `sub`.
     */
    "remove_sub": Anonymize<I9jb9hqm18runn>;
    /**
     * Remove the sender as a sub-account.
     *
     * Payment: Balance reserved by a previous `set_subs` call for one sub will be repatriated
     * to the sender (*not* the original depositor).
     *
     * The dispatch origin for this call must be _Signed_ and the sender must have a registered
     * super-identity.
     *
     * NOTE: This should not normally be used, but is provided in the case that the non-
     * controller of an account is maliciously registered as a sub-account.
     */
    "quit_sub": undefined;
    /**
     * Add an `AccountId` with permission to grant usernames with a given `suffix` appended.
     *
     * The authority can grant up to `allocation` usernames. To top up their allocation, they
     * should just issue (or request via governance) a new `add_username_authority` call.
     */
    "add_username_authority": Anonymize<I85htvo8b885h>;
    /**
     * Remove `authority` from the username authorities.
     */
    "remove_username_authority": Anonymize<I95j99om5qfj06>;
    /**
     * Set the username for `who`. Must be called by a username authority.
     *
     * The authority must have an `allocation`. Users can either pre-sign their usernames or
     * accept them later.
     *
     * Usernames must:
     * - Only contain lowercase ASCII characters or digits.
     * - When combined with the suffix of the issuing authority be _less than_ the
     * `MaxUsernameLength`.
     */
    "set_username_for": Anonymize<Ifh75tbmlqktju>;
    /**
     * Accept a given username that an `authority` granted. The call must include the full
     * username, as in `username.suffix`.
     */
    "accept_username": Anonymize<Ie5l999tf7t2te>;
    /**
     * Remove an expired username approval. The username was approved by an authority but never
     * accepted by the user and must now be beyond its expiration. The call must include the
     * full username, as in `username.suffix`.
     */
    "remove_expired_approval": Anonymize<Ie5l999tf7t2te>;
    /**
     * Set a given username as the primary. The username should include the suffix.
     */
    "set_primary_username": Anonymize<Ie5l999tf7t2te>;
    /**
     * Remove a username that corresponds to an account with no identity. Exists when a user
     * gets a username but then calls `clear_identity`.
     */
    "remove_dangling_username": Anonymize<Ie5l999tf7t2te>;
}>;
export type I73kffnn32g4c7 = {
    "account": Anonymize<I4su1fqci7afjt>;
};
export type I2kds5jji7slh8 = {
    "info": Anonymize<I1o57snqt6f4v5>;
};
export type I1o57snqt6f4v5 = {
    "additional": Array<FixedSizeArray<2, IdentityData>>;
    "display": IdentityData;
    "legal": IdentityData;
    "web": IdentityData;
    "riot": IdentityData;
    "email": IdentityData;
    "pgp_fingerprint"?: Anonymize<If7b8240vgt2q5>;
    "image": IdentityData;
    "twitter": IdentityData;
};
export type IdentityData = Enum<{
    "None": undefined;
    "Raw0": undefined;
    "Raw1": number;
    "Raw2": FixedSizeBinary<2>;
    "Raw3": FixedSizeBinary<3>;
    "Raw4": FixedSizeBinary<4>;
    "Raw5": FixedSizeBinary<5>;
    "Raw6": FixedSizeBinary<6>;
    "Raw7": FixedSizeBinary<7>;
    "Raw8": FixedSizeBinary<8>;
    "Raw9": FixedSizeBinary<9>;
    "Raw10": FixedSizeBinary<10>;
    "Raw11": FixedSizeBinary<11>;
    "Raw12": FixedSizeBinary<12>;
    "Raw13": FixedSizeBinary<13>;
    "Raw14": FixedSizeBinary<14>;
    "Raw15": FixedSizeBinary<15>;
    "Raw16": FixedSizeBinary<16>;
    "Raw17": FixedSizeBinary<17>;
    "Raw18": FixedSizeBinary<18>;
    "Raw19": FixedSizeBinary<19>;
    "Raw20": FixedSizeBinary<20>;
    "Raw21": FixedSizeBinary<21>;
    "Raw22": FixedSizeBinary<22>;
    "Raw23": FixedSizeBinary<23>;
    "Raw24": FixedSizeBinary<24>;
    "Raw25": FixedSizeBinary<25>;
    "Raw26": FixedSizeBinary<26>;
    "Raw27": FixedSizeBinary<27>;
    "Raw28": FixedSizeBinary<28>;
    "Raw29": FixedSizeBinary<29>;
    "Raw30": FixedSizeBinary<30>;
    "Raw31": FixedSizeBinary<31>;
    "Raw32": FixedSizeBinary<32>;
    "BlakeTwo256": FixedSizeBinary<32>;
    "Sha256": FixedSizeBinary<32>;
    "Keccak256": FixedSizeBinary<32>;
    "ShaThree256": FixedSizeBinary<32>;
}>;
export declare const IdentityData: GetEnum<IdentityData>;
export type Ia9mkdf6l44shb = {
    "subs": Array<Anonymize<I910puuahutflf>>;
};
export type I910puuahutflf = [SS58String, IdentityData];
export type I9l2s4klu0831o = {
    "reg_index": number;
    "max_fee": bigint;
};
export type I2ctrt5nqb8o7c = {
    "reg_index": number;
};
export type I711qahikocb1c = {
    "index": number;
    "fee": bigint;
};
export type Id6gojh30v9ib2 = {
    "index": number;
    "fields": bigint;
};
export type I9h4cqmadpj7l0 = {
    "reg_index": number;
    "target": Anonymize<I4su1fqci7afjt>;
    "judgement": IdentityJudgement;
    "identity": FixedSizeBinary<32>;
};
export type IdentityJudgement = Enum<{
    "Unknown": undefined;
    "FeePaid": bigint;
    "Reasonable": undefined;
    "KnownGood": undefined;
    "OutOfDate": undefined;
    "LowQuality": undefined;
    "Erroneous": undefined;
}>;
export declare const IdentityJudgement: GetEnum<IdentityJudgement>;
export type I29bkdd7n16li1 = {
    "sub": Anonymize<I4su1fqci7afjt>;
    "data": IdentityData;
};
export type I9jb9hqm18runn = {
    "sub": Anonymize<I4su1fqci7afjt>;
};
export type I85htvo8b885h = {
    "authority": Anonymize<I4su1fqci7afjt>;
    "suffix": Binary;
    "allocation": number;
};
export type I95j99om5qfj06 = {
    "authority": Anonymize<I4su1fqci7afjt>;
};
export type Ifh75tbmlqktju = {
    "who": Anonymize<I4su1fqci7afjt>;
    "username": Binary;
    "signature"?: Anonymize<I86cdjmsf3a81s>;
};
export type Ie5l999tf7t2te = {
    "username": Binary;
};
export type Ibmunqn0a7cftp = AnonymousEnum<{
    /**
     * Send a batch of dispatch calls.
     *
     * May be called from any origin except `None`.
     *
     * - `calls`: The calls to be dispatched from the same origin. The number of call must not
     * exceed the constant: `batched_calls_limit` (available in constant metadata).
     *
     * If origin is root then the calls are dispatched without checking origin filter. (This
     * includes bypassing `frame_system::Config::BaseCallFilter`).
     *
     * ## Complexity
     * - O(C) where C is the number of calls to be batched.
     *
     * This will return `Ok` in all circumstances. To determine the success of the batch, an
     * event is deposited. If a call failed and the batch was interrupted, then the
     * `BatchInterrupted` event is deposited, along with the number of successful calls made
     * and the error of the failed call. If all were successful, then the `BatchCompleted`
     * event is deposited.
     */
    "batch": Anonymize<I835br1ailr092>;
    /**
     * Send a call through an indexed pseudonym of the sender.
     *
     * Filter from origin are passed along. The call will be dispatched with an origin which
     * use the same filter as the origin of this call.
     *
     * NOTE: If you need to ensure that any account-based filtering is not honored (i.e.
     * because you expect `proxy` to have been used prior in the call stack and you do not want
     * the call restrictions to apply to any sub-accounts), then use `as_multi_threshold_1`
     * in the Multisig pallet instead.
     *
     * NOTE: Prior to version *12, this was called `as_limited_sub`.
     *
     * The dispatch origin for this call must be _Signed_.
     */
    "as_derivative": Anonymize<I4nknuetu70u1a>;
    /**
     * Send a batch of dispatch calls and atomically execute them.
     * The whole transaction will rollback and fail if any of the calls failed.
     *
     * May be called from any origin except `None`.
     *
     * - `calls`: The calls to be dispatched from the same origin. The number of call must not
     * exceed the constant: `batched_calls_limit` (available in constant metadata).
     *
     * If origin is root then the calls are dispatched without checking origin filter. (This
     * includes bypassing `frame_system::Config::BaseCallFilter`).
     *
     * ## Complexity
     * - O(C) where C is the number of calls to be batched.
     */
    "batch_all": Anonymize<I835br1ailr092>;
    /**
     * Dispatches a function call with a provided origin.
     *
     * The dispatch origin for this call must be _Root_.
     *
     * ## Complexity
     * - O(1).
     */
    "dispatch_as": Anonymize<Idk4dmbj6bivjh>;
    /**
     * Send a batch of dispatch calls.
     * Unlike `batch`, it allows errors and won't interrupt.
     *
     * May be called from any origin except `None`.
     *
     * - `calls`: The calls to be dispatched from the same origin. The number of call must not
     * exceed the constant: `batched_calls_limit` (available in constant metadata).
     *
     * If origin is root then the calls are dispatch without checking origin filter. (This
     * includes bypassing `frame_system::Config::BaseCallFilter`).
     *
     * ## Complexity
     * - O(C) where C is the number of calls to be batched.
     */
    "force_batch": Anonymize<I835br1ailr092>;
    /**
     * Dispatch a function call with a specified weight.
     *
     * This function does not check the weight of the call, and instead allows the
     * Root origin to specify the weight of the call.
     *
     * The dispatch origin for this call must be _Root_.
     */
    "with_weight": Anonymize<I46s97719jsq03>;
}>;
export type I835br1ailr092 = {
    "calls": Array<TxCallData>;
};
export type I4nknuetu70u1a = {
    "index": number;
    "call": TxCallData;
};
export type Idk4dmbj6bivjh = {
    "as_origin": Anonymize<I3l2bgvo0holot>;
    "call": TxCallData;
};
export type I3l2bgvo0holot = AnonymousEnum<{
    "system": DispatchRawOrigin;
    "Council": Enum<{
        "Members": Anonymize<I9jd27rnpm8ttv>;
        "Member": SS58String;
        "_Phantom": undefined;
    }>;
    "Ethereum": Anonymize<I9hp9au9bfqil7>;
}>;
export type DispatchRawOrigin = Enum<{
    "Root": undefined;
    "Signed": SS58String;
    "None": undefined;
}>;
export declare const DispatchRawOrigin: GetEnum<DispatchRawOrigin>;
export type I9otac0gkq8htr = AnonymousEnum<{
    /**
     * Immediately dispatch a multi-signature call using a single approval from the caller.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * - `other_signatories`: The accounts (other than the sender) who are part of the
     * multi-signature, but do not participate in the approval process.
     * - `call`: The call to be executed.
     *
     * Result is equivalent to the dispatched result.
     *
     * ## Complexity
     * O(Z + C) where Z is the length of the call and C its execution weight.
     */
    "as_multi_threshold_1": Anonymize<I4fhhc9mub7uo8>;
    /**
     * Register approval for a dispatch to be made from a deterministic composite account if
     * approved by a total of `threshold - 1` of `other_signatories`.
     *
     * If there are enough, then dispatch the call.
     *
     * Payment: `DepositBase` will be reserved if this is the first approval, plus
     * `threshold` times `DepositFactor`. It is returned once this dispatch happens or
     * is cancelled.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * - `threshold`: The total number of approvals for this dispatch before it is executed.
     * - `other_signatories`: The accounts (other than the sender) who can approve this
     * dispatch. May not be empty.
     * - `maybe_timepoint`: If this is the first approval, then this must be `None`. If it is
     * not the first approval, then it must be `Some`, with the timepoint (block number and
     * transaction index) of the first approval transaction.
     * - `call`: The call to be executed.
     *
     * NOTE: Unless this is the final approval, you will generally want to use
     * `approve_as_multi` instead, since it only requires a hash of the call.
     *
     * Result is equivalent to the dispatched result if `threshold` is exactly `1`. Otherwise
     * on success, result is `Ok` and the result from the interior call, if it was executed,
     * may be found in the deposited `MultisigExecuted` event.
     *
     * ## Complexity
     * - `O(S + Z + Call)`.
     * - Up to one balance-reserve or unreserve operation.
     * - One passthrough operation, one insert, both `O(S)` where `S` is the number of
     * signatories. `S` is capped by `MaxSignatories`, with weight being proportional.
     * - One call encode & hash, both of complexity `O(Z)` where `Z` is tx-len.
     * - One encode & hash, both of complexity `O(S)`.
     * - Up to one binary search and insert (`O(logS + S)`).
     * - I/O: 1 read `O(S)`, up to 1 mutate `O(S)`. Up to one remove.
     * - One event.
     * - The weight of the `call`.
     * - Storage: inserts one item, value size bounded by `MaxSignatories`, with a deposit
     * taken for its lifetime of `DepositBase + threshold * DepositFactor`.
     */
    "as_multi": Anonymize<Ijlbhl3lcdb3d>;
    /**
     * Register approval for a dispatch to be made from a deterministic composite account if
     * approved by a total of `threshold - 1` of `other_signatories`.
     *
     * Payment: `DepositBase` will be reserved if this is the first approval, plus
     * `threshold` times `DepositFactor`. It is returned once this dispatch happens or
     * is cancelled.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * - `threshold`: The total number of approvals for this dispatch before it is executed.
     * - `other_signatories`: The accounts (other than the sender) who can approve this
     * dispatch. May not be empty.
     * - `maybe_timepoint`: If this is the first approval, then this must be `None`. If it is
     * not the first approval, then it must be `Some`, with the timepoint (block number and
     * transaction index) of the first approval transaction.
     * - `call_hash`: The hash of the call to be executed.
     *
     * NOTE: If this is the final approval, you will want to use `as_multi` instead.
     *
     * ## Complexity
     * - `O(S)`.
     * - Up to one balance-reserve or unreserve operation.
     * - One passthrough operation, one insert, both `O(S)` where `S` is the number of
     * signatories. `S` is capped by `MaxSignatories`, with weight being proportional.
     * - One encode & hash, both of complexity `O(S)`.
     * - Up to one binary search and insert (`O(logS + S)`).
     * - I/O: 1 read `O(S)`, up to 1 mutate `O(S)`. Up to one remove.
     * - One event.
     * - Storage: inserts one item, value size bounded by `MaxSignatories`, with a deposit
     * taken for its lifetime of `DepositBase + threshold * DepositFactor`.
     */
    "approve_as_multi": Anonymize<I44imsiesapsp9>;
    /**
     * Cancel a pre-existing, on-going multisig transaction. Any deposit reserved previously
     * for this operation will be unreserved on success.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * - `threshold`: The total number of approvals for this dispatch before it is executed.
     * - `other_signatories`: The accounts (other than the sender) who can approve this
     * dispatch. May not be empty.
     * - `timepoint`: The timepoint (block number and transaction index) of the first approval
     * transaction for this dispatch.
     * - `call_hash`: The hash of the call to be executed.
     *
     * ## Complexity
     * - `O(S)`.
     * - Up to one balance-reserve or unreserve operation.
     * - One passthrough operation, one insert, both `O(S)` where `S` is the number of
     * signatories. `S` is capped by `MaxSignatories`, with weight being proportional.
     * - One encode & hash, both of complexity `O(S)`.
     * - One event.
     * - I/O: 1 read `O(S)`, one remove.
     * - Storage: removes one item.
     */
    "cancel_as_multi": Anonymize<Icr6ao0t0ec3r6>;
}>;
export type I4fhhc9mub7uo8 = {
    "other_signatories": Anonymize<Ia2lhg7l2hilo3>;
    "call": TxCallData;
};
export type Ijlbhl3lcdb3d = {
    "threshold": number;
    "other_signatories": Anonymize<Ia2lhg7l2hilo3>;
    "maybe_timepoint"?: Anonymize<I6grb980qgjf06>;
    "call": TxCallData;
    "max_weight": Anonymize<I4q39t5hn830vp>;
};
export type I6grb980qgjf06 = (Anonymize<I83nkmvi3lsg6r>) | undefined;
export type I44imsiesapsp9 = {
    "threshold": number;
    "other_signatories": Anonymize<Ia2lhg7l2hilo3>;
    "maybe_timepoint"?: Anonymize<I6grb980qgjf06>;
    "call_hash": FixedSizeBinary<32>;
    "max_weight": Anonymize<I4q39t5hn830vp>;
};
export type Icr6ao0t0ec3r6 = {
    "threshold": number;
    "other_signatories": Anonymize<Ia2lhg7l2hilo3>;
    "timepoint": Anonymize<I83nkmvi3lsg6r>;
    "call_hash": FixedSizeBinary<32>;
};
export type Icu3fce0sripq4 = AnonymousEnum<{
    /**
     * Transact an Ethereum transaction.
     */
    "transact": Anonymize<Ia8ogbeici6lip>;
}>;
export type Ia8ogbeici6lip = {
    "transaction": Anonymize<I6fr2mqud652ga>;
};
export type I6fr2mqud652ga = AnonymousEnum<{
    "Legacy": Anonymize<I22u79j4u5as1p>;
    "EIP2930": {
        "chain_id": bigint;
        "nonce": Anonymize<I4totqt881mlti>;
        "gas_price": Anonymize<I4totqt881mlti>;
        "gas_limit": Anonymize<I4totqt881mlti>;
        "action": Anonymize<I2do93a3gr3ege>;
        "value": Anonymize<I4totqt881mlti>;
        "input": Binary;
        "access_list": Anonymize<Ieap15h2pjii9u>;
        "odd_y_parity": boolean;
        "r": FixedSizeBinary<32>;
        "s": FixedSizeBinary<32>;
    };
    "EIP1559": {
        "chain_id": bigint;
        "nonce": Anonymize<I4totqt881mlti>;
        "max_priority_fee_per_gas": Anonymize<I4totqt881mlti>;
        "max_fee_per_gas": Anonymize<I4totqt881mlti>;
        "gas_limit": Anonymize<I4totqt881mlti>;
        "action": Anonymize<I2do93a3gr3ege>;
        "value": Anonymize<I4totqt881mlti>;
        "input": Binary;
        "access_list": Anonymize<Ieap15h2pjii9u>;
        "odd_y_parity": boolean;
        "r": FixedSizeBinary<32>;
        "s": FixedSizeBinary<32>;
    };
}>;
export type I816pc1os2b38d = AnonymousEnum<{
    /**
     * Withdraw balance from EVM into currency/balances pallet.
     */
    "withdraw": Anonymize<Idcabvplu05lea>;
    /**
     * Issue an EVM call operation. This is similar to a message call transaction in Ethereum.
     */
    "call": Anonymize<I2ncccle6pmhd9>;
    /**
     * Issue an EVM create operation. This is similar to a contract creation transaction in
     * Ethereum.
     */
    "create": Anonymize<I92bnd3pe0civj>;
    /**
     * Issue an EVM create2 operation.
     */
    "create2": Anonymize<Ic84i538n8bl8j>;
    "set_whitelist": Anonymize<I837c61fc07ine>;
}>;
export type I2ncccle6pmhd9 = {
    "source": FixedSizeBinary<20>;
    "target": FixedSizeBinary<20>;
    "input": Binary;
    "value": Anonymize<I4totqt881mlti>;
    "gas_limit": bigint;
    "max_fee_per_gas": Anonymize<I4totqt881mlti>;
    "max_priority_fee_per_gas"?: Anonymize<Ic4rgfgksgmm3e>;
    "nonce"?: Anonymize<Ic4rgfgksgmm3e>;
    "access_list": Anonymize<I1bsfec060j604>;
};
export type I92bnd3pe0civj = {
    "source": FixedSizeBinary<20>;
    "init": Binary;
    "value": Anonymize<I4totqt881mlti>;
    "gas_limit": bigint;
    "max_fee_per_gas": Anonymize<I4totqt881mlti>;
    "max_priority_fee_per_gas"?: Anonymize<Ic4rgfgksgmm3e>;
    "nonce"?: Anonymize<Ic4rgfgksgmm3e>;
    "access_list": Anonymize<I1bsfec060j604>;
};
export type Ic84i538n8bl8j = {
    "source": FixedSizeBinary<20>;
    "init": Binary;
    "salt": FixedSizeBinary<32>;
    "value": Anonymize<I4totqt881mlti>;
    "gas_limit": bigint;
    "max_fee_per_gas": Anonymize<I4totqt881mlti>;
    "max_priority_fee_per_gas"?: Anonymize<Ic4rgfgksgmm3e>;
    "nonce"?: Anonymize<Ic4rgfgksgmm3e>;
    "access_list": Anonymize<I1bsfec060j604>;
};
export type Ie18f12l062q2m = AnonymousEnum<{
    "note_min_gas_price_target": Anonymize<I6v8kghkt0dksl>;
}>;
export type I6v8kghkt0dksl = {
    "target": Anonymize<I4totqt881mlti>;
};
export type Ibt56711n0s799 = AnonymousEnum<{
    /**
     * Increment `sufficients` for existing accounts having a nonzero `nonce` but zero `sufficients`, `consumers` and `providers` value.
     * This state was caused by a previous bug in EVM create account dispatchable.
     *
     * Any accounts in the input list not satisfying the above condition will remain unaffected.
     */
    "hotfix_inc_account_sufficients": Anonymize<Ialjbutpk9fktt>;
}>;
export type Ialjbutpk9fktt = {
    "addresses": Anonymize<I4gqmlq9k6jlk3>;
};
export type I52uc2hlov119i = AnonymousEnum<{
    /**
     * Dispatch the given `call` from an account that the sender is authorised for through
     * `add_proxy`.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `real`: The account that the proxy will make a call on behalf of.
     * - `force_proxy_type`: Specify the exact proxy type to be used and checked for this call.
     * - `call`: The call to be made by the `real` account.
     */
    "proxy": Anonymize<I6857skgbjgbj4>;
    /**
     * Register a proxy account for the sender that is able to make calls on its behalf.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `proxy`: The account that the `caller` would like to make a proxy.
     * - `proxy_type`: The permissions allowed for this proxy account.
     * - `delay`: The announcement period required of the initial proxy. Will generally be
     * zero.
     */
    "add_proxy": Anonymize<Ia2th0jtu8gpfn>;
    /**
     * Unregister a proxy account for the sender.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `proxy`: The account that the `caller` would like to remove as a proxy.
     * - `proxy_type`: The permissions currently enabled for the removed proxy account.
     */
    "remove_proxy": Anonymize<Ia2th0jtu8gpfn>;
    /**
     * Unregister all proxy accounts for the sender.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * WARNING: This may be called on accounts created by `pure`, however if done, then
     * the unreserved fees will be inaccessible. **All access to this account will be lost.**
     */
    "remove_proxies": undefined;
    /**
     * Spawn a fresh new account that is guaranteed to be otherwise inaccessible, and
     * initialize it with a proxy of `proxy_type` for `origin` sender.
     *
     * Requires a `Signed` origin.
     *
     * - `proxy_type`: The type of the proxy that the sender will be registered as over the
     * new account. This will almost always be the most permissive `ProxyType` possible to
     * allow for maximum flexibility.
     * - `index`: A disambiguation index, in case this is called multiple times in the same
     * transaction (e.g. with `utility::batch`). Unless you're using `batch` you probably just
     * want to use `0`.
     * - `delay`: The announcement period required of the initial proxy. Will generally be
     * zero.
     *
     * Fails with `Duplicate` if this has already been called in this transaction, from the
     * same sender, with the same parameters.
     *
     * Fails if there are insufficient funds to pay for deposit.
     */
    "create_pure": Anonymize<I4fjuo0cog477g>;
    /**
     * Removes a previously spawned pure proxy.
     *
     * WARNING: **All access to this account will be lost.** Any funds held in it will be
     * inaccessible.
     *
     * Requires a `Signed` origin, and the sender account must have been created by a call to
     * `pure` with corresponding parameters.
     *
     * - `spawner`: The account that originally called `pure` to create this account.
     * - `index`: The disambiguation index originally passed to `pure`. Probably `0`.
     * - `proxy_type`: The proxy type originally passed to `pure`.
     * - `height`: The height of the chain when the call to `pure` was processed.
     * - `ext_index`: The extrinsic index in which the call to `pure` was processed.
     *
     * Fails with `NoPermission` in case the caller is not a previously created pure
     * account whose `pure` call has corresponding parameters.
     */
    "kill_pure": Anonymize<I623bfqj2uih54>;
    /**
     * Publish the hash of a proxy-call that will be made in the future.
     *
     * This must be called some number of blocks before the corresponding `proxy` is attempted
     * if the delay associated with the proxy relationship is greater than zero.
     *
     * No more than `MaxPending` announcements may be made at any one time.
     *
     * This will take a deposit of `AnnouncementDepositFactor` as well as
     * `AnnouncementDepositBase` if there are no other pending announcements.
     *
     * The dispatch origin for this call must be _Signed_ and a proxy of `real`.
     *
     * Parameters:
     * - `real`: The account that the proxy will make a call on behalf of.
     * - `call_hash`: The hash of the call to be made by the `real` account.
     */
    "announce": Anonymize<Idj9faf6hgsdur>;
    /**
     * Remove a given announcement.
     *
     * May be called by a proxy account to remove a call they previously announced and return
     * the deposit.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `real`: The account that the proxy will make a call on behalf of.
     * - `call_hash`: The hash of the call to be made by the `real` account.
     */
    "remove_announcement": Anonymize<Idj9faf6hgsdur>;
    /**
     * Remove the given announcement of a delegate.
     *
     * May be called by a target (proxied) account to remove a call that one of their delegates
     * (`delegate`) has announced they want to execute. The deposit is returned.
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `delegate`: The account that previously announced the call.
     * - `call_hash`: The hash of the call to be made.
     */
    "reject_announcement": Anonymize<I8mj1nm903hpts>;
    /**
     * Dispatch the given `call` from an account that the sender is authorized for through
     * `add_proxy`.
     *
     * Removes any corresponding announcement(s).
     *
     * The dispatch origin for this call must be _Signed_.
     *
     * Parameters:
     * - `real`: The account that the proxy will make a call on behalf of.
     * - `force_proxy_type`: Specify the exact proxy type to be used and checked for this call.
     * - `call`: The call to be made by the `real` account.
     */
    "proxy_announced": Anonymize<I7an0d6j0oge8o>;
}>;
export type I6857skgbjgbj4 = {
    "real": Anonymize<I4su1fqci7afjt>;
    "force_proxy_type"?: Anonymize<I9l9m7ojsal0uo>;
    "call": TxCallData;
};
export type I9l9m7ojsal0uo = (Anonymize<I1bpip5bh5877p>) | undefined;
export type Ia2th0jtu8gpfn = {
    "delegate": Anonymize<I4su1fqci7afjt>;
    "proxy_type": Anonymize<I1bpip5bh5877p>;
    "delay": bigint;
};
export type I4fjuo0cog477g = {
    "proxy_type": Anonymize<I1bpip5bh5877p>;
    "delay": bigint;
    "index": number;
};
export type I623bfqj2uih54 = {
    "spawner": Anonymize<I4su1fqci7afjt>;
    "proxy_type": Anonymize<I1bpip5bh5877p>;
    "index": number;
    "height": bigint;
    "ext_index": number;
};
export type Idj9faf6hgsdur = {
    "real": Anonymize<I4su1fqci7afjt>;
    "call_hash": FixedSizeBinary<32>;
};
export type I8mj1nm903hpts = {
    "delegate": Anonymize<I4su1fqci7afjt>;
    "call_hash": FixedSizeBinary<32>;
};
export type I7an0d6j0oge8o = {
    "delegate": Anonymize<I4su1fqci7afjt>;
    "real": Anonymize<I4su1fqci7afjt>;
    "force_proxy_type"?: Anonymize<I9l9m7ojsal0uo>;
    "call": TxCallData;
};
export type I25up9680hc62l = AnonymousEnum<{
    "force_register_coldkey_node": Anonymize<Ie08tvgm9uje9n>;
    "register_node_with_coldkey": Anonymize<I39b902684r57b>;
    "set_node_status_to_degraded": Anonymize<I6ah8cnfnbkuqo>;
    /**
     * Sudo function to enable or disable fee charging
     */
    "set_fee_charging": Anonymize<I94dejtmu6d72i>;
    /**
     * Sudo function to update the fee for a specific node type
     */
    "set_node_type_fee": Anonymize<I2oet9jl0tboi4>;
    "set_node_type_disabled": Anonymize<Icimuh915fen06>;
    "force_unregister_hotkey_node": Anonymize<I6ah8cnfnbkuqo>;
    "force_unregister_coldkey_node": Anonymize<I6ah8cnfnbkuqo>;
    "unregister_node": Anonymize<I6ah8cnfnbkuqo>;
    "unregister_main_node": Anonymize<I6ah8cnfnbkuqo>;
    "swap_node_owner": Anonymize<Itdoblp90lfe2>;
    /**
     * Sudo call to unregister all nodes with is_verified = false
     * This will iterate through all registered nodes and unregister those that are not verified
     */
    "sudo_unregister_unverified_nodes": undefined;
    "submit_deregistration_report": Anonymize<If9sojp49tb7bn>;
    /**
     * Ban or unban an account from registering nodes
     */
    "set_account_ban_status": Anonymize<I2i9ihlf6tlsua>;
    /**
     * Set the list of whitelisted validators
     *
     * Can only be called by root.
     */
    "set_whitelisted_validators": Anonymize<I97hfovkaaqb7h>;
    "verify_existing_node": Anonymize<Ibqlvl2pb9t94e>;
    "verify_existing_coldkey_node": Anonymize<Ibqlvl2pb9t94e>;
    /**
     * Toggle the de-registration switch (root only)
     */
    "set_deregistration_enabled": Anonymize<I94dejtmu6d72i>;
}>;
export type Ie08tvgm9uje9n = {
    "owner": SS58String;
    "node_type": Anonymize<I9ea6lu6bbueo9>;
    "node_id": Binary;
    "ipfs_node_id"?: Anonymize<Iabpgqcjikia83>;
};
export type I39b902684r57b = {
    "node_type": Anonymize<I9ea6lu6bbueo9>;
    "node_id": Binary;
    "pay_in_credits": boolean;
    "ipfs_node_id"?: Anonymize<Iabpgqcjikia83>;
    "owner": SS58String;
    "ipfs_peer_id": Binary;
    "main_key_type": Anonymize<Iek834g6cg3jc8>;
    "main_public_key": Binary;
    "main_sig": Binary;
    "ipfs_key_type": Anonymize<Iek834g6cg3jc8>;
    "ipfs_public_key": Binary;
    "ipfs_sig": Binary;
    "challenge_bytes": Binary;
    "ipfs_id_hex": Binary;
    "node_id_hex": Binary;
};
export type Iek834g6cg3jc8 = AnonymousEnum<{
    "Ed25519": undefined;
}>;
export type If9sojp49tb7bn = {
    "node_ids": Anonymize<Itom7fk49o0c9>;
};
export type I97hfovkaaqb7h = {
    "validators": Anonymize<Ia2lhg7l2hilo3>;
};
export type Ibqlvl2pb9t94e = {
    "node_id": Binary;
    "challenge_bytes": Binary;
    "main_key_type": Anonymize<Iek834g6cg3jc8>;
    "main_public_key": Binary;
    "main_sig": Binary;
    "ipfs_key_type": Anonymize<Iek834g6cg3jc8>;
    "ipfs_public_key": Binary;
    "ipfs_sig": Binary;
    "ipfs_id_hex": Binary;
    "node_id_hex": Binary;
};
export type I38f3g1rtihufr = AnonymousEnum<{
    "add_hardware_info": Anonymize<I6367gk7n5srvv>;
    "metrics_data_update": Anonymize<I51q1ab7s5ros5>;
    "update_pin_check_metrics": Anonymize<Icns9uu67sm2c>;
    /**
     * Sudo function to enable purging of deregistered nodes
     */
    "sudo_enable_purge_deregistered_nodes": undefined;
    /**
     * Sudo function to disable purging of deregistered nodes
     */
    "sudo_disable_purge_deregistered_nodes": undefined;
}>;
export type I6367gk7n5srvv = {
    "node_id": Binary;
    "system_info": {
        "memory_mb": bigint;
        "free_memory_mb": bigint;
        "storage_total_mb": bigint;
        "storage_free_mb": bigint;
        "network_bandwidth_mb_s": number;
        "primary_network_interface"?: Anonymize<I710lggphn7ltb>;
        "disks": Anonymize<Ibfh8cru772kj5>;
        "ipfs_repo_size": bigint;
        "ipfs_storage_max": bigint;
        "cpu_model": Binary;
        "cpu_cores": number;
        "is_sev_enabled": boolean;
        "zfs_info": Anonymize<Itom7fk49o0c9>;
        "ipfs_zfs_pool_size": bigint;
        "ipfs_zfs_pool_alloc": bigint;
        "ipfs_zfs_pool_free": bigint;
        "raid_info": Anonymize<Itom7fk49o0c9>;
        "vm_count": number;
        "gpu_name"?: Anonymize<Iabpgqcjikia83>;
        "gpu_memory_mb"?: Anonymize<I4arjljr6dpflb>;
        "hypervisor_disk_type"?: Anonymize<Iabpgqcjikia83>;
        "vm_pool_disk_type"?: Anonymize<Iabpgqcjikia83>;
        "disk_info": Anonymize<Icmbpj606ekbcn>;
    };
};
export type I710lggphn7ltb = ({
    "name": Binary;
    "mac_address"?: Anonymize<Iabpgqcjikia83>;
    "uplink_mb": bigint;
    "downlink_mb": bigint;
    "network_details"?: ({
        "network_type": Anonymize<Ic972a5rdneln1>;
        "city"?: Anonymize<Iabpgqcjikia83>;
        "region"?: Anonymize<Iabpgqcjikia83>;
        "country"?: Anonymize<Iabpgqcjikia83>;
        "loc"?: Anonymize<Iabpgqcjikia83>;
    }) | undefined;
}) | undefined;
export type Ic972a5rdneln1 = AnonymousEnum<{
    "Private": undefined;
    "Public": undefined;
}>;
export type Ibfh8cru772kj5 = Array<{
    "name": Binary;
    "disk_type": Binary;
    "total_space_mb": bigint;
    "free_space_mb": bigint;
}>;
export type Icmbpj606ekbcn = Array<{
    "name": Binary;
    "serial": Binary;
    "model": Binary;
    "size": Binary;
    "is_rotational": boolean;
    "disk_type": Binary;
}>;
export type I51q1ab7s5ros5 = {
    "node_id": Binary;
    "storage_proof_time_ms": number;
    "latency_ms": number;
    "peer_count": number;
    "failed_challenges_count": number;
    "successful_challenges": number;
    "total_challenges": number;
    "uptime_minutes": number;
    "total_minutes": number;
    "consecutive_reliable_days": number;
    "recent_downtime_hours": number;
    "block_number": number;
};
export type Icns9uu67sm2c = {
    "miners_metrics": Array<Anonymize<I69kk348jhe683>>;
};
export type I69kk348jhe683 = {
    "node_id": Binary;
    "total_pin_checks": number;
    "successful_pin_checks": number;
};
export type Iege5uhb98da5f = AnonymousEnum<{
    "submit_hot_keys_info": Anonymize<Ie3u49lcd7idld>;
    "set_stored_dividends": Anonymize<Idjafbm59g1uqh>;
    /**
     * Sudo function to add a whitelisted validator
     */
    "sudo_add_whitelisted_validator": Anonymize<I9acqruh7322g2>;
    /**
     * Sudo function to remove a whitelisted validator
     */
    "sudo_remove_whitelisted_validator": Anonymize<I9acqruh7322g2>;
}>;
export type Ie3u49lcd7idld = {
    "hot_keys": Anonymize<Ifl5oat0rhcq32>;
    "dividends": Anonymize<Icgljjb6j82uhn>;
};
export type Ifl5oat0rhcq32 = Array<{
    "address": FixedSizeBinary<32>;
    "id": number;
    "role": Enum<{
        "Validator": undefined;
        "Miner": undefined;
        "None": undefined;
    }>;
    "substrate_address": SS58String;
}>;
export type Idjafbm59g1uqh = {
    "dividends": Anonymize<Icgljjb6j82uhn>;
};
export type If40ds04ce1tf = AnonymousEnum<{
    /**
     * Set the `is_suspended` field for a specific package.
     */
    "set_package_suspension": Anonymize<I8o0n1n0sdpujr>;
    "storage_request": Anonymize<Ibftam0unl1fsq>;
    "storage_unpin_request": Anonymize<I7ckaemrn32ju>;
    /**
     * Sudo function to add a new plan.
     */
    "add_new_plan": Anonymize<If5mnb2sshko5d>;
    /**
     * Purchase one or more plans using points
     */
    "purchase_plan": Anonymize<I8den9qn740oa7>;
    /**
     * Sudo function to set the price per GB for storage
     */
    "set_price_per_gb": Anonymize<I6h5nf3idmn898>;
    /**
     * Sudo function to set the price per GB for storage
     */
    "set_bandwidth_price": Anonymize<I6h5nf3idmn898>;
    "set_os_disk_image_url": Anonymize<Ifoap83itjns41>;
    /**
     * Set the specific miner request fee
     */
    "set_specific_miner_request_fee": Anonymize<Ib1ilbm5ipoh62>;
    "deposit": Anonymize<I66r1tu4acmi8i>;
    "chargeback": Anonymize<I8fe3c4k4rohtd>;
    "set_sudo_key": Anonymize<I5pjaoviin0m2>;
    "sudo_set_storage_operations": Anonymize<I94dejtmu6d72i>;
    /**
     * Enable or disable purchase plan functionality
     *
     * Can only be called by sudo
     */
    "sudo_set_purchase_plan": Anonymize<I94dejtmu6d72i>;
    /**
     * User cancels their own subscription
     */
    "cancel_my_subscription": undefined;
}>;
export type I8o0n1n0sdpujr = {
    "plan_id": FixedSizeBinary<32>;
    "is_suspended": boolean;
};
export type Ibftam0unl1fsq = {
    "files_input": Anonymize<Ibefmjheg1a3em>;
    "miner_ids"?: Anonymize<Icfm6esve5sckl>;
    "owner": SS58String;
};
export type Icfm6esve5sckl = (Anonymize<Itom7fk49o0c9>) | undefined;
export type If5mnb2sshko5d = {
    "plan_name": Binary;
    "plan_description": Binary;
    "plan_technical_description": Binary;
    "price": bigint;
    "is_storage_plan": boolean;
    "storage_limit"?: Anonymize<I35p85j063s0il>;
};
export type I8den9qn740oa7 = {
    "plan_ids": Anonymize<Ic5m5lp1oioo8r>;
    "location_ids"?: (Array<Anonymize<I4arjljr6dpflb>>) | undefined;
    "selected_image_names": Anonymize<I9g0nnf4sgmki0>;
    "cloud_init_cids"?: (Anonymize<I9g0nnf4sgmki0>) | undefined;
    "pay_for"?: Anonymize<Ihfphjolmsqq1>;
    "miner_ids"?: (Anonymize<I9g0nnf4sgmki0>) | undefined;
};
export type I9g0nnf4sgmki0 = Array<Anonymize<Iabpgqcjikia83>>;
export type Ifoap83itjns41 = {
    "os_name": Binary;
    "url": Binary;
    "name": Binary;
    "description": Binary;
};
export type I66r1tu4acmi8i = {
    "account": SS58String;
    "credit_amount": bigint;
    "alpha_amount": bigint;
    "freeze_for_chargeback": boolean;
    "code"?: Anonymize<Iabpgqcjikia83>;
};
export type I8fe3c4k4rohtd = {
    "batch_id": bigint;
};
export type I5pjaoviin0m2 = {
    "new_sudo_key": SS58String;
};
export type Ie1s8d7rc54d79 = AnonymousEnum<{
    /**
     * The origin can add a sub account for the given main account.
     *
     * The origin must be Signed and the sender should have access to 'main'
     *
     * Parameters:
     * - `main`: The address that has a profile associated
     * - `new_sub_account`: The address that will be added as a connected account of 'main'
     *
     * Emits `SubAccountAdded` event when successful.
     *
     * Weight: `O(1)` TODO: Add correct weight
     */
    "add_sub_account": Anonymize<Ifdpca19a4andf>;
    /**
     * The origin can remove a sub account for the given main account.
     *
     * The origin must be Signed and the sender should have access to 'main'
     *
     * Can't remove all the connected accounts for a profile
     *
     * Parameters:
     * - `main`: The address that has a profile associated
     * - `sub_account_to_remove`: The address that will be removed as a connected account of
     * 'main'
     *
     * Emits `SubAccountRemoved` event when successful.
     *
     * Weight: `O(1)` TODO: Add correct weight
     */
    "remove_sub_account": Anonymize<I1jjo47oaa4a7e>;
    /**
     * Update the role of a sub-account
     *
     * The origin must be Signed and the sender should have access to 'main'
     *
     * Parameters:
     * - `main`: The main account that owns the sub-account
     * - `sub_account`: The sub-account to update
     * - `new_role`: The new role to assign
     *
     * Emits `SubAccountRoleUpdated` event when successful.
     */
    "update_sub_account_role": Anonymize<Ieijed8jf38v2>;
}>;
export type Ifdpca19a4andf = {
    "main": SS58String;
    "new_sub_account": SS58String;
    "role": Anonymize<I15h251r958qnn>;
};
export type I1jjo47oaa4a7e = {
    "main": SS58String;
    "sub_account_to_remove": SS58String;
};
export type Ieijed8jf38v2 = {
    "main": SS58String;
    "sub_account": SS58String;
    "new_role": Anonymize<I15h251r958qnn>;
};
export type Ia2v9fnslducq5 = AnonymousEnum<{
    /**
     * Send a notification
     */
    "send_notification": Anonymize<I3ldmjfqravo2c>;
    /**
     * Mark a notification as read
     */
    "mark_as_read": Anonymize<I666bl2fqjkejo>;
    /**
     * Update an existing notification (Sudo only)
     */
    "sudo_update_notification": Anonymize<I89s5nqb1ge1ue>;
    "ban_account": Anonymize<Icbccs0ug47ilf>;
}>;
export type I3ldmjfqravo2c = {
    "recipient": SS58String;
    "block_to_send": bigint;
    "recurrence": boolean;
    "starting_recurrence"?: Anonymize<I35p85j063s0il>;
    "frequency"?: Anonymize<I35p85j063s0il>;
};
export type I89s5nqb1ge1ue = {
    "recipient": SS58String;
    "index": number;
    "new_block_to_send": bigint;
    "new_recurrence": boolean;
    "new_starting_recurrence"?: Anonymize<I35p85j063s0il>;
    "new_frequency"?: Anonymize<I35p85j063s0il>;
};
export type I6vn20en55t8sa = AnonymousEnum<{
    /**
     * Set a hex-encoded string in the public storage
     */
    "set_public_item": Anonymize<I6ep07oaf1eoa2>;
    /**
     * Set a hex-encoded string in the private storage
     */
    "set_private_item": Anonymize<I6ep07oaf1eoa2>;
    /**
     * Set a unique username for the user
     */
    "set_username": Anonymize<Ie5l999tf7t2te>;
    /**
     * Set the Data Public Key for an account
     */
    "set_data_public_key": Anonymize<I9pf8ji3tn7abh>;
    /**
     * Set the Message Public Key for an account
     */
    "set_message_public_key": Anonymize<I9pf8ji3tn7abh>;
}>;
export type I6ep07oaf1eoa2 = {
    "item": Binary;
};
export type I9pf8ji3tn7abh = {
    "key": Binary;
};
export type Ifssa3g4o3ro7r = AnonymousEnum<{
    "set_metagraph_submission_enabled": Anonymize<I94dejtmu6d72i>;
    "set_weight_submission_enabled": Anonymize<I94dejtmu6d72i>;
}>;
export type If18kioql47l8j = AnonymousEnum<{
    "update_rank_distribution_limit": Anonymize<I1il5mj68vvsms>;
    "update_rankings": Anonymize<Ifqtvku7shnlle>;
}>;
export type Ifqtvku7shnlle = {
    "weights": Anonymize<Icgljjb6j82uhn>;
    "all_nodes_ss58": Anonymize<Itom7fk49o0c9>;
    "node_ids": Anonymize<Itom7fk49o0c9>;
    "node_types": Array<Anonymize<I9ea6lu6bbueo9>>;
};
export type Idfi3eu3jc3icv = AnonymousEnum<{
    /**
     * Add a new authority account (only callable by sudo)
     */
    "add_authority": Anonymize<I2rg5btjrsqec0>;
    /**
     * Remove an authority account (only callable by sudo)
     */
    "remove_authority": Anonymize<I2rg5btjrsqec0>;
    /**
     * Burn credits (only callable by authority accounts)
     */
    "burn": Anonymize<Id5fm4p8lj5qgi>;
    "increase_user_balance": Anonymize<I17do9d5rlq72d>;
    "create_referral_code": undefined;
    "change_referral_code": undefined;
    /**
     * Mark a locked credit as fulfilled by providing a transaction hash
     *
     * - `origin`: The account that originally locked the credits
     * - `locked_credit_id`: The ID of the locked credit to mark as fulfilled
     * - `tx_hash`: The transaction hash proving fulfillment
     */
    "fulfill_locked_credits": Anonymize<Ib4e7k10isusrc>;
    "set_lock_period": Anonymize<Iclo2qf5jhpbn0>;
    /**
     * Set the minimum lock amount (only callable by authorized accounts)
     */
    "set_min_lock_amount": Anonymize<I3qt1hgg4djhgb>;
    /**
     * Set the alpha price (only callable by authorized accounts)
     */
    "set_alpha_price": Anonymize<I6h5nf3idmn898>;
}>;
export type I17do9d5rlq72d = {
    "marketplace_credit_amount": bigint;
    "alpha_amount": bigint;
    "user_to_credit": SS58String;
};
export type Ib4e7k10isusrc = {
    "locked_credit_id": bigint;
    "account_id": SS58String;
    "tx_hash": Binary;
};
export type Iclo2qf5jhpbn0 = {
    "start_block": number;
    "end_block": number;
};
export type I1str8i2jc1f9f = AnonymousEnum<{
    "create_space": Anonymize<I37gkv4ibak4u6>;
    /**
     * Add a member to a space
     */
    "add_space_member": Anonymize<I6rufhqab68dv7>;
    "add_manifest_head_digest_and_manifest_json_cid": Anonymize<I5guamh56257sq>;
    /**
     * Store digest information (type and CID)
     */
    "store_digest_info": Anonymize<Ibie35o389u5m5>;
}>;
export type I37gkv4ibak4u6 = {
    "name": Binary;
};
export type I6rufhqab68dv7 = {
    "space_id": bigint;
    "new_member": SS58String;
};
export type I5guamh56257sq = {
    "repo_name": Binary;
    "image_name": Binary;
    "tag"?: Anonymize<Iabpgqcjikia83>;
    "digest": Binary;
    "cid": Binary;
};
export type Ibie35o389u5m5 = {
    "repo_name": Binary;
    "digest": Binary;
    "digest_type": Anonymize<I74v6trvb7j58h>;
    "cid": Binary;
};
export type I7lo258er1fjig = AnonymousEnum<{
    /**
     * User burns hAlpha to initiate a withdrawal to Bittensor
     *
     * hAlpha is burned immediately - no escrow. If the withdrawal fails,
     * admin can manually mint hAlpha back via `admin_manual_mint`.
     * The recipient on Bittensor is automatically set to the sender's address.
     *
     * # Arguments
     * * `origin` - Must be signed by the user
     * * `amount` - Amount of hAlpha to burn (in halphaRao, u128)
     */
    "withdraw": Anonymize<I3qt1hgg4djhgb>;
    /**
     * Guardian attests a deposit (first attestation creates the record)
     *
     * When guardians observe a deposit_request on Bittensor, they call this
     * to vote for crediting hAlpha. First attestation creates the Deposit record.
     * When threshold is reached, hAlpha is credited to recipient.
     *
     * # Arguments
     * * `origin` - Must be signed by a guardian
     * * `request_id` - The deposit request ID from Bittensor
     * * `recipient` - Recipient to credit hAlpha to
     * * `amount` - Amount to credit (in halphaRao)
     * * `nonce` - Nonce from the deposit request (used for ID verification)
     */
    "attest_deposit": Anonymize<I4enrikluv7ukd>;
    /**
     * Guardian can cleanup a finalized deposit after TTL
     *
     * # Arguments
     * * `origin` - Must be signed by a guardian
     * * `deposit_id` - The deposit ID to cleanup
     */
    "cleanup_deposit": Anonymize<I7s3nv09agh2e2>;
    /**
     * Guardian can cleanup a withdrawal request after TTL (no status check for source records)
     *
     * # Arguments
     * * `origin` - Must be signed by a guardian
     * * `request_id` - The withdrawal request ID to cleanup
     */
    "cleanup_withdrawal_request": Anonymize<I1f9io740eqir0>;
    /**
     * Atomically set the guardian set and threshold (sudo/root only)
     *
     * # Arguments
     * * `origin` - Must be root
     * * `guardians` - New guardian set
     * * `approve_threshold` - Minimum guardian votes needed
     */
    "set_guardians_and_threshold": Anonymize<Iart6p0ogm1a4g>;
    /**
     * Pause the bridge (sudo/root only)
     */
    "pause": undefined;
    /**
     * Unpause the bridge (sudo/root only)
     */
    "unpause": undefined;
    /**
     * Set the global mint cap (sudo/root only)
     *
     * # Arguments
     * * `origin` - Must be root
     * * `cap` - Maximum total hAlpha that can be minted
     */
    "set_global_mint_cap": Anonymize<Ia6i01als4j5u5>;
    /**
     * Admin sets the cleanup TTL (in blocks)
     *
     * # Arguments
     * * `origin` - Must be root
     * * `ttl_blocks` - TTL in blocks before finalized records can be cleaned up
     */
    "set_cleanup_ttl": Anonymize<Ial53v9g5go073>;
    /**
     * Admin sets the minimum withdrawal amount
     *
     * # Arguments
     * * `origin` - Must be root
     * * `amount` - Minimum amount of hAlpha to withdraw (in halphaRao)
     */
    "set_min_withdrawal_amount": Anonymize<I3qt1hgg4djhgb>;
    /**
     * Admin cancels a deposit that is stuck (Pending but not reaching threshold)
     *
     * # Pause Behavior
     * Intentionally does NOT check pause state. Admin emergency/recovery
     * functions must remain operational when the bridge is paused, since
     * pausing is the first step in incident response.
     *
     * # Arguments
     * * `origin` - Must be root
     * * `request_id` - The deposit ID to cancel
     * * `reason` - Reason for cancellation
     */
    "admin_cancel_deposit": Anonymize<I5mdteph6cc9jt>;
    /**
     * Admin marks a withdrawal request as failed and manually mints hAlpha back
     *
     * This restores the hAlpha that was burned during withdraw(). The mint cap
     * check and TotalMintedByBridge update are performed to maintain accounting.
     *
     * # Pause Behavior
     * Intentionally does NOT check pause state. Admin emergency/recovery
     * functions must remain operational when the bridge is paused, since
     * pausing is the first step in incident response.
     *
     * # Arguments
     * * `origin` - Must be root
     * * `request_id` - The withdrawal request ID to fail
     */
    "admin_fail_withdrawal_request": Anonymize<I1f9io740eqir0>;
    /**
     * Admin manually mints hAlpha to a recipient (for emergency recovery)
     *
     * WARNING: This mints new hAlpha that wasn't part of a deposit flow.
     * Only use for emergency recovery. The amount counts toward the mint cap.
     *
     * # Pause Behavior
     * Intentionally does NOT check pause state. Admin emergency/recovery
     * functions must remain operational when the bridge is paused, since
     * pausing is the first step in incident response.
     *
     * # Arguments
     * * `origin` - Must be root
     * * `recipient` - Account to receive hAlpha
     * * `amount` - Amount to mint (in halphaRao)
     * * `deposit_id` - Optional deposit ID for audit trail
     */
    "admin_manual_mint": Anonymize<Ifkr43tqovhaij>;
}>;
export type I4enrikluv7ukd = {
    "request_id": FixedSizeBinary<32>;
    "recipient": SS58String;
    "amount": bigint;
    "nonce": bigint;
};
export type I7s3nv09agh2e2 = {
    "deposit_id": FixedSizeBinary<32>;
};
export type I1f9io740eqir0 = {
    "request_id": FixedSizeBinary<32>;
};
export type Ia6i01als4j5u5 = {
    "cap": bigint;
};
export type Ial53v9g5go073 = {
    "ttl_blocks": bigint;
};
export type I5mdteph6cc9jt = {
    "request_id": FixedSizeBinary<32>;
    "reason": Anonymize<I8tfql2anqh1fg>;
};
export type I4vmas8antd12l = AnonymousEnum<{
    "add_available_vm_ip": Anonymize<I91984ic727015>;
    "add_available_hypervisor_ip": Anonymize<I91984ic727015>;
    "add_available_client_ip": Anonymize<I91984ic727015>;
    "add_available_storage_miner_ip": Anonymize<I91984ic727015>;
    "remove_available_vm_ip": Anonymize<I91984ic727015>;
    "remove_available_hypervisor_ip": Anonymize<I91984ic727015>;
    "remove_available_client_ip": Anonymize<I91984ic727015>;
    "remove_available_storage_miner_ip": Anonymize<I91984ic727015>;
}>;
export type Icm50dar8ebmm2 = AnonymousEnum<{
    /**
     * Sudo function to enable or disable file assignments
     */
    "set_pinning_enabled": Anonymize<I94dejtmu6d72i>;
    /**
     * Sudo function to enable or disable file assignments
     */
    "set_assignment_enabled": Anonymize<I94dejtmu6d72i>;
    /**
     * Unsigned transaction to set a miner's state to Locked
     */
    "remove_bad_storage_request": Anonymize<Iprdg004aleb1>;
    /**
     * Unsigned transaction to remove a bad unpin request
     */
    "remove_bad_unpin_request": Anonymize<Iprdg004aleb1>;
    "update_pin_and_storage_requests": Anonymize<I4j0crdbqua0qu>;
    "update_unpin_and_storage_requests": Anonymize<I26uip050ir8v7>;
    /**
     * Removes all unpin requests by the specified owner.
     */
    "sudo_remove_unpin_requests": Anonymize<I2unte8sl8u10d>;
    "remove_rebalance_request": Anonymize<Iakdoa23lufqg0>;
    "blacklist_user": Anonymize<I6dgvurjgtiomb>;
    /**
     * Set rotation enabled or disabled (sudo-only)
     */
    "set_rotation_whitelisting_enabled": Anonymize<I94dejtmu6d72i>;
    "clear_all_data": undefined;
    "update_miner_profiles": Anonymize<I1oh4jsoq9jqr0>;
    "update_user_profiles": Anonymize<I95fuqbk5en8j6>;
    /**
     * Unsigned transaction to clear all unpin requests for a validator node
     */
    "clear_all_unpin_requests": undefined;
    "close_storage_requests": Anonymize<Ib1oa5g7vc8nbc>;
    "close_unpin_requests": Anonymize<Ib1oa5g7vc8nbc>;
    "submit_storage_request_for_user": Anonymize<I5632otb8qptv2>;
    "submit_unpin_request_for_user": Anonymize<Ibffn022ev2pud>;
}>;
export type Iprdg004aleb1 = {
    "file_hash": Binary;
};
export type I4j0crdbqua0qu = {
    "requests": Array<{
        "storage_request_owner": SS58String;
        "storage_request_file_hash": Binary;
        "file_size": bigint;
        "user_profile_cid": Binary;
    }>;
    "miner_profiles": Anonymize<Ibugsjvpjb4k4s>;
};
export type Ibugsjvpjb4k4s = Array<{
    "miner_node_id": Binary;
    "cid": Binary;
    "files_count": number;
    "files_size": bigint;
}>;
export type I26uip050ir8v7 = {
    "requests": Array<{
        "miner_pin_requests": Anonymize<Ibugsjvpjb4k4s>;
        "storage_request_owner": SS58String;
        "storage_request_file_hash": Binary;
        "file_size": bigint;
        "user_profile_cid": Binary;
    }>;
};
export type I2unte8sl8u10d = {
    "owner": SS58String;
};
export type Iakdoa23lufqg0 = {
    "node_rebalanace_request_to_remove"?: Anonymize<Icfm6esve5sckl>;
    "updated_miner_profiles": Array<{
        "miner_node_id": Binary;
        "cid": Binary;
        "added_files_count": number;
        "added_file_size": bigint;
    }>;
    "updated_user_profiles": Array<{
        "user": SS58String;
        "cid": Binary;
    }>;
};
export type I6dgvurjgtiomb = {
    "user": SS58String;
    "blacklist": boolean;
};
export type I1oh4jsoq9jqr0 = {
    "profiles": Anonymize<I6pi5ou8r1hblk>;
};
export type I95fuqbk5en8j6 = {
    "profiles": Array<Anonymize<I92tce08cbhnmn>>;
};
export type Ib1oa5g7vc8nbc = {
    "file_hashes": Anonymize<Itom7fk49o0c9>;
};
export type I5632otb8qptv2 = {
    "owner": SS58String;
    "file_inputs": Anonymize<Ibefmjheg1a3em>;
};
export type Ibffn022ev2pud = {
    "owner": SS58String;
    "file_hashes": Anonymize<Itom7fk49o0c9>;
};
export type I3qt48j97a00ls = AnonymousEnum<{
    /**
     * Publish a new CRUSH map for a specific epoch.
     *
     * Expected usage:
     * - Called only when epoch changes.
     * - Miner list MUST be sorted by `uid` ascending and have unique uids.
     *
     * Stores:
     * - `EpochParams[epoch]`
     * - `EpochMiners[epoch]`
     * - `EpochRoot[epoch]` (hash of canonical SCALE encoding)
     * Updates:
     * - `CurrentEpoch`
     */
    "submit_crush_map": Anonymize<I8npm6laabqo83>;
    /**
     * Submit aggregated miner stats updates for the current reporting bucket.
     *
     * Suggested: call every N blocks (e.g. 300) with aggregates.
     */
    "submit_miner_stats": Anonymize<I9946bspu783hd>;
    /**
     * Register a child node under a family.
     *
     * - **First child free per family (one-time)**.
     * - After that, the required deposit is **global** (network-wide) and **doubles** after each paid registration.
     * - Global deposit **halves** after each `GlobalDepositHalvingPeriodBlocks` of inactivity (lazy, computed on registration).
     * - Requires `node_id` (ed25519 pubkey) to sign a domain-separated payload including a per-node nonce.
     *
     * Signature payload (domain-separated, SCALE-encoded):
     * - ("ARION_NODE_REG_V1", family, child, node_id, nonce)
     */
    "register_child": Anonymize<I4ir6ck75pcou4>;
    /**
     * Deregister a child node.
     *
     * Effects:
     * - Child becomes `Unbonding`, removed from active counts
     * - Node id is released from the active registry, but put in cooldown
     * - Deposit remains reserved until `claim_unbonded`
     */
    "deregister_child": Anonymize<Ie4uqb22ums70>;
    /**
     * Claim (unbond) the deposit for a deregistered child after the unbonding period.
     *
     * Note: this does NOT bypass cooldown; cooldown is enforced on `register_child`.
     */
    "claim_unbonded": Anonymize<Ie4uqb22ums70>;
    /**
     * Submit validator-observed per-node quality metrics and let the pallet compute the final node + family weights.
     *
     * This is the **recommended** path (deterministic on-chain weight calculation).
     */
    "submit_node_quality": Anonymize<I6tepc53cpcgor>;
    /**
     * Submit warden proof-of-storage attestations.
     *
     * Attestations are signed audit results from wardens that verify miners
     * are storing the data they claim to store. These are used for:
     * - Reputation scoring
     * - Slashing for failed audits
     * - Rewarding successful storage proofs
     *
     * Expected usage:
     * - Called periodically by the chain-submitter service
     * - Warden signs attestations with Ed25519 keypair
     * - Signature verification is performed on-chain for each attestation
     *
     * # Security
     * - Each attestation signature is verified using Ed25519
     * - Invalid signatures are rejected with InvalidAttestationSignature error
     */
    "submit_attestations": Anonymize<I7pmn74tpeupjh>;
    /**
     * Submit an attestation commitment for third-party verification.
     *
     * This stores a compact commitment containing merkle roots and the Arion
     * content hash. Third parties can:
     * 1. Query this commitment from the chain
     * 2. Download the full bundle from Arion using `arion_content_hash`
     * 3. Verify the bundle hash matches
     * 4. Verify attestations against the merkle roots
     *
     * # Parameters
     * - `epoch`: The epoch this commitment covers
     * - `arion_content_hash`: BLAKE3 hash of the SCALE-encoded AttestationBundle (32 bytes)
     * - `attestation_merkle_root`: Merkle root of all attestation leaves
     * - `warden_pubkey_merkle_root`: Merkle root of unique warden public keys
     * - `attestation_count`: Number of attestations in the bundle
     */
    "submit_attestation_commitment": Anonymize<I8q57m51quft2e>;
    /**
     * Admin: enable/disable registration lockup (reserve/unbond).
     *
     * Configure `AdminOrigin` as `EnsureRoot` to make this a sudo-only extrinsic.
     */
    "set_lockup_enabled": Anonymize<I94dejtmu6d72i>;
    /**
     * Admin: set the base deposit price (floor for the global fee curve).
     *
     * Configure `AdminOrigin` as `EnsureRoot` to make this a sudo-only extrinsic.
     *
     * Notes:
     * - This does not overwrite `GlobalNextDeposit` unless it is below the new floor;
     * the next time registration runs, `global_next_deposit_floor_init` will raise it.
     */
    "set_base_child_deposit": Anonymize<I1fm7b684mo0pb>;
    /**
     * Admin: Register a warden authorized to submit attestations.
     *
     * Once registered, attestations from this warden's public key will be accepted.
     * Third parties can query `RegisteredWardens[pubkey]` to verify authorization.
     *
     * # Parameters
     * - `warden_pubkey`: The warden's Ed25519 public key (32 bytes)
     */
    "register_warden": Anonymize<Icsr8fi82ccpe5>;
    /**
     * Admin: Deregister a warden, preventing future attestation submissions.
     *
     * The warden's registration record is kept for audit purposes but marked as deregistered.
     * Attestations from deregistered wardens will be rejected.
     *
     * # Parameters
     * - `warden_pubkey`: The warden's Ed25519 public key (32 bytes)
     */
    "deregister_warden": Anonymize<Icsr8fi82ccpe5>;
    /**
     * Prune old attestation buckets to prevent unbounded storage growth.
     *
     * Removes attestation data for buckets older than `before_bucket`.
     * The `before_bucket` must be at least `AttestationRetentionBuckets` behind
     * the current bucket to prevent accidental pruning of recent data.
     *
     * This is a permissionless operation - anyone can call it to help clean up
     * old attestation data. The retention period ensures recent data is protected.
     *
     * # Parameters
     * - `before_bucket`: Prune all buckets with ID less than this value
     * - `max_buckets`: Maximum number of buckets to prune in this call (for weight limiting)
     */
    "prune_attestation_buckets": Anonymize<Ifujvbrougmt1u>;
}>;
export type I8npm6laabqo83 = {
    "epoch": bigint;
    "params": Anonymize<I2igc2btujm50s>;
    "miners": Anonymize<Ianojun924rii6>;
};
export type I2igc2btujm50s = {
    "pg_count": number;
    "ec_k": number;
    "ec_m": number;
};
export type Ianojun924rii6 = Array<{
    "uid": number;
    "node_id": FixedSizeBinary<32>;
    "weight": number;
    "family_id": SS58String;
    "endpoint": Binary;
    "http_addr": Binary;
}>;
export type I9946bspu783hd = {
    "bucket": number;
    "updates": Array<{
        "uid": number;
        "stats": Anonymize<Iegso6e591humo>;
    }>;
    "network_totals"?: (Anonymize<Ibp595vp69nb95>) | undefined;
};
export type Iegso6e591humo = {
    "shard_count": bigint;
    "shard_data_bytes": bigint;
    "strikes": number;
    "last_seen_bucket": number;
    "bandwidth_bytes": bigint;
    "integrity_fails": number;
};
export type Ibp595vp69nb95 = {
    "total_shards": bigint;
    "total_shard_data_bytes": bigint;
    "total_bandwidth_bytes": bigint;
};
export type I4ir6ck75pcou4 = {
    "family": SS58String;
    "child": SS58String;
    "node_id": FixedSizeBinary<32>;
    "node_sig": FixedSizeBinary<64>;
};
export type Ie4uqb22ums70 = {
    "child": SS58String;
};
export type I6tepc53cpcgor = {
    "bucket": number;
    "updates": Array<[SS58String, Anonymize<I86kjcprqpmpbf>]>;
};
export type I86kjcprqpmpbf = {
    "shard_data_bytes": bigint;
    "bandwidth_bytes": bigint;
    "uptime_permille": number;
    "strikes": number;
    "integrity_fails": number;
};
export type I7pmn74tpeupjh = {
    "bucket": number;
    "attestations": Anonymize<I21oce8fars5kb>;
};
export type I21oce8fars5kb = Array<{
    "shard_hash": Binary;
    "miner_uid": number;
    "result": Enum<{
        "Passed": undefined;
        "Failed": undefined;
        "Timeout": undefined;
        "InvalidProof": undefined;
    }>;
    "challenge_seed": FixedSizeBinary<32>;
    "block_number": bigint;
    "timestamp": bigint;
    "warden_pubkey": Binary;
    "signature": Binary;
    "merkle_proof_sig_hash": Binary;
    "warden_id": Binary;
}>;
export type I8q57m51quft2e = {
    "epoch": bigint;
    "arion_content_hash": Binary;
    "attestation_merkle_root": FixedSizeBinary<32>;
    "warden_pubkey_merkle_root": FixedSizeBinary<32>;
    "attestation_count": number;
};
export type Icsr8fi82ccpe5 = {
    "warden_pubkey": FixedSizeBinary<32>;
};
export type Ifujvbrougmt1u = {
    "before_bucket": number;
    "max_buckets": number;
};
export type I8g8u2r2m659dq = {
    "index": number;
    "threshold": number;
    "ayes": Anonymize<Ia2lhg7l2hilo3>;
    "nays": Anonymize<Ia2lhg7l2hilo3>;
    "end": bigint;
};
export type I63js2b08d3e38 = Array<Anonymize<I4sun88f8jcj4r>>;
export type Version = Enum<{
    "V0": undefined;
    "V1": undefined;
}>;
export declare const Version: GetEnum<Version>;
export type I8nj9dlo7lnbb3 = Array<{
    "who": SS58String;
    "stake": bigint;
    "deposit": bigint;
}>;
export type Ib23vkkc52tqbu = {
    "votes": Anonymize<Ia2lhg7l2hilo3>;
    "stake": bigint;
    "deposit": bigint;
};
export type Ictkaqdbfabuek = {
    "supports": Anonymize<I4bboqsv44evel>;
    "score": Anonymize<I8s6n43okuj2b1>;
    "compute": ElectionProviderMultiPhaseElectionCompute;
};
export type Ia7o65280hur3p = {
    "voters": Array<[SS58String, bigint, Anonymize<Ia2lhg7l2hilo3>]>;
    "targets": Anonymize<Ia2lhg7l2hilo3>;
};
export type I41gemnici26aj = Array<[Anonymize<I8s6n43okuj2b1>, bigint, number]>;
export type Irl37q7erstrb = {
    "who": SS58String;
    "deposit": bigint;
    "raw_solution": Anonymize<I7je4n92ump862>;
    "call_fee": bigint;
};
export type Ic12aht5vh2sen = {
    "stash": SS58String;
    "total": bigint;
    "active": bigint;
    "unlocking": Anonymize<I9nc4v1upo2c8e>;
    "legacy_claimed_rewards": Anonymize<Icgljjb6j82uhn>;
};
export type Ic3m9d6tdl6gi2 = {
    "targets": Anonymize<Ia2lhg7l2hilo3>;
    "submitted_in": number;
    "suppressed": boolean;
};
export type Ib3j7gb0jgs38u = {
    "index": number;
    "start"?: Anonymize<I35p85j063s0il>;
};
export type I6flrronqs3l6n = {
    "total": bigint;
    "own": bigint;
    "nominator_count": number;
    "page_count": number;
};
export type I97fulj5h3ik95 = {
    "page_total": bigint;
    "others": Anonymize<I252o97fo263q7>;
};
export type Ia8896dq44k9m4 = [number, SS58String, number];
export type Iff9p3c7k6pfoi = {
    "total": number;
    "individual": Array<Anonymize<I6ouflveob4eli>>;
};
export type Iafq6t4rgheait = Array<{
    "validator": SS58String;
    "own": bigint;
    "others": Anonymize<Iba9inugg1atvo>;
    "reporters": Anonymize<Ia2lhg7l2hilo3>;
    "payout": bigint;
}>;
export type Iinkhfdlka9ch = {
    "span_index": number;
    "last_start": number;
    "last_nonzero_slash": number;
    "prior": Anonymize<Icgljjb6j82uhn>;
};
export type I2kj4j6mp68hf8 = {
    "slashed": bigint;
    "paid_out": bigint;
};
export type I3n8u7haiacr3o = Array<[SS58String, Anonymize<Ifngji0jpcpvpj>]>;
export type Iegmj7n48sc3am = {
    "proposer": SS58String;
    "value": bigint;
    "beneficiary": SS58String;
    "bond": bigint;
};
export type I3t96o5lsq581r = {
    "amount": bigint;
    "beneficiary": SS58String;
    "valid_from": bigint;
    "expire_at": bigint;
    "status": Enum<{
        "Pending": undefined;
        "Attempted": Anonymize<I3m5sq54sjdlso>;
        "Failed": undefined;
    }>;
};
export type I17lk5gd4jui0r = {
    "proposer": SS58String;
    "value": bigint;
    "fee": bigint;
    "curator_deposit": bigint;
    "bond": bigint;
    "status": Enum<{
        "Proposed": undefined;
        "Approved": undefined;
        "Funded": undefined;
        "CuratorProposed": Anonymize<I846573mdj1pfn>;
        "Active": {
            "curator": SS58String;
            "update_due": bigint;
        };
        "PendingPayout": Anonymize<Ias7isi6au0v1u>;
    }>;
};
export type I846573mdj1pfn = {
    "curator": SS58String;
};
export type Ias7isi6au0v1u = {
    "curator": SS58String;
    "beneficiary": SS58String;
    "unlock_at": bigint;
};
export type I2ejqo0lr36e3q = {
    "parent_bounty": number;
    "value": bigint;
    "fee": bigint;
    "curator_deposit": bigint;
    "status": Enum<{
        "Added": undefined;
        "CuratorProposed": Anonymize<I846573mdj1pfn>;
        "Active": Anonymize<I846573mdj1pfn>;
        "PendingPayout": Anonymize<Ias7isi6au0v1u>;
    }>;
};
export type Ic5t26f9cp3tvk = {
    "id": SS58String;
    "prev"?: Anonymize<Ihfphjolmsqq1>;
    "next"?: Anonymize<Ihfphjolmsqq1>;
    "bag_upper": bigint;
    "score": bigint;
};
export type I39k39h6vu4hbq = {
    "head"?: Anonymize<Ihfphjolmsqq1>;
    "tail"?: Anonymize<Ihfphjolmsqq1>;
};
export type Idphjddn2h69vc = {
    "pool_id": number;
    "points": bigint;
    "last_recorded_reward_counter": bigint;
    "unbonding_eras": Anonymize<If9jidduiuq7vv>;
};
export type Ia8n1658h0bakq = {
    "commission": {
        "current"?: Anonymize<Ie8iutm7u02lmj>;
        "max"?: Anonymize<I4arjljr6dpflb>;
        "change_rate"?: (Anonymize<I82n31imqd56r6>) | undefined;
        "throttle_from"?: Anonymize<I35p85j063s0il>;
        "claim_permission"?: Anonymize<I16m1kn78dee7v>;
    };
    "member_counter": number;
    "points": bigint;
    "roles": {
        "depositor": SS58String;
        "root"?: Anonymize<Ihfphjolmsqq1>;
        "nominator"?: Anonymize<Ihfphjolmsqq1>;
        "bouncer"?: Anonymize<Ihfphjolmsqq1>;
    };
    "state": NominationPoolsPoolState;
};
export type If6qa32dj75gu1 = {
    "last_recorded_reward_counter": bigint;
    "last_recorded_total_payouts": bigint;
    "total_rewards_claimed": bigint;
    "total_commission_pending": bigint;
    "total_commission_claimed": bigint;
};
export type I7oo2mprv1qd1s = {
    "no_era": Anonymize<I4h0cfnkiqrna6>;
    "with_era": Array<[number, Anonymize<I4h0cfnkiqrna6>]>;
};
export type I4h0cfnkiqrna6 = {
    "points": bigint;
    "balance": bigint;
};
export type I8b18sngtfv9qe = Array<({
    "maybe_id"?: Anonymize<I4s6vifaf8k998>;
    "priority": number;
    "call": PreimagesBounded;
    "maybe_periodic"?: Anonymize<I76de2jfh8ds4a>;
    "origin": Anonymize<I3l2bgvo0holot>;
}) | undefined>;
export type I2n348ct50b2mp = {
    "total_retries": number;
    "remaining": number;
    "period": bigint;
};
export type I8j24837rs9r0t = AnonymousEnum<{
    "Unrequested": {
        "ticket": Anonymize<Ifvqn3ldat80ai>;
        "len": number;
    };
    "Requested": {
        "maybe_ticket"?: (Anonymize<Ifvqn3ldat80ai>) | undefined;
        "count": number;
        "maybe_len"?: Anonymize<I4arjljr6dpflb>;
    };
}>;
export type Ifvqn3ldat80ai = [SS58String, undefined];
export type I2bqvqrg0sbrdj = {
    "offender": Anonymize<Idi27pva6ajg4>;
    "reporters": Anonymize<Ia2lhg7l2hilo3>;
};
export type I23nq3fsgtejt = [FixedSizeBinary<16>, Binary];
export type I1evsr8hplu1lg = [{
    "judgements": Array<[number, IdentityJudgement]>;
    "deposit": bigint;
    "info": Anonymize<I1o57snqt6f4v5>;
}, Anonymize<Iabpgqcjikia83>];
export type I74af64m08r6as = Array<({
    "account": SS58String;
    "fee": bigint;
    "fields": bigint;
}) | undefined>;
export type I9bhbof2vim227 = {
    "suffix": Binary;
    "allocation": number;
};
export type Iahvoath23ldhv = {
    "when": Anonymize<I83nkmvi3lsg6r>;
    "deposit": bigint;
    "depositor": SS58String;
    "approvals": Anonymize<Ia2lhg7l2hilo3>;
};
export type Ic17drnrq0rtgi = Array<[Anonymize<I6fr2mqud652ga>, Anonymize<Ifoernv5r40rfc>, Anonymize<I87cgves5f5lsa>]>;
export type I87cgves5f5lsa = AnonymousEnum<{
    "Legacy": Anonymize<I16nm875k0bak5>;
    "EIP2930": Anonymize<I16nm875k0bak5>;
    "EIP1559": Anonymize<I16nm875k0bak5>;
}>;
export type Idi27giun0mb9q = {
    "header": Anonymize<I4v962mnhj6j6r>;
    "transactions": Anonymize<I1fl9qh2r1hf29>;
    "ommers": Anonymize<I78ffku0ve5fgm>;
};
export type I1fl9qh2r1hf29 = Array<Anonymize<I6fr2mqud652ga>>;
export type Idud3fdh64aqp9 = Array<Anonymize<I87cgves5f5lsa>>;
export type I2gp57ssjscm57 = [Array<{
    "delegate": SS58String;
    "proxy_type": Anonymize<I1bpip5bh5877p>;
    "delay": bigint;
}>, bigint];
export type I43vorjrsfs83q = [Array<{
    "real": SS58String;
    "call_hash": FixedSizeBinary<32>;
    "height": bigint;
}>, bigint];
export type I1k1g0avb0ugrv = ({
    "node_id": Binary;
    "node_type": Anonymize<I9ea6lu6bbueo9>;
    "ipfs_node_id"?: Anonymize<Iabpgqcjikia83>;
    "status": Anonymize<I2jkc6fd285bq3>;
    "registered_at": bigint;
    "owner": SS58String;
    "is_verified": boolean;
}) | undefined;
export type I794shhubguhfe = Array<{
    "node_id": Binary;
    "created_at": bigint;
}>;
export type Ic2gqqe3boa6j = [Anonymize<Iek834g6cg3jc8>, Binary];
export type Irepiuosq268n = {
    "miner_id": Binary;
    "bandwidth_mbps": number;
    "current_storage_bytes": bigint;
    "total_storage_bytes": bigint;
    "geolocation": Binary;
    "successful_pin_checks": number;
    "total_pin_checks": number;
    "storage_proof_time_ms": number;
    "storage_growth_rate": number;
    "latency_ms": number;
    "total_latency_ms": number;
    "total_times_latency_checked": number;
    "avg_response_time_ms": number;
    "peer_count": number;
    "failed_challenges_count": number;
    "successful_challenges": number;
    "total_challenges": number;
    "uptime_minutes": number;
    "total_minutes": number;
    "consecutive_reliable_days": number;
    "recent_downtime_hours": number;
    "is_sev_enabled": boolean;
    "zfs_info": Anonymize<Itom7fk49o0c9>;
    "ipfs_zfs_pool_size": bigint;
    "ipfs_zfs_pool_alloc": bigint;
    "ipfs_zfs_pool_free": bigint;
    "raid_info": Anonymize<Itom7fk49o0c9>;
    "vm_count": number;
    "primary_network_interface"?: Anonymize<I710lggphn7ltb>;
    "disks": Anonymize<Ibfh8cru772kj5>;
    "ipfs_repo_size": bigint;
    "ipfs_storage_max": bigint;
    "cpu_model": Binary;
    "cpu_cores": number;
    "memory_mb": bigint;
    "free_memory_mb": bigint;
    "gpu_name"?: Anonymize<Iabpgqcjikia83>;
    "gpu_memory_mb"?: Anonymize<I4arjljr6dpflb>;
    "hypervisor_disk_type"?: Anonymize<Iabpgqcjikia83>;
    "vm_pool_disk_type"?: Anonymize<Iabpgqcjikia83>;
    "disk_info": Anonymize<Icmbpj606ekbcn>;
};
export type I4p8l84tk038s = [Binary, SS58String];
export type I5ofvu2mgb3ik6 = Array<[SS58String, Anonymize<Ifl5oat0rhcq32>]>;
export type If8b3rdbls82p1 = {
    "id": FixedSizeBinary<32>;
    "plan_name": Binary;
    "plan_description": Binary;
    "plan_technical_description": Binary;
    "is_suspended": boolean;
    "price": bigint;
    "is_storage_plan": boolean;
    "storage_limit"?: Anonymize<I35p85j063s0il>;
};
export type I3f35fplll6ic0 = {
    "id": number;
    "owner": SS58String;
    "package": Anonymize<If8b3rdbls82p1>;
    "cdn_location_id"?: Anonymize<I4arjljr6dpflb>;
    "active": boolean;
    "last_charged_at": bigint;
    "selected_image_name"?: Anonymize<Iabpgqcjikia83>;
};
export type I2ek94e7loqjdr = Array<Anonymize<I3f35fplll6ic0>>;
export type I2plnma28qqa7d = {
    "url": Binary;
    "description": Binary;
    "name": Binary;
};
export type I30u3t989dudrc = {
    "owner": SS58String;
    "credit_amount": bigint;
    "alpha_amount": bigint;
    "remaining_credits": bigint;
    "remaining_alpha": bigint;
    "pending_alpha": bigint;
    "is_frozen": boolean;
    "release_time": bigint;
};
export type I41jij06egn8q0 = {
    "id": number;
    "name": Binary;
    "price_multiplier": number;
};
export type I8052e8591l2k5 = {
    "transaction_type": Anonymize<Ia9h92356vsmef>;
    "amount": bigint;
    "timestamp": bigint;
    "subscription_id"?: Anonymize<I4arjljr6dpflb>;
};
export type I5ocim6bqhcb87 = Array<{
    "sender": SS58String;
    "block_to_send": bigint;
    "recurrence": boolean;
    "starting_recurrence"?: Anonymize<I35p85j063s0il>;
    "frequency"?: Anonymize<I35p85j063s0il>;
    "read": boolean;
    "notification_type": Enum<{
        "SubscriptionEndingSoon": undefined;
        "SubscriptionHasEnded": undefined;
        "General": undefined;
    }>;
}>;
export type I9fmfdj27dod2r = Array<{
    "rank": number;
    "node_id": Binary;
    "node_ss58_address": Binary;
    "node_type": Anonymize<I9ea6lu6bbueo9>;
    "weight": number;
    "last_updated": bigint;
    "is_active": boolean;
}>;
export type Ie9ca3ooag8pvg = Array<{
    "node_types": Anonymize<I9ea6lu6bbueo9>;
    "weight": number;
    "amount": bigint;
    "account": SS58String;
    "block_number": bigint;
}>;
export type I2dlsvlc18d84 = {
    "start_block": bigint;
    "end_block": bigint;
};
export type Ifv97gfrl1guc = Array<{
    "owner": SS58String;
    "amount_locked": bigint;
    "is_fulfilled": boolean;
    "tx_hash"?: Anonymize<Iabpgqcjikia83>;
    "created_at": bigint;
    "id": bigint;
    "is_migrated": boolean;
}>;
export type If55bm6vm10gt4 = {
    "owner": SS58String;
    "repo_name": Binary;
    "members": Anonymize<Ia2lhg7l2hilo3>;
    "image_names": Anonymize<Itom7fk49o0c9>;
};
export type I57odkpjf7icor = FixedSizeArray<3, Binary>;
export type I3ks7h4esgu87b = {
    "digest_type": Anonymize<I74v6trvb7j58h>;
    "cid": Binary;
};
export type I5tr5ve03qkqub = {
    "request_id": FixedSizeBinary<32>;
    "recipient": SS58String;
    "amount": bigint;
    "votes": Anonymize<Ia2lhg7l2hilo3>;
    "status": Enum<{
        "Pending": undefined;
        "Completed": undefined;
        "Cancelled": undefined;
    }>;
    "created_at_block": bigint;
    "finalized_at_block"?: Anonymize<I35p85j063s0il>;
};
export type Ibshtksbg4cn8s = {
    "sender": SS58String;
    "recipient": SS58String;
    "amount": bigint;
    "nonce": bigint;
    "status": Enum<{
        "Requested": undefined;
        "Failed": undefined;
    }>;
    "created_at_block": bigint;
};
export type Ia79cnsrsjj9f = AnonymousEnum<{
    "Hypervisor": Binary;
    "Client": SS58String;
    "Vm": Binary;
    "StorageMiner": Binary;
}>;
export type I826pe08hg303r = Array<{
    "vm_name": Binary;
    "ip": Binary;
    "created_at": bigint;
    "role_type": Anonymize<Ia79cnsrsjj9f>;
}>;
export type I2r873a4ldk78h = ({
    "total_replicas": number;
    "owner": SS58String;
    "file_hash": Binary;
    "file_name": Binary;
    "last_charged_at": bigint;
    "created_at": bigint;
    "miner_ids"?: Anonymize<Icfm6esve5sckl>;
    "selected_validator": SS58String;
    "is_assigned": boolean;
}) | undefined;
export type I1liagipf62t7o = Array<{
    "owner": SS58String;
    "file_hash": Binary;
    "selected_validator": SS58String;
}>;
export type I9ul39lmd4kq7 = Array<{
    "node_id": Binary;
    "miner_profile_id": Binary;
}>;
export type I2nnfiu9n558kd = {
    "epoch": bigint;
    "arion_content_hash": Binary;
    "attestation_merkle_root": FixedSizeBinary<32>;
    "warden_pubkey_merkle_root": FixedSizeBinary<32>;
    "attestation_count": number;
    "submitted_at_block": bigint;
};
export type I84g50k59vdko9 = {
    "status": Enum<{
        "Active": undefined;
        "Deregistered": undefined;
    }>;
    "registered_at": bigint;
    "deregistered_at"?: Anonymize<I35p85j063s0il>;
};
export type I92o2mr60mvqni = {
    "family": SS58String;
    "node_id": FixedSizeBinary<32>;
    "status": Enum<{
        "Active": undefined;
        "Unbonding": undefined;
    }>;
    "deposit": bigint;
    "unbonding_end": bigint;
};
export type Ic6nglu2db2c36 = {
    "spec_name": string;
    "impl_name": string;
    "authoring_version": number;
    "spec_version": number;
    "impl_version": number;
    "apis": Anonymize<Ic9hg6pp5pkea5>;
    "transaction_version": number;
    "state_version": number;
};
export type I1e13lcoj2ijct = {
    "header": Anonymize<Idcpi3jpt0c03v>;
    "extrinsics": Anonymize<Itom7fk49o0c9>;
};
export type I4383lq801834t = ResultPayload<Anonymize<I5stn0hvret66s>, TransactionValidityError>;
export type TransactionValidityError = Enum<{
    "Invalid": TransactionValidityInvalidTransaction;
    "Unknown": TransactionValidityUnknownTransaction;
}>;
export declare const TransactionValidityError: GetEnum<TransactionValidityError>;
export type TransactionValidityInvalidTransaction = Enum<{
    "Call": undefined;
    "Payment": undefined;
    "Future": undefined;
    "Stale": undefined;
    "BadProof": undefined;
    "AncientBirthBlock": undefined;
    "ExhaustsResources": undefined;
    "Custom": number;
    "BadMandatory": undefined;
    "MandatoryValidation": undefined;
    "BadSigner": undefined;
}>;
export declare const TransactionValidityInvalidTransaction: GetEnum<TransactionValidityInvalidTransaction>;
export type I8gq452h0p0ftu = ResultPayload<Anonymize<I7ag5k7bmmgq3j>, Anonymize<Ik9f7r9ibbik9>>;
export type If6glui021su7n = ResultPayload<Anonymize<Ie3rl25flint9v>, Anonymize<Ik9f7r9ibbik9>>;
export type Ifogockjiq4b3 = (Anonymize<Idi27giun0mb9q>) | undefined;
export type I2r0n4gcrs974b = (Anonymize<Idud3fdh64aqp9>) | undefined;
export type Ibkook56hopvp8 = [Anonymize<Ifogockjiq4b3>, Anonymize<I2r0n4gcrs974b>, Anonymize<Ie6kgk6f04rsvk>];
export type I45rl58hfs7m0h = [Anonymize<Ifogockjiq4b3>, Anonymize<Ie6kgk6f04rsvk>];
export type Iajbob6uln5jct = ResultPayload<Anonymize<I6g5lcd9vf2cr0>, TransactionValidityError>;
export type I7qoh20ucjt7ir = Array<Anonymize<I9mv67prtv3200>>;
export type I9mv67prtv3200 = ({
    "miner_id": string;
    "bandwidth_bytes": number;
    "current_storage_bytes": bigint;
    "total_storage_bytes": bigint;
    "geolocation": string;
    "successful_pin_checks": number;
    "total_pin_checks": number;
    "storage_proof_time_ms": number;
    "storage_growth_rate": number;
    "latency_ms": number;
    "total_latency_ms": number;
    "total_times_latency_checked": number;
    "avg_response_time_ms": number;
    "peer_count": number;
    "failed_challenges_count": number;
    "successful_challenges": number;
    "total_challenges": number;
    "uptime_minutes": number;
    "total_minutes": number;
    "consecutive_reliable_days": number;
    "recent_downtime_hours": number;
    "is_sev_enabled": boolean;
    "zfs_info": Anonymize<I6lr8sctk0bi4e>;
    "ipfs_zfs_pool_size": bigint;
    "ipfs_zfs_pool_alloc": bigint;
    "ipfs_zfs_pool_free": bigint;
    "raid_info": Anonymize<I6lr8sctk0bi4e>;
    "vm_count": number;
    "primary_network_interface"?: ({
        "name": string;
        "mac_address"?: Anonymize<I1mqgk2tmnn9i2>;
        "uplink_mb": bigint;
        "downlink_mb": bigint;
        "network_details"?: ({
            "network_type": Anonymize<Ic972a5rdneln1>;
            "city"?: Anonymize<I1mqgk2tmnn9i2>;
            "region"?: Anonymize<I1mqgk2tmnn9i2>;
            "country"?: Anonymize<I1mqgk2tmnn9i2>;
            "loc"?: Anonymize<I1mqgk2tmnn9i2>;
        }) | undefined;
    }) | undefined;
    "disks": Array<{
        "name": string;
        "disk_type": string;
        "total_space_mb": bigint;
        "free_space_mb": bigint;
    }>;
    "ipfs_repo_size": bigint;
    "ipfs_storage_max": bigint;
    "cpu_model": string;
    "cpu_cores": number;
    "memory_bytes": bigint;
    "free_memory_bytes": bigint;
    "gpu_name"?: Anonymize<I1mqgk2tmnn9i2>;
    "gpu_memory_bytes"?: Anonymize<I4arjljr6dpflb>;
    "hypervisor_disk_type"?: Anonymize<I1mqgk2tmnn9i2>;
    "vm_pool_disk_type"?: Anonymize<I1mqgk2tmnn9i2>;
}) | undefined;
export type Ic42ukvpnbiepo = Array<{
    "account": SS58String;
    "reward": bigint;
}>;
export type I9fkvk930p4vn2 = Array<{
    "file_hash": Binary;
    "file_name": Binary;
    "miner_ids": Anonymize<Itom7fk49o0c9>;
    "file_size": number;
    "created_at": number;
}>;
export type I7hmn6t6t2ehn9 = ([Anonymize<I9ea6lu6bbueo9>, Anonymize<I2jkc6fd285bq3>]) | undefined;
export type Idn8l2092gsjnc = Array<Anonymize<I9a4fo8bkf0gcm>>;
export type I9a4fo8bkf0gcm = {
    "owner": SS58String;
    "credit_amount": bigint;
    "alpha_amount": bigint;
    "remaining_credits": bigint;
    "remaining_alpha": bigint;
    "pending_alpha": bigint;
    "is_frozen": boolean;
    "release_time": number;
};
export type I7dv09hod9o9ng = (Anonymize<I9a4fo8bkf0gcm>) | undefined;
export type I2q8ltoai1r4og = {
    "ready": Anonymize<I1fl9qh2r1hf29>;
    "future": Anonymize<I1fl9qh2r1hf29>;
};
export {};
