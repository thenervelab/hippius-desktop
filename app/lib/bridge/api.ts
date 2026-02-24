/**
 * Bridge API Service
 *
 * Fetches bridge events from the indexer API and aggregates them into transactions.
 */

import type {
    TrackedTransaction,
    BridgeTransactionEvent,
    BridgeDirection,
    BridgeTransactionStatus,
} from "./types";

// API Configuration - use relative path for internal API route
const INDEXER_API_ROUTE = "/api/indexer/bridge-events";
const NETWORK = process.env.NEXT_PUBLIC_BRIDGE_NETWORK || "testnet";

// API Response Types
export interface IndexerEvent {
    id: number;
    block_number: number;
    event_index: number;
    event_name: string;
    event_data: {
        amount: string;
        burn_id?: string;
        withdrawal_id?: string;
        deposit_id?: string;
        deposit_request_id?: string;
        deposit_ids?: string[];
        requester?: string;
        recipient?: string;
        guardian?: string;
        approved?: boolean;
    };
    extrinsic_hash: string;
    processed_timestamp: string;
}

export interface IndexerResponse {
    data: IndexerEvent[];
    page: number;
    limit: number;
    total: number;
    total_pages: number;
}

/**
 * Fetch bridge events for an account from the indexer API
 */
export async function fetchBridgeEvents(
    address: string,
    page: number = 1,
    limit: number = 10000,
): Promise<IndexerResponse> {
    const url = `${INDEXER_API_ROUTE}?address=${encodeURIComponent(
        address,
    )}&page=${page}&limit=${limit}&network=${encodeURIComponent(NETWORK)}`;

    const response = await fetch(url, {
        method: "GET",
        headers: {
            Accept: "application/json",
        },
        cache: "no-store",
    });

    if (!response.ok) {
        throw new Error(
            `Failed to fetch bridge events: ${response.status} ${response.statusText}`,
        );
    }

    const data = await response.json();
    return data;
}

/**
 * Parse amount string from API (e.g., "11,000,000,000,000,000,000" -> bigint)
 */
function parseAmount(amountStr: string): bigint {
    const cleaned = amountStr.replace(/,/g, "");
    return BigInt(cleaned);
}

// Timeout for transactions stuck in "requested" state (20 minutes)
const STALE_TRANSACTION_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Check if a transaction is stale (stuck without follow-up event)
 */
function isStaleTransaction(events: IndexerEvent[]): boolean {
    if (events.length === 0) return false;

    const sortedEvents = [...events].sort(
        (a, b) => b.block_number - a.block_number,
    );
    const latestEvent = sortedEvents[0];

    const isWaitingForResponse =
        latestEvent.event_name === "UnlockRequested" ||
        latestEvent.event_name === "WithdrawalRequested" ||
        latestEvent.event_name === "WithdrawalCreated" ||
        latestEvent.event_name === "DepositsProposed" ||
        latestEvent.event_name === "DepositRequestCreated" ||
        latestEvent.event_name === "DepositAttested" ||
        latestEvent.event_name === "WithdrawalAttested" ||
        latestEvent.event_name === "UnlockAttested";

    if (!isWaitingForResponse) return false;

    const eventTime = new Date(latestEvent.processed_timestamp).getTime();
    const timeSinceEvent = Date.now() - eventTime;

    return timeSinceEvent > STALE_TRANSACTION_TIMEOUT_MS;
}

/**
 * Determine transaction status based on events
 */
function determineTransactionStatus(
    events: IndexerEvent[],
): BridgeTransactionStatus {
    const sortedEvents = [...events].sort(
        (a, b) => b.block_number - a.block_number,
    );

    const latestEvent = sortedEvents[0];

    if (!latestEvent) return "pending";

    switch (latestEvent.event_name) {
        case "UnlockApproved":
        case "WithdrawalApproved":
        case "WithdrawalCompleted":
        case "BridgeMinted":
        case "DepositCompleted":
            return "completed";

        case "UnlockDenied":
        case "WithdrawalDenied":
        case "BridgeDenied":
        case "DepositExpired":
        case "UnlockExpired":
        case "WithdrawalExpired":
            return "failed";

        case "UnlockRequested":
        case "WithdrawalRequested":
        case "WithdrawalCreated":
        case "DepositsProposed":
        case "DepositRequestCreated":
        case "DepositAttested":
        case "UnlockAttested":
        case "WithdrawalAttested":
            if (isStaleTransaction(events)) {
                return "failed";
            }
            return "processing";

        default:
            return "pending";
    }
}

/**
 * Determine bridge direction based on events
 */
function determineDirection(events: IndexerEvent[]): BridgeDirection {
    const hasWithdrawalId = events.some((e) => e.event_data.burn_id || e.event_data.withdrawal_id);
    const hasDepositId = events.some(
        (e) => e.event_data.deposit_id || e.event_data.deposit_request_id || e.event_data.deposit_ids,
    );

    if (hasWithdrawalId) return "halpha-to-alpha";
    if (hasDepositId) return "alpha-to-halpha";

    const eventNames = events.map((e) => e.event_name);
    if (eventNames.some((name) => name.includes("Unlock") || name.includes("Withdrawal")))
        return "halpha-to-alpha";
    if (eventNames.some((name) => name.includes("Deposit") || name.includes("Minted")))
        return "alpha-to-halpha";

    return "halpha-to-alpha";
}

/**
 * Event ordering priority for proper timeline display
 */
const EVENT_ORDER: Record<string, number> = {
    UnlockRequested: 1,
    WithdrawalRequested: 1,
    WithdrawalCreated: 1,
    UnlockAttested: 2,
    WithdrawalAttested: 2,
    UnlockApproved: 3,
    WithdrawalApproved: 3,
    WithdrawalCompleted: 3,
    UnlockDenied: 3,
    WithdrawalDenied: 3,
    UnlockExpired: 3,
    WithdrawalExpired: 3,

    DepositsProposed: 1,
    DepositRequestCreated: 1,
    DepositAttested: 2,
    BridgeMinted: 3,
    DepositCompleted: 3,
    BridgeDenied: 3,
    DepositExpired: 3,

    TimeoutWarning: 4,
};

/**
 * Sort events by their logical order in the bridge process
 */
function sortEventsByLogicalOrder(events: IndexerEvent[]): IndexerEvent[] {
    return [...events].sort((a, b) => {
        const orderA = EVENT_ORDER[a.event_name] ?? 99;
        const orderB = EVENT_ORDER[b.event_name] ?? 99;

        if (orderA !== orderB) {
            return orderA - orderB;
        }

        return a.block_number - b.block_number;
    });
}

/**
 * Format amount for display (18 decimals)
 */
function formatAmount(amount: bigint): string {
    const decimals = 18;
    const divisor = BigInt(10 ** decimals);
    const whole = amount / divisor;
    const fraction = amount % divisor;
    const fractionStr = fraction.toString().padStart(decimals, "0").slice(0, 4);
    return `${whole}.${fractionStr}`;
}

/**
 * Convert indexer events to BridgeTransactionEvent format
 */
function convertToTransactionEvents(
    events: IndexerEvent[],
): BridgeTransactionEvent[] {
    const sortedEvents = sortEventsByLogicalOrder(events);

    return sortedEvents.map((event) => {
        const timestamp = new Date(event.processed_timestamp).getTime();
        const amount = event.event_data.amount
            ? parseAmount(event.event_data.amount)
            : BigInt(0);
        const formattedAmount = formatAmount(amount);

        let message = "";
        switch (event.event_name) {
            case "UnlockRequested":
            case "WithdrawalRequested":
            case "WithdrawalCreated":
                message = `Withdrawal requested for ${formattedAmount} hAlpha`;
                break;
            case "UnlockAttested":
            case "WithdrawalAttested":
                message = "Guardian attestation received";
                break;
            case "UnlockApproved":
            case "WithdrawalApproved":
            case "WithdrawalCompleted":
                message = `Withdrawal approved! ${formattedAmount} Alpha unlocked on Bittensor`;
                break;
            case "UnlockDenied":
            case "WithdrawalDenied":
                message = `Withdrawal denied. ${formattedAmount} hAlpha refunded`;
                break;
            case "DepositsProposed":
            case "DepositRequestCreated":
                message = `Deposit proposed`;
                break;
            case "DepositAttested":
                message = "Guardian attestation received";
                break;
            case "BridgeMinted":
            case "DepositCompleted":
                message = `${formattedAmount} hAlpha minted on Hippius`;
                break;
            case "BridgeDenied":
                message = `Bridge denied. ${formattedAmount} Alpha refunded on Bittensor`;
                break;
            case "DepositExpired":
                message = `Deposit expired. ${formattedAmount} Alpha refunded on Bittensor`;
                break;
            default:
                message = `${event.event_name}`;
        }

        return {
            type: event.event_name as BridgeTransactionEvent["type"],
            timestamp,
            message,
            data: {
                blockNumber: event.block_number,
                extrinsicHash: event.extrinsic_hash,
                eventIndex: event.event_index,
                ...event.event_data,
            },
        };
    });
}

/**
 * Aggregate events into transactions
 */
export function aggregateEventsToTransactions(
    events: IndexerEvent[],
): TrackedTransaction[] {
    const transactionMap = new Map<string, IndexerEvent[]>();

    for (const event of events) {
        const burnId = event.event_data.burn_id || event.event_data.withdrawal_id;
        const depositId = event.event_data.deposit_id || event.event_data.deposit_request_id;
        const depositIds = event.event_data.deposit_ids;

        if (depositIds && Array.isArray(depositIds)) {
            for (const id of depositIds) {
                if (!transactionMap.has(id)) {
                    transactionMap.set(id, []);
                }
                transactionMap.get(id)!.push(event);
            }
            continue;
        }

        const key = burnId || depositId;
        if (!key) {
            console.warn("[BridgeAPI] Event without burn_id/withdrawal_id or deposit_id/deposit_request_id:", event);
            continue;
        }

        if (!transactionMap.has(key)) {
            transactionMap.set(key, []);
        }
        transactionMap.get(key)!.push(event);
    }

    const transactions: TrackedTransaction[] = [];

    for (const [key, txEvents] of transactionMap) {
        txEvents.sort((a, b) => a.block_number - b.block_number);

        const hasInitiatingEvent = txEvents.some(
            (e) =>
                e.event_name === "UnlockRequested" ||
                e.event_name === "WithdrawalRequested" ||
                e.event_name === "WithdrawalCreated" ||
                e.event_name === "DepositsProposed" ||
                e.event_name === "DepositRequestCreated",
        );

        const hasOnlyBridgeMinted =
            !hasInitiatingEvent &&
            txEvents.some((e) => e.event_name === "BridgeMinted" || e.event_name === "DepositCompleted");

        if (!hasInitiatingEvent && !hasOnlyBridgeMinted) {
            console.log(
                "[BridgeAPI] Skipping transaction without valid events:",
                key,
                "Events:",
                txEvents.map((e) => e.event_name).join(", "),
            );
            continue;
        }

        const firstEvent = txEvents[0];
        const latestEvent = txEvents[txEvents.length - 1];

        const direction = hasOnlyBridgeMinted
            ? "alpha-to-halpha"
            : determineDirection(txEvents);
        const status = determineTransactionStatus(txEvents);

        const address =
            txEvents.find((e) => e.event_data.requester)?.event_data.requester ||
            txEvents.find((e) => e.event_data.recipient)?.event_data.recipient ||
            "";

        const eventWithAmount =
            txEvents.find((e) => e.event_data.amount) || firstEvent;
        const amount = eventWithAmount.event_data?.amount
            ? parseAmount(eventWithAmount.event_data.amount)
            : BigInt(0);

        const depositIdValue =
            txEvents.find((e) => e.event_data.deposit_id || e.event_data.deposit_request_id)?.event_data.deposit_id ||
            txEvents.find((e) => e.event_data.deposit_request_id)?.event_data.deposit_request_id ||
            (direction === "alpha-to-halpha" ? key : undefined);

        const burnOrWithdrawalId =
            firstEvent.event_data.burn_id ||
            firstEvent.event_data.withdrawal_id ||
            txEvents.find((e) => e.event_data.burn_id || e.event_data.withdrawal_id)?.event_data.burn_id ||
            txEvents.find((e) => e.event_data.withdrawal_id)?.event_data.withdrawal_id;

        const transaction: TrackedTransaction = {
            id: key,
            direction,
            status,
            amount,
            amountDecimals: 18,
            senderAddress: address,
            recipientAddress: address,
            sourceTxHash: firstEvent.extrinsic_hash,
            burnId: burnOrWithdrawalId,
            withdrawalId: burnOrWithdrawalId,
            depositId: depositIdValue,
            createdAt: new Date(firstEvent.processed_timestamp).getTime(),
            updatedAt: new Date(latestEvent.processed_timestamp).getTime(),
            events: convertToTransactionEvents(txEvents),
            attestations: txEvents.filter(
                (e) =>
                    e.event_name === "UnlockAttested" ||
                    e.event_name === "WithdrawalAttested" ||
                    e.event_name === "DepositAttested",
            ).length,
            requiredAttestations: 3,
        };

        transactions.push(transaction);
    }

    return transactions.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Fetch and aggregate all transactions for an address
 */
export async function fetchTransactions(address: string): Promise<TrackedTransaction[]> {
    try {
        const response = await fetchBridgeEvents(address);
        return aggregateEventsToTransactions(response.data);
    } catch (error) {
        console.error("[BridgeAPI] Failed to fetch transactions:", error);
        return [];
    }
}
