import type { FixedSizeBinary, SS58String, ResultPayload, Enum, Binary, FixedSizeArray } from 'polkadot-api';
import type { InkDescriptors } from 'polkadot-api/ink';
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
type T4 = Array<SS58String>;
type T5 = {
    "sender": SS58String;
    "recipient": SS58String;
    "amount": bigint;
    "nonce": bigint;
    "hotkey": SS58String;
    "netuid": number;
    "status": Enum<{
        "Requested": undefined;
        "Failed": undefined;
    }>;
    "created_at_block": number;
};
type T6 = {
    "request_id": FixedSizeBinary<32>;
    "recipient": SS58String;
    "amount": bigint;
    "votes": Anonymize<T4>;
    "status": Enum<{
        "Pending": undefined;
        "Completed": undefined;
        "Cancelled": undefined;
    }>;
    "created_at_block": number;
    "finalized_at_block"?: (number) | undefined;
};
type T0 = Enum<{
    "CouldNotReadInput": undefined;
}>;
type T1 = Enum<{
    "Unauthorized": undefined;
    "NotGuardian": undefined;
    "AlreadyVoted": undefined;
    "InsufficientStake": undefined;
    "TransferNotVerified": undefined;
    "InsufficientContractStake": undefined;
    "AmountTooSmall": undefined;
    "InvalidThresholds": undefined;
    "TooManyGuardians": undefined;
    "InvalidWithdrawalDetails": undefined;
    "InvalidTTL": undefined;
    "BridgePaused": undefined;
    "DepositRequestNotFound": undefined;
    "WithdrawalNotFound": undefined;
    "DepositRequestAlreadyFinalized": undefined;
    "WithdrawalAlreadyFinalized": undefined;
    "Overflow": undefined;
    "RuntimeCallFailed": undefined;
    "StakeQueryFailed": undefined;
    "TransferFailed": undefined;
    "StakeConsolidationFailed": undefined;
    "CodeUpgradeFailed": undefined;
    "InvalidRequestId": undefined;
    "RecordNotFinalized": undefined;
    "TTLNotExpired": undefined;
}>;
type T2 = ResultPayload<ResultPayload<undefined, Anonymize<T1>>, Anonymize<T0>>;
type T3 = (FixedSizeBinary<32>) | undefined;
type T7 = ResultPayload<SS58String, Anonymize<T0>>;
type T8 = ResultPayload<number, Anonymize<T0>>;
type T9 = ResultPayload<bigint, Anonymize<T0>>;
type StorageDescriptor = {
    "deposit_requests": {
        "key": FixedSizeBinary<32>;
        "value": Anonymize<T5>;
    };
    "nonce_to_deposit_request_id": {
        "key": bigint;
        "value": FixedSizeBinary<32>;
    };
    "withdrawals": {
        "key": FixedSizeBinary<32>;
        "value": Anonymize<T6>;
    };
    "": {
        "key": undefined;
        "value": {
            "owner": SS58String;
            "chain_id": number;
            "contract_hotkey": SS58String;
            "paused": boolean;
            "guardians": Anonymize<T4>;
            "approve_threshold": number;
            "min_deposit_amount": bigint;
            "next_deposit_nonce": bigint;
            "cleanup_ttl_blocks": number;
        };
    };
};
type MessagesDescriptor = {
    /**
     * User locks Alpha to create a deposit request
     *
     * Creates a deposit request that guardians will observe and attest on Hippius.
     * The caller MUST have added this contract as a proxy on Bittensor.
     * The recipient on Hippius is automatically set to the caller's address.
     *
     * # Arguments
     * * `amount` - Amount of Alpha to lock (in alphaRao)
     * * `hotkey` - Hotkey where the stake is currently held
     */
    "deposit": {
        "message": {
            "amount": bigint;
            "hotkey": SS58String;
        };
        "response": ResultPayload<ResultPayload<FixedSizeBinary<32>, Anonymize<T1>>, Anonymize<T0>>;
        "mutates": true;
    };
    /**
     * Guardian attests a withdrawal (first attestation creates the record)
     *
     * When guardians observe a withdrawal_request on Hippius, they call this
     * to vote for releasing Alpha. First attestation creates the Withdrawal record.
     * When threshold is reached, Alpha is released to recipient.
     *
     * # Arguments
     * * `request_id` - The withdrawal request ID from Hippius
     * * `recipient` - Recipient to release Alpha to
     * * `amount` - Amount to release (in alphaRao)
     * * `nonce` - Nonce from the withdrawal request (used for ID verification)
     */
    "attest_withdrawal": {
        "message": {
            "request_id": FixedSizeBinary<32>;
            "recipient": SS58String;
            "amount": bigint;
            "nonce": bigint;
        };
        "response": Anonymize<T2>;
        "mutates": true;
    };
    /**
     * Admin marks a deposit request as failed
     *
     * After calling this, admin should manually release Alpha via admin_manual_release.
     *
     * NOTE: Intentionally does not check pause state — admin must operate during emergencies.
     *
     * # Arguments
     * * `request_id` - The deposit request ID to fail
     */
    "admin_fail_deposit_request": {
        "message": {
            "request_id": FixedSizeBinary<32>;
        };
        "response": Anonymize<T2>;
        "mutates": true;
    };
    /**
     * Admin manually releases Alpha to a recipient (for stuck deposits)
     *
     * NOTE: Intentionally does not check pause state — admin must operate during emergencies.
     *
     * # Arguments
     * * `recipient` - Account to receive Alpha
     * * `amount` - Amount to release (in alphaRao)
     * * `deposit_request_id` - Optional deposit request ID for audit trail
     */
    "admin_manual_release": {
        "message": {
            "recipient": SS58String;
            "amount": bigint;
            "deposit_request_id"?: Anonymize<T3>;
        };
        "response": Anonymize<T2>;
        "mutates": true;
    };
    /**
     * Admin cancels a withdrawal that is stuck
     *
     * NOTE: Intentionally does not check pause state — admin must operate during emergencies.
     *
     * # Arguments
     * * `request_id` - The withdrawal ID to cancel
     */
    "admin_cancel_withdrawal": {
        "message": {
            "request_id": FixedSizeBinary<32>;
            "reason": Enum<{
                "AdminEmergency": undefined;
            }>;
        };
        "response": Anonymize<T2>;
        "mutates": true;
    };
    /**
     * Configures the guardian set and voting threshold (owner only)
     */
    "set_guardians_and_threshold": {
        "message": {
            "guardians": Anonymize<T4>;
            "approve_threshold": number;
        };
        "response": Anonymize<T2>;
        "mutates": true;
    };
    "pause": {
        "message": {};
        "response": Anonymize<T2>;
        "mutates": true;
    };
    "unpause": {
        "message": {};
        "response": Anonymize<T2>;
        "mutates": true;
    };
    "update_owner": {
        "message": {
            "new_owner": SS58String;
        };
        "response": Anonymize<T2>;
        "mutates": true;
    };
    "set_contract_hotkey": {
        "message": {
            "hotkey": SS58String;
        };
        "response": Anonymize<T2>;
        "mutates": true;
    };
    "set_code": {
        "message": {
            "code_hash": FixedSizeBinary<32>;
        };
        "response": Anonymize<T2>;
        "mutates": true;
    };
    /**
     * Guardian can cleanup a deposit request after TTL (no status check for source records)
     */
    "cleanup_deposit_request": {
        "message": {
            "request_id": FixedSizeBinary<32>;
        };
        "response": Anonymize<T2>;
        "mutates": true;
    };
    /**
     * Guardian can cleanup a finalized withdrawal after TTL
     */
    "cleanup_withdrawal": {
        "message": {
            "withdrawal_id": FixedSizeBinary<32>;
        };
        "response": Anonymize<T2>;
        "mutates": true;
    };
    /**
     * Admin sets the cleanup TTL (in blocks)
     */
    "set_cleanup_ttl": {
        "message": {
            "ttl_blocks": number;
        };
        "response": Anonymize<T2>;
        "mutates": true;
    };
    /**
     * Admin sets the minimum deposit amount
     */
    "set_min_deposit_amount": {
        "message": {
            "amount": bigint;
        };
        "response": Anonymize<T2>;
        "mutates": true;
    };
    "get_deposit_request": {
        "message": {
            "request_id": FixedSizeBinary<32>;
        };
        "response": ResultPayload<(Anonymize<T5>) | undefined, Anonymize<T0>>;
    };
    "get_withdrawal": {
        "message": {
            "withdrawal_id": FixedSizeBinary<32>;
        };
        "response": ResultPayload<(Anonymize<T6>) | undefined, Anonymize<T0>>;
    };
    "get_deposit_request_id_by_nonce": {
        "message": {
            "nonce": bigint;
        };
        "response": ResultPayload<Anonymize<T3>, Anonymize<T0>>;
    };
    "owner": {
        "message": {};
        "response": Anonymize<T7>;
    };
    "chain_id": {
        "message": {};
        "response": Anonymize<T8>;
    };
    "contract_hotkey": {
        "message": {};
        "response": Anonymize<T7>;
    };
    "next_deposit_nonce": {
        "message": {};
        "response": Anonymize<T9>;
    };
    "guardians": {
        "message": {};
        "response": ResultPayload<Anonymize<T4>, Anonymize<T0>>;
    };
    "approve_threshold": {
        "message": {};
        "response": Anonymize<T8>;
    };
    "is_paused": {
        "message": {};
        "response": ResultPayload<boolean, Anonymize<T0>>;
    };
    "min_deposit_amount": {
        "message": {};
        "response": Anonymize<T9>;
    };
    "cleanup_ttl": {
        "message": {};
        "response": ResultPayload<number, Anonymize<T0>>;
    };
};
type ConstructorsDescriptor = {
    /**
     * Creates a new bridge contract instance
     *
     * # Arguments
     * * `owner` - Contract owner with admin privileges
     * * `chain_id` - Identifier for the Bittensor chain (used in ID generation)
     * * `hotkey` - Contract's hotkey for stake consolidation
     */
    "new": {
        "message": {
            "owner": SS58String;
            "chain_id": number;
            "hotkey": SS58String;
        };
        "response": ResultPayload<undefined, Anonymize<T0>>;
    };
};
type EventDescriptor = Enum<{
    /**
     * Emitted when a user creates a deposit request by locking Alpha
     *
     * **Guardian Action Required**: Monitor this event on Bittensor chain.
     * When seen, call attest_deposit on Hippius pallet with:
     * - request_id: deposit_request_id from this event
     * - recipient: sender from this event (sender == recipient)
     * - amount: amount from this event (alphaRao converted to halphaRao)
     * - nonce: deposit_nonce from this event
     */
    "DepositRequestCreated": {
        "deposit_nonce": bigint;
        "sender": SS58String;
        "amount": bigint;
        "deposit_request_id": FixedSizeBinary<32>;
    };
    /**
     * Emitted when admin marks a deposit request as failed
     */
    "DepositRequestFailed": {
        "deposit_request_id": FixedSizeBinary<32>;
    };
    /**
     * Emitted when a guardian attests a withdrawal
     */
    "WithdrawalAttested": {
        "withdrawal_id": FixedSizeBinary<32>;
        "guardian": SS58String;
        /**
         * Current vote count after this attestation
         */
        "vote_count": number;
    };
    /**
     * Emitted when a withdrawal is completed (Alpha released to recipient)
     */
    "WithdrawalCompleted": {
        "withdrawal_id": FixedSizeBinary<32>;
        "recipient": SS58String;
        "amount": bigint;
    };
    /**
     * Emitted when admin cancels a withdrawal
     */
    "WithdrawalCancelled": {
        "withdrawal_id": FixedSizeBinary<32>;
        "reason": Enum<{
            "AdminEmergency": undefined;
        }>;
    };
    /**
     * Emitted when admin manually releases Alpha to a user
     */
    "AdminManualRelease": {
        "recipient": SS58String;
        "amount": bigint;
        /**
         * Optional deposit request ID for audit trail
         */
        "deposit_request_id"?: Anonymize<T3>;
    };
    /**
     * Emitted when guardian set and thresholds are updated
     */
    "GuardiansUpdated": {
        "guardians": Anonymize<T4>;
        "approve_threshold": number;
        "updated_by": SS58String;
    };
    /**
     * Emitted when bridge is paused
     */
    "Paused": {
        "paused_by": SS58String;
    };
    /**
     * Emitted when bridge is unpaused
     */
    "Unpaused": {
        "unpaused_by": SS58String;
    };
    /**
     * Emitted when owner is updated
     */
    "OwnerUpdated": {
        "old_owner": SS58String;
        "new_owner": SS58String;
    };
    /**
     * Emitted when contract hotkey is updated
     */
    "ContractHotkeyUpdated": {
        "old_hotkey": SS58String;
        "new_hotkey": SS58String;
        "updated_by": SS58String;
    };
    /**
     * Emitted when contract code is upgraded
     */
    "CodeUpgraded": {
        "code_hash": FixedSizeBinary<32>;
        "upgraded_by": SS58String;
    };
    /**
     * Emitted when a deposit request is cleaned up after TTL
     */
    "DepositRequestCleanedUp": {
        "deposit_request_id": FixedSizeBinary<32>;
    };
    /**
     * Emitted when a withdrawal is cleaned up after TTL
     */
    "WithdrawalCleanedUp": {
        "withdrawal_id": FixedSizeBinary<32>;
    };
    /**
     * Emitted when the cleanup TTL is updated
     */
    "CleanupTTLUpdated": {
        "old_ttl": number;
        "new_ttl": number;
    };
    /**
     * Emitted when the minimum deposit amount is updated
     */
    "MinDepositAmountUpdated": {
        "old_amount": bigint;
        "new_amount": bigint;
    };
}>;
export declare const descriptor: InkDescriptors<StorageDescriptor, MessagesDescriptor, ConstructorsDescriptor, EventDescriptor>;
export {};
