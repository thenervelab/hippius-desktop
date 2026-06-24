/**
 * Bridge Configuration
 * 
 * Configuration for the Alpha Bridge between Bittensor and Hippius chains.
 * This enables bridging between Alpha (on Bittensor) and hAlpha (on Hippius).
 */

export const BRIDGE_CONFIG = {
    // Chain WebSocket URLs
    bittensor: {
        wsUrl: process.env.NEXT_PUBLIC_BITTENSOR_WS_URL || 'wss://tao-testnet.hippicode.com',
        name: 'Bittensor Testnet',
    },
    hippius: {
        wsUrl: process.env.NEXT_PUBLIC_HIPPIUS_WS_URL || 'wss://hippius-testnet.starkleytech.com',
        name: 'Hippius',
    },
    // Hippius testnet for hAlpha balance (separate from main hippius for flexibility)
    hippiusTestnet: {
        wsUrl: process.env.NEXT_PUBLIC_HIPPIUS_TESTNET_WS_URL || 'wss://hippius-testnet.starkleytech.com',
        name: 'Hippius Testnet',
    },

    // Bridge Contract on Bittensor Testnet (AlphaEscrow)
    contract: {
        // Contract address on Bittensor testnet
        address: process.env.NEXT_PUBLIC_BRIDGE_CONTRACT_ADDRESS || '5CXnPB8eTkHKTWdZCuB1Ha1kVQENEupnvjgaDzzfQqbURrqm',
    },

    // Default validator configuration for bridging
    // These can be overridden by user selection in the UI
    defaultValidator: {
        hotkey: process.env.NEXT_PUBLIC_BRIDGE_VALIDATOR_HOTKEY || '5FPD6YkHFL7PU6H8UQFaf4ahcMqum6DW8uDgBZnPd6ysrecc',
        netuid: parseInt(process.env.NEXT_PUBLIC_BRIDGE_NETUID || '2', 10),
    },

    // Token configuration
    tokens: {
        alpha: {
            symbol: 'ALPHA',
            decimals: 9,
            chain: 'bittensor',
        },
        hAlpha: {
            symbol: 'hALPHA',
            decimals: 18,
            chain: 'hippius',
        },
    },

    // Timing configuration
    timing: {
        // Estimated bridge time in seconds
        estimatedTimeSeconds: 120,
        // Poll interval for transaction status
        pollIntervalMs: 5000,
        // Maximum wait time for guardian confirmations
        maxWaitTimeMs: 300000, // 5 minutes
    },
} as const;

// Bridge direction types
export type BridgeDirection = 'alpha-to-halpha' | 'halpha-to-alpha';

// Bridge transaction status
export type BridgeTransactionStatus =
    | 'pending'           // Transaction submitted, waiting for confirmation
    | 'confirmed'         // Transaction confirmed on source chain
    | 'processing'        // Guardians processing the bridge
    | 'completed'         // Bridge completed on destination chain
    | 'failed'            // Bridge failed
    | 'unknown';          // Status unknown after timeout - transaction may have succeeded or failed

// Bridge transaction interface
export interface BridgeTransaction {
    id: string;
    direction: BridgeDirection;
    sourceChain: 'bittensor' | 'hippius';
    destinationChain: 'bittensor' | 'hippius';
    amount: bigint;
    senderAddress: string;
    recipientAddress: string;
    status: BridgeTransactionStatus;
    sourceTxHash?: string;
    destinationTxHash?: string;
    createdAt: Date;
    updatedAt: Date;
    error?: string;
}
