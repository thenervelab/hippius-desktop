/**
 * Bridge Types
 * 
 * Type definitions for the Alpha Bridge integration.
 */

import type { BridgeDirection, BridgeTransactionStatus } from './config';
import type { BridgeStep, StakedHotkey } from './service';

// Re-export so consumers can import `BridgeStep` / `StakedHotkey` from
// `./types` even though the values live in `./service` (avoids a
// circular-import hazard if `./service` ever pulls from here).
export type { BridgeStep, StakedHotkey };

// Re-export types from config for convenience
export type { BridgeDirection, BridgeTransactionStatus } from './config';

// Signer abstraction for polkadot-api
export interface BridgeSigner {
    address: string;
    sign: (payload: Uint8Array) => Promise<Uint8Array>;
    // The polkadot-api compatible signer from the extension
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    polkadotSigner: any;
}

// Bridge operation request
export interface BridgeRequest {
    direction: BridgeDirection;
    amount: bigint;
    senderAddress: string;
    recipientAddress?: string; // Optional - defaults to sender address
    hotkey?: string; // Optional - validator hotkey for Alpha→hAlpha deposits
    /** Optional local keypair — signs transactions without wallet extension popup.
     *  Sign can return a Uint8Array OR a Promise<Uint8Array> so the desktop's
     *  Rust-backed signer (which IPC-calls into local_wallet_sign) fits the
     *  same shape as web's in-renderer Sr25519 pair without forcing a sync
     *  cross-thread bridge. polkadot-api's `getPolkadotSigner` already
     *  awaits the return value. */
    keypair?: {
        publicKey: Uint8Array;
        sign: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;
    };
}

// Bridge operation result
export interface BridgeResult {
    success: boolean;
    txHash?: string;
    error?: string;
    bridgeTransactionId?: string;
}

// Guardian attestation
export interface GuardianAttestation {
    guardianId: string;
    signature: string;
    timestamp: number;
}

// Bridge event from chain
export interface BridgeEvent {
    type: 'Deposited' | 'Minted' | 'Burned' | 'Unlocked' | 'AttestationReceived';
    data: {
        amount?: bigint;
        account?: string;
        netuid?: number;
        validator?: string;
        bridgeId?: string;
        guardian?: string;
        attestation?: Uint8Array;
    };
    blockNumber: number;
    txHash: string;
}

// Chain balance info
export interface ChainBalance {
    free: bigint;
    reserved: bigint;
    frozen: bigint;
    transferable: bigint;
}

// Bridge state
export interface BridgeState {
    isConnected: boolean;
    bittensorConnected: boolean;
    hippiusConnected: boolean;
    currentBlock: {
        bittensor: number;
        hippius: number;
    };
}

// Transaction tracking
export interface TrackedTransaction {
    id: string;
    direction: BridgeDirection;
    status: BridgeTransactionStatus;
    amount: bigint;
    /** 
     * Number of decimals for the amount field.
     * - API data: Always 18 (hAlpha native units)
     * - Local Alpha→hAlpha: 9 (Alpha decimals)
     * - Local hAlpha→Alpha: 18 (hAlpha decimals)
     * If not set, defaults to direction-based decimals for backwards compatibility.
     */
    amountDecimals?: number;
    senderAddress: string;
    recipientAddress: string;
    sourceTxHash?: string;
    destinationTxHash?: string;
    depositId?: string; // Bridge deposit ID from the contract (deposit_request_id)
    withdrawalId?: string; // Bridge withdrawal ID for hAlpha to Alpha (from WithdrawalRequests)
    burnId?: string; // Legacy: Bridge burn ID for hAlpha to Alpha (kept for backwards compatibility)
    createdAt: number;
    updatedAt: number;
    error?: string;
    attestations: number; // Number of guardian attestations received
    requiredAttestations: number; // Total required for completion
    // Enhanced event tracking
    events: BridgeTransactionEvent[];
    denialReason?: string; // Reason for denial if applicable
    refunded?: boolean; // Whether funds were refunded
    initialBalance?: bigint; // Initial balance at transaction start (for balance-based detection)
}

// Event that occurred during bridge transaction
export interface BridgeTransactionEvent {
    type:
    // Common status events
    | 'Submitted' | 'Error' | 'Processing' | 'UnknownStatus' | 'Completed'
    // Withdrawal flow events (hAlpha → Alpha) - new naming
    | 'WithdrawalRequested' | 'WithdrawalCompleted' | 'WithdrawalDenied' | 'WithdrawalApproved' | 'WithdrawalAttested' | 'WithdrawalExpired' | 'WithdrawalCreated'
    // Withdrawal flow events (hAlpha → Alpha) - legacy naming
    | 'UnlockRequested' | 'UnlockAttested' | 'UnlockApproved' | 'UnlockDenied' | 'UnlockCompleted' | 'UnlockExpired'
    // Deposit flow events (Alpha → hAlpha) - new naming
    | 'DepositRequestCreated' | 'DepositCompleted' | 'DepositDenied'
    // Deposit flow events (Alpha → hAlpha) - legacy naming
    | 'DepositsProposed' | 'DepositAttested' | 'DepositExpired' | 'BridgeMinted' | 'BridgeDenied'
    // Transfer event (for refunds)
    | 'Transfer'
    // Timeout warning
    | 'TimeoutWarning'
    // Deprecated aliases
    | 'attested' | 'deposit_attested';
    timestamp: number;
    message: string;
    data?: Record<string, unknown>;
}

// Hook return types
export interface UseBridgeReturn {
    // State
    isLoading: boolean;
    isConnected: boolean;
    isInitializing: boolean;
    error: string | null;

    // Balances
    alphaBalance: bigint | null;        // Free Alpha balance on Bittensor
    alphaStakeBalance: bigint | null;   // Staked Alpha on Bittensor (where bridged hAlpha goes)
    hAlphaBalance: bigint | null;       // hAlpha balance on Hippius

    // Minimum amounts for bridge validation
    minAlphaTransfer: bigint | null;    // Minimum Alpha amount for hAlpha → Alpha bridge (9 decimals)
    minHAlphaTransfer: bigint | null;   // Minimum hAlpha amount for hAlpha → Alpha bridge (18 decimals)
    isLoadingMinimum: boolean;          // Whether minimum amount is being fetched

    // Staked hotkeys for validator selection
    stakedHotkeys: StakedHotkey[];      // Hotkeys with stake on the configured subnet
    isLoadingHotkeys: boolean;          // Whether hotkeys are being fetched
    refetchHotkeys: () => Promise<unknown>;  // Refetch staked hotkeys

    // Active transactions (in-progress only)
    pendingTransactions: TrackedTransaction[];

    // All transactions (for history display - from API + localStorage)
    allTransactions: TrackedTransaction[];

    // Wizard step progress for in-flight bridge operation
    bridgeSteps: BridgeStep[];
    clearBridgeSteps: () => void;

    // Operations
    bridgeAlphaToHAlpha: (params: { amount: bigint; hotkey?: string }) => Promise<BridgeResult>;
    bridgeHAlphaToAlpha: (amount: bigint) => Promise<BridgeResult>;

    // Queries
    estimateFees: (amount: bigint, direction: BridgeDirection) => Promise<bigint>;
    getTransactionStatus: (txId: string) => Promise<TrackedTransaction | null>;

    // Utilities
    refetch: () => Promise<void>;
    refetchMinimum: () => Promise<void>; // Refetch minimum Alpha transfer amount
}

// Contract message types for AlphaEscrow
export interface AlphaEscrowMessages {
    deposit: {
        netuid: number;
        validatorHotkey: string;
        amount: bigint;
    };
    unlock: {
        account: string;
        amount: bigint;
        signatures: Uint8Array[];
    };
}

// Pallet call types for AlphaBridge on Hippius
export interface AlphaBridgeCalls {
    mint: {
        netuid: number;
        validatorHotkey: string;
        amount: bigint;
        signatures: Uint8Array[];
    };
    burn: {
        netuid: number;
        validatorHotkey: string;
        amount: bigint;
    };
}
