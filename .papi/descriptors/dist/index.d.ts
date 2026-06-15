import { default as bittensor, type BittensorWhitelistEntry } from "./bittensor";
export { bittensor };
export type * from "./bittensor";
import { default as hippius, type HippiusWhitelistEntry } from "./hippius";
export { hippius };
export type * from "./hippius";
export { DigestItem, Phase, DispatchClass, TokenError, ArithmeticError, TransactionalError, GrandpaEvent, BalanceStatus, TransactionPaymentEvent, PreimageEvent, GrandpaStoredState, BalancesTypesReasons, PreimagePalletHoldReason, TransactionPaymentReleases, PreimageOldRequestStatus, PreimageRequestStatus, PreimagesBounded, GrandpaEquivocation, MultiAddress, BalancesAdjustmentDirection, MultiSigner, MultiSignature, TransactionValidityUnknownTransaction, TransactionValidityTransactionSource, BabeAllowedSlots, BagsListListListError, IndicesEvent, VestingEvent, ElectionProviderMultiPhaseElectionCompute, StakingEvent, StakingRewardDestination, StakingForcing, SessionEvent, BountiesEvent, ChildBountiesEvent, BagsListEvent, NominationPoolsPoolState, NominationPoolsCommissionClaimPermission, OffencesEvent, WestendRuntimeRuntimeHoldReason, WestendRuntimeRuntimeFreezeReason, NominationPoolsPalletFreezeReason, BabeDigestsNextConfigDescriptor, BabeDigestsPreDigest, VotingConviction, StakingPalletConfigOpBig, StakingPalletConfigOp, NominationPoolsBondExtra, NominationPoolsConfigOp, NominationPoolsClaimPermission, IdentityData, IdentityJudgement, DispatchRawOrigin, Version, TransactionValidityError, TransactionValidityInvalidTransaction } from './common-types';
export declare const getMetadata: (codeHash: string) => Promise<Uint8Array | null>;
export type WhitelistEntry = BittensorWhitelistEntry | HippiusWhitelistEntry;
export type WhitelistEntriesByChain = Partial<{
    "*": WhitelistEntry[];
    bittensor: WhitelistEntry[];
    hippius: WhitelistEntry[];
}>;
export * as contracts from './contracts';
