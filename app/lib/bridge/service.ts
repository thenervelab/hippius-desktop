/**
 * Bridge Service
 *
 * Architecture:
 * - Bittensor chain: contract deposit (proxy → dry-run → send), balance queries (TAO + Alpha stake)
 * - Hippius chain:   withdrawal via AlphaBridge pallet, hAlpha balance queries
 * - Direct polkadot-api + @polkadot-api/sdk-ink usage
 */

import { createClient, FixedSizeBinary, type PolkadotClient, type SS58String } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws-provider/web';
import { withPolkadotSdkCompat } from 'polkadot-api/polkadot-sdk-compat';
import { getPolkadotSigner } from 'polkadot-api/signer';
import { hippius, bittensor, contracts, MultiAddress } from '@polkadot-api/descriptors';
import { createInkV5Sdk } from '@polkadot-api/sdk-ink';
import { BRIDGE_CONFIG, calculateBridgeFee, calculateReceivedAmount } from './config';
import type { BridgeRequest, BridgeResult, TrackedTransaction, BridgeTransactionEvent } from './types';
import { createPolkadotApiSigner } from './signer';

// ---------------------------------------------------------------------------
// Step progress callback for wizard UI
// ---------------------------------------------------------------------------

export type BridgeStepState = 'pending' | 'active' | 'done' | 'error';

export interface BridgeStep {
    /** Step number (1-based) */
    step: number;
    /** Short label for the step */
    label: string;
    /** Detailed description */
    detail: string;
    /** Current state */
    state: BridgeStepState;
}

export type OnStepCallback = (steps: BridgeStep[]) => void;

// ---------------------------------------------------------------------------
// Timeout helper — prevents signAndSubmit / WS calls from hanging forever
// ---------------------------------------------------------------------------
const TX_TIMEOUT_MS = 120_000; // 2 minutes per on-chain step
const QUERY_TIMEOUT_MS = 30_000; // 30 seconds for queries

function withTimeout<T>(promise: Promise<T>, ms: number, label = 'Operation'): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
        ),
    ]);
}

// Transaction options — use "best" to avoid waiting for finalization
// which can hang indefinitely on slow or stalled chains.
const TX_OPTIONS = { at: 'best' as const };

// ---------------------------------------------------------------------------
// Chain clients (lazy singletons)
// ---------------------------------------------------------------------------

let hippiusClient: PolkadotClient | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let hippiusApi: any = null;

let bittensorClient: PolkadotClient | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bittensorApi: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bridgeContract: any = null;

function ensureHippius(): void {
    if (hippiusClient) return;
    const provider = withPolkadotSdkCompat(getWsProvider(BRIDGE_CONFIG.hippius.wsUrl));
    hippiusClient = createClient(provider);
    hippiusApi = hippiusClient.getTypedApi(hippius);
}

function ensureBittensor(): void {
    if (bittensorClient) return;
    const provider = withPolkadotSdkCompat(getWsProvider(BRIDGE_CONFIG.bittensor.wsUrl));
    bittensorClient = createClient(provider);
    bittensorApi = bittensorClient.getTypedApi(bittensor);
    const sdk = createInkV5Sdk(bittensorApi, contracts.bridge);
    bridgeContract = sdk.getContract(BRIDGE_CONFIG.contract.address as SS58String);
}

// ---------------------------------------------------------------------------
// Initialisation / teardown
// ---------------------------------------------------------------------------

export async function initializeBridge(): Promise<void> {
    console.log('[BridgeService] Initializing bridge connections...');
    ensureHippius();
    ensureBittensor();
    console.log('[BridgeService] Bridge initialized successfully');
}

export async function disconnectBridge(): Promise<void> {
    if (hippiusClient) { hippiusClient.destroy(); hippiusClient = null; hippiusApi = null; }
    if (bittensorClient) { bittensorClient.destroy(); bittensorClient = null; bittensorApi = null; bridgeContract = null; }
    console.log('[BridgeService] Disconnected');
}

// ---------------------------------------------------------------------------
// Balance queries  (matches Explorer's getBittensorBalances + getHippiusBalance)
// ---------------------------------------------------------------------------

export interface BittensorBalances {
    tao: bigint;
    alpha: bigint; // stake on configured netuid
}

/**
 * Get Bittensor balances: TAO (free) and Alpha stake on the configured subnet.
 *
 * Mirrors Explorer's `getBittensorBalances()` which uses
 * `StakeInfoRuntimeApi.get_stake_info_for_coldkey` to sum alpha across hotkeys.
 */
export interface StakedHotkey {
    hotkey: string;
    stake: bigint;
}

export async function getStakedHotkeys(address: string): Promise<StakedHotkey[]> {
    ensureBittensor();
    const stakeEntries = await bittensorApi.apis.StakeInfoRuntimeApi.get_stake_info_for_coldkey(
        address as SS58String,
    );
    const hotkeys: StakedHotkey[] = [];
    for (const entry of stakeEntries) {
        if (entry.netuid === BRIDGE_CONFIG.defaultValidator.netuid && (entry.stake as bigint) > BigInt(0)) {
            hotkeys.push({ hotkey: entry.hotkey as string, stake: entry.stake as bigint });
        }
    }
    // Sort by stake descending
    hotkeys.sort((a, b) => (b.stake > a.stake ? 1 : b.stake < a.stake ? -1 : 0));
    return hotkeys;
}

export async function getBittensorBalances(address: string): Promise<BittensorBalances> {
    ensureBittensor();

    const [acctInfo, stakeEntries] = await Promise.all([
        bittensorApi.query.System.Account.getValue(address as SS58String),
        bittensorApi.apis.StakeInfoRuntimeApi.get_stake_info_for_coldkey(address as SS58String),
    ]);

    const tao = acctInfo.data.free as bigint;

    let alpha = BigInt(0);
    console.log(`[BridgeService] Stake entries for ${address}: ${stakeEntries.length} entries, filtering for netuid=${BRIDGE_CONFIG.defaultValidator.netuid}`);
    for (const entry of stakeEntries) {
        console.log(`[BridgeService]   netuid=${entry.netuid} hotkey=${entry.hotkey} stake=${entry.stake}`);
        if (entry.netuid === BRIDGE_CONFIG.defaultValidator.netuid) {
            alpha += entry.stake as bigint;
        }
    }
    console.log(`[BridgeService] Balances: tao=${tao}, alpha(stake on netuid ${BRIDGE_CONFIG.defaultValidator.netuid})=${alpha}`);

    return { tao, alpha };
}

/**
 * Get hAlpha free balance on Hippius.
 * Mirrors Explorer's `getHippiusBalance()`.
 */
export async function getHippiusBalance(address: string): Promise<bigint> {
    ensureHippius();
    const acctInfo = await hippiusApi.query.System.Account.getValue(address as SS58String);
    return acctInfo.data.free as bigint;
}

// Convenience wrappers matching the old API surface --------------------------

export async function getHAlphaBalance(address: string): Promise<bigint> {
    return getHippiusBalance(address);
}

export async function getAlphaBalance(address: string): Promise<bigint> {
    ensureBittensor();
    const acctInfo = await bittensorApi.query.System.Account.getValue(address as SS58String);
    const free = acctInfo.data.free as bigint;
    const frozen = BigInt((acctInfo.data.frozen ?? BigInt(0)).toString());
    const transferable = free - frozen;
    return transferable > BigInt(0) ? transferable : BigInt(0);
}

export async function getAlphaStakeBalance(address: string): Promise<bigint> {
    const { alpha } = await getBittensorBalances(address);
    return alpha;
}

export async function getBalances(address: string): Promise<{
    alpha: bigint;
    alphaStake: bigint;
    hAlpha: bigint;
}> {
    const [btBal, hAlpha] = await Promise.all([
        getBittensorBalances(address),
        getHippiusBalance(address),
    ]);
    return { alpha: btBal.tao, alphaStake: btBal.alpha, hAlpha };
}

// ---------------------------------------------------------------------------
// User cancellation detection
// ---------------------------------------------------------------------------

function isUserCancellation(message: string): boolean {
    const lower = message.toLowerCase();
    return (
        lower.includes('cancelled') ||
        lower.includes('canceled') ||
        lower.includes('rejected') ||
        lower.includes('user rejected') ||
        lower.includes('user denied') ||
        lower.includes('request denied')
    );
}

// ---------------------------------------------------------------------------
// Contract helpers (same patterns as Explorer's bittensor-tx.ts)
// ---------------------------------------------------------------------------

function doubleGas(gas: { ref_time: bigint; proof_size: bigint }): { ref_time: bigint; proof_size: bigint } {
    return {
        ref_time: BigInt(gas.ref_time) * BigInt(2),
        proof_size: BigInt(gas.proof_size) * BigInt(2),
    };
}

function clampStorageDeposit(deposit: bigint | number): bigint {
    const val = BigInt(deposit);
    return val < BigInt(0) ? BigInt(0) : val;
}

const CONTRACT_ERROR_VARIANTS: string[] = [
    'Unauthorized',                      // 0
    'NotGuardian',                       // 1
    'AlreadyVoted',                      // 2
    'InsufficientStake',                 // 3
    'TransferNotVerified',               // 4
    'InsufficientContractStake',         // 5
    'AmountTooSmall',                    // 6
    'InvalidThresholds',                 // 7
    'TooManyGuardians',                  // 8
    'InvalidWithdrawalDetails',          // 9
    'InvalidTTL',                        // 10
    'BridgePaused',                      // 11
    'DepositRequestNotFound',            // 12
    'WithdrawalNotFound',                // 13
    'DepositRequestAlreadyFinalized',    // 14
    'WithdrawalAlreadyFinalized',        // 15
    'Overflow',                          // 16
    'RuntimeCallFailed',                 // 17
    'StakeQueryFailed',                  // 18
    'TransferFailed',                    // 19
    'StakeConsolidationFailed',          // 20
    'CodeUpgradeFailed',                 // 21
    'InvalidRequestId',                  // 22
    'RecordNotFinalized',                // 23
    'TTLNotExpired',                     // 24
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dryRunReason(value: any): string {
    if (!value) return 'unknown (null value)';
    const type = value?.type as string | undefined;
    if (!type) return `unknown (keys: ${Object.keys(value).join(',')})`;
    if (type !== 'FlagReverted') return type;

    // sdk-ink v0.6: value = { type: 'FlagReverted', value: { message, raw, gasRequired, storageDeposit, send } }
    const inner = value?.value;
    const message = inner?.message;
    const raw = inner?.raw;

    console.log('[BridgeService] FlagReverted details:', {
        messageType: typeof message,
        messageValue: typeof message === 'string' ? message : message?.asHex?.() ?? String(message),
        rawType: typeof raw,
        rawValue: typeof raw === 'string' ? raw : raw?.asHex?.() ?? String(raw),
        innerKeys: inner ? Object.keys(inner) : 'null',
    });

    // Extract hex strings from message and raw (could be string, Binary object, etc.)
    const hexCandidates: string[] = [];
    for (const src of [message, raw]) {
        if (!src) continue;
        if (typeof src === 'string') {
            hexCandidates.push(src);
        } else {
            // Binary object — try asHex, then asBytes directly
            if (typeof src.asHex === 'function') hexCandidates.push(src.asHex());
            if (typeof src.asBytes === 'function') {
                const bytes: Uint8Array = src.asBytes();
                // Manual byte-level decode for ink Result<Result<T, ContractError>, LangError>
                // Pattern: [0x00 (Ok)] [0x01 (Err)] [variant_index]
                if (bytes.length >= 3 && bytes[0] === 0x00 && bytes[1] === 0x01) {
                    const idx = bytes[2];
                    return CONTRACT_ERROR_VARIANTS[idx] ?? `ContractError(variant=${idx})`;
                }
                // Pattern: [0x01] [0x01 = CouldNotReadInput] — LangError
                if (bytes.length >= 2 && bytes[0] === 0x01) {
                    return 'LangError::CouldNotReadInput (ABI mismatch or encoding error)';
                }
                // Pattern: [0x00] [variant_index]
                if (bytes.length >= 2 && bytes[0] === 0x00) {
                    const idx = bytes[1];
                    if (CONTRACT_ERROR_VARIANTS[idx]) return CONTRACT_ERROR_VARIANTS[idx];
                }
                // Single byte
                if (bytes.length === 1 && CONTRACT_ERROR_VARIANTS[bytes[0]]) {
                    return CONTRACT_ERROR_VARIANTS[bytes[0]];
                }
            }
        }
    }

    // Try hex pattern matching on all candidates
    for (const hex of hexCandidates) {
        if (!hex.startsWith('0x')) continue;
        // 0x00 01 XX — Result::Ok(Result::Err(variant))
        const m1 = hex.match(/^0x0001([0-9a-f]{2})/i);
        if (m1?.[1]) {
            const idx = parseInt(m1[1], 16);
            return CONTRACT_ERROR_VARIANTS[idx] ?? `FlagReverted(variant=${idx})`;
        }
        // 0x01 XX — LangError
        if (hex.startsWith('0x01')) {
            return 'LangError::CouldNotReadInput (check ABI compatibility)';
        }
        // 0x00 XX — direct variant
        const m2 = hex.match(/^0x00([0-9a-f]{2})/i);
        if (m2?.[1]) {
            const idx = parseInt(m2[1], 16);
            return CONTRACT_ERROR_VARIANTS[idx] ?? `FlagReverted(variant=${idx})`;
        }
    }

    // If message is a human-readable string, return it directly
    const msgStr = typeof message === 'string' ? message : message?.asText?.();
    if (msgStr && typeof msgStr === 'string' && !msgStr.startsWith('0x') && msgStr.length > 2) {
        return `FlagReverted: ${msgStr}`;
    }

    return `FlagReverted (raw: ${hexCandidates.join(', ') || 'none'})`;
}

function truncHash(hash: string): string {
    if (hash.length <= 16) return hash;
    return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

// ---------------------------------------------------------------------------
// localStorage-backed transaction store
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'hippius_bridge_transactions';
const MAX_STORED_TX = 50;

function loadFromStorage(): Map<string, TrackedTransaction> {
    if (typeof window === 'undefined') return new Map();
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return new Map();
        const arr: TrackedTransaction[] = JSON.parse(raw, (_key, value) => {
            // Restore bigint fields stored as strings with a 'n' suffix
            if (typeof value === 'string' && /^\d+n$/.test(value)) {
                return BigInt(value.slice(0, -1));
            }
            return value;
        });
        const map = new Map<string, TrackedTransaction>();
        for (const tx of arr) map.set(tx.id, tx);
        return map;
    } catch {
        return new Map();
    }
}

function saveToStorage(txMap: Map<string, TrackedTransaction>): void {
    if (typeof window === 'undefined') return;
    try {
        // Keep only the most recent MAX_STORED_TX transactions
        const arr = Array.from(txMap.values())
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, MAX_STORED_TX);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(arr, (_key, value) => {
            if (typeof value === 'bigint') return value.toString() + 'n';
            return value;
        }));
    } catch { /* quota exceeded or similar */ }
}

const transactions: Map<string, TrackedTransaction> = loadFromStorage();
type TxUpdateCallback = (_tx: TrackedTransaction) => void;
const subscribers: Set<TxUpdateCallback> = new Set();

function notify(tx: TrackedTransaction) {
    saveToStorage(transactions);
    subscribers.forEach(cb => { try { cb(tx); } catch { /* */ } });
}

function generateTxId(): string {
    return `bridge_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function addEvent(txId: string, event: Omit<BridgeTransactionEvent, 'timestamp'>): void {
    const tx = transactions.get(txId);
    if (!tx) return;
    tx.events = tx.events || [];
    tx.events.push({ ...event, timestamp: Date.now() });
    tx.updatedAt = Date.now();
    transactions.set(txId, tx);
    notify(tx);
}

function updateTx(txId: string, update: Partial<TrackedTransaction>): void {
    const tx = transactions.get(txId);
    if (!tx) return;
    Object.assign(tx, update, { updatedAt: Date.now() });
    transactions.set(txId, tx);
    notify(tx);
}

// ---------------------------------------------------------------------------
// Bridge: Alpha → hAlpha  (Deposit via contract on Bittensor)
// ---------------------------------------------------------------------------

/**
 * Bridge Alpha to hAlpha.
 *
 * Flow (matches Explorer's `startDepositFlow`):
 *  1. Add escrow contract as proxy on Bittensor
 *  2. Dry-run `deposit` via contract.query
 *  3. Submit `deposit` via contract.send
 *  4. Remove escrow proxy (best-effort)
 *
 * After submission, guardians detect the deposit and mint hAlpha on Hippius.
 */
export async function bridgeAlphaToHAlpha(
    request: BridgeRequest,
    onStep?: OnStepCallback,
): Promise<BridgeResult> {
    const txId = generateTxId();
    const recipient = request.recipientAddress || request.senderAddress;

    const trackedTx: TrackedTransaction = {
        id: txId,
        direction: 'alpha-to-halpha',
        status: 'pending',
        amount: request.amount,
        senderAddress: request.senderAddress,
        recipientAddress: recipient,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attestations: 0,
        requiredAttestations: 3,
        events: [{ type: 'Submitted', timestamp: Date.now(), message: 'Starting bridge…' }],
    };
    transactions.set(txId, trackedTx);
    notify(trackedTx);

    // Wizard step labels — declared outside try so catch can mark errors
    const STEP_LABELS = [
        'Add Escrow as Proxy',
        'Dry Run Deposit',
        'Submit Deposit',
        'Remove Escrow Proxy',
    ];

    const steps: BridgeStep[] = STEP_LABELS.map((label, i) => ({
        step: i + 1,
        label,
        detail: '',
        state: 'pending' as BridgeStepState,
    }));

    function setStep(idx: number, state: BridgeStepState, detail: string) {
        steps[idx] = { ...steps[idx], state, detail };
        onStep?.([...steps]);
    }

    try {
        // Build the polkadot-api PolkadotSigner.
        // If a local keypair is available (mnemonic session), create a signer from it
        // — this signs all 4 steps automatically without any wallet extension popup.
        // Otherwise fall back to the extension-based signer.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let paSigner: any;
        if (request.keypair) {
            paSigner = getPolkadotSigner(
                request.keypair.publicKey,
                'Sr25519',
                (payload: Uint8Array) => request.keypair!.sign(payload),
            );
            console.log('[BridgeService] Using local keypair signer (no wallet popup)');
        } else {
            const extSigner = await createPolkadotApiSigner(request.senderAddress);
            paSigner = extSigner.polkadotSigner;
            console.log('[BridgeService] Using extension signer (will prompt wallet)');
        }
        ensureBittensor();

        const origin = request.senderAddress as SS58String;
        const hotkey = (request.hotkey || BRIDGE_CONFIG.defaultValidator.hotkey) as SS58String;

        // Step 1: Add proxy --------------------------------------------------
        setStep(0, 'active', `Adding escrow ${truncHash(BRIDGE_CONFIG.contract.address)} as proxy…`);
        addEvent(txId, { type: 'Submitted', message: 'Step 1/4: Adding escrow as proxy…' });
        console.log('[BridgeService] Step 1: add_proxy for delegate:', BRIDGE_CONFIG.contract.address);

        try {
            const proxyTx = bittensorApi.tx.Proxy.add_proxy({
                delegate: MultiAddress.Id(BRIDGE_CONFIG.contract.address as SS58String),
                proxy_type: { type: 'Any', value: undefined },
                delay: 0,
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const proxyResult: any = await withTimeout(
                proxyTx.signAndSubmit(paSigner, TX_OPTIONS),
                TX_TIMEOUT_MS,
                'add_proxy',
            );
            console.log('[BridgeService] add_proxy result ok:', proxyResult.ok);
            if (!proxyResult.ok) {
                const errStr = JSON.stringify(proxyResult.dispatchError);
                if (!errStr.includes('Duplicate')) throw new Error(`add_proxy failed: ${errStr}`);
            }
        } catch (e) {
            const msg = (e as Error).message;
            if (!msg.includes('Duplicate')) {
                setStep(0, 'error', msg);
                throw e;
            }
            // proxy already set — fine
            console.log('[BridgeService] Proxy already set (duplicate), continuing');
        }
        setStep(0, 'done', 'Proxy added successfully');

        // Step 2: Pre-flight + Dry-run deposit --------------------------------
        setStep(1, 'active', 'Running dry-run deposit…');
        addEvent(txId, { type: 'Submitted', message: 'Step 2/4: Running dry-run…' });

        // Pre-flight: verify the contract is reachable and the ABI matches
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pausedResult: any = await withTimeout(
                bridgeContract.query('is_paused', { origin }),
                QUERY_TIMEOUT_MS,
                'is_paused pre-flight',
            );
            console.log('[BridgeService] Contract is_paused result:', JSON.stringify(pausedResult, (_: string, v: unknown) => typeof v === 'bigint' ? v.toString() : v));
            const isPaused = pausedResult?.value?.response?.value === true
                || pausedResult?.value?.response === true
                || pausedResult?.value === true;
            if (isPaused) {
                throw new Error('Bridge contract is currently paused. Deposits are disabled.');
            }
            console.log('[BridgeService] Contract is NOT paused, proceeding with deposit dry-run');
        } catch (preflight) {
            const pfMsg = (preflight as Error).message;
            if (pfMsg.includes('paused')) {
                setStep(1, 'error', pfMsg);
                throw preflight;
            }
            console.error('[BridgeService] Pre-flight is_paused query failed:', pfMsg);
            console.error(`[BridgeService] Config: contract=${BRIDGE_CONFIG.contract.address}, hotkey=${BRIDGE_CONFIG.defaultValidator.hotkey}`);
            setStep(1, 'error', `Cannot reach bridge contract at ${truncHash(BRIDGE_CONFIG.contract.address)}`);
            throw new Error(
                `Cannot reach bridge contract at ${truncHash(BRIDGE_CONFIG.contract.address)}. ` +
                `Ensure NEXT_PUBLIC_BRIDGE_CONTRACT_ADDRESS is set to the correct deployed contract. ` +
                `Inner: ${pfMsg}`
            );
        }

        console.log('[BridgeService] Dry-run deposit params:', {
            origin,
            amount: request.amount.toString(),
            hotkey,
            contractAddress: BRIDGE_CONFIG.contract.address,
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let dryRun: any;
        try {
            dryRun = await withTimeout(
                bridgeContract.query('deposit', {
                    origin,
                    data: { amount: request.amount, hotkey },
                }),
                QUERY_TIMEOUT_MS,
                'deposit dry-run',
            );
        } catch (queryErr) {
            const qMsg = (queryErr as Error).message;
            console.error('[BridgeService] Dry-run query threw:', qMsg);
            setStep(1, 'error', `Dry-run call failed: ${qMsg}`);
            throw new Error(`Dry-run call failed: ${qMsg}`);
        }

        console.log('[BridgeService] Dry-run result:', JSON.stringify(dryRun, (_: string, v: unknown) => typeof v === 'bigint' ? v.toString() : v, 2));

        if (!dryRun.success || !dryRun.value.send) {
            console.error('[BridgeService] Dry-run value (deep):', JSON.stringify(dryRun.value, (_: string, v: unknown) => {
                if (typeof v === 'bigint') return v.toString();
                if (v && typeof v === 'object' && 'asHex' in v) return (v as { asHex: () => string }).asHex();
                if (v && typeof v === 'object' && 'asBytes' in v) return `<Binary ${(v as { asBytes: () => Uint8Array }).asBytes().length}bytes>`;
                return v;
            }, 2));
            const reason = dryRunReason(dryRun.value);
            console.error('[BridgeService] Dry-run rejected by contract:', reason);
            setStep(1, 'error', `Dry-run failed: ${reason}`);
            throw new Error(`Dry-run failed: ${reason}`);
        }

        const gasEst = dryRun.value.gasRequired;
        setStep(1, 'done', 'Dry run passed');

        // Step 3: Submit deposit -----------------------------------------------
        setStep(2, 'active', 'Submitting deposit – please confirm in wallet…');
        addEvent(txId, { type: 'Submitted', message: 'Step 3/4: Submitting deposit…' });
        console.log('[BridgeService] Step 3: Submitting deposit tx…');

        const depositTx = bridgeContract.send('deposit', {
            origin,
            data: { amount: request.amount, hotkey },
            gasLimit: doubleGas(gasEst),
            storageDepositLimit: clampStorageDeposit(dryRun.value.storageDeposit),
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await withTimeout(
            depositTx.signAndSubmit(paSigner, TX_OPTIONS),
            TX_TIMEOUT_MS,
            'deposit transaction',
        );

        if (!result.ok) {
            const errDetail = JSON.stringify(result.dispatchError);
            setStep(2, 'error', `Deposit failed: ${errDetail}`);
            throw new Error(`Deposit failed: ${errDetail}`);
        }

        // Try to extract deposit ID from DepositMade contract event
        let depositId: string | undefined;
        try {
            const contractEvents = bridgeContract.filterEvents(result.events);
            for (const evt of contractEvents) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const e = evt as any;
                if (e?.type === 'DepositMade') {
                    depositId = e.value?.deposit_id?.asHex?.()
                        || e.value?.deposit_id?.toString?.()
                        || undefined;
                    break;
                }
            }
        } catch { /* non-critical */ }

        updateTx(txId, {
            status: 'confirmed',
            sourceTxHash: result.txHash,
            depositId,
        });
        addEvent(txId, {
            type: 'Processing',
            message: `Deposit submitted (tx: ${truncHash(result.txHash)}). Waiting for guardians…`,
            data: { txHash: result.txHash, depositId },
        });
        setStep(2, 'done', `Deposit submitted (tx: ${truncHash(result.txHash)})`);

        // Step 4: Remove proxy (best-effort) -----------------------------------
        setStep(3, 'active', `Removing escrow ${truncHash(BRIDGE_CONFIG.contract.address)} as proxy…`);
        addEvent(txId, { type: 'Submitted', message: 'Step 4/4: Removing proxy…' });
        try {
            const rmTx = bittensorApi.tx.Proxy.remove_proxy({
                delegate: MultiAddress.Id(BRIDGE_CONFIG.contract.address as SS58String),
                proxy_type: { type: 'Any', value: undefined },
                delay: 0,
            });
            await withTimeout(
                rmTx.signAndSubmit(paSigner, TX_OPTIONS),
                TX_TIMEOUT_MS,
                'remove_proxy',
            );
            console.log('[BridgeService] Proxy removed successfully');
            setStep(3, 'done', 'Proxy removed successfully');
        } catch (e) {
            console.warn('[BridgeService] Proxy removal failed (non-critical):', e);
            setStep(3, 'done', 'Proxy removal skipped (non-critical)');
        }

        updateTx(txId, { status: 'processing' });

        return { success: true, txHash: result.txHash, bridgeTransactionId: txId };
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isCancelled = isUserCancellation(msg);
        // Safety: mark any step still "active" as "error" so spinners stop
        const activeIdx = steps.findIndex(s => s.state === 'active');
        if (activeIdx >= 0) {
            setStep(activeIdx, 'error', isCancelled ? 'Cancelled' : msg);
        }
        addEvent(txId, { type: 'Error', message: isCancelled ? 'User cancelled the transaction' : msg });
        updateTx(txId, { status: 'failed', error: isCancelled ? 'Cancelled by user' : msg });
        return { success: false, error: isCancelled ? 'Cancelled by user' : msg, bridgeTransactionId: txId };
    }
}

/**
 * Bridge hAlpha to Alpha.
 *
 * Flow (matches Explorer's `submitWithdrawal`):
 *  1. Call `AlphaBridge.withdraw({ amount })` on Hippius
 *  2. hAlpha is burned, WithdrawalRequestCreated event emitted
 *  3. Guardians release Alpha on Bittensor
 */
export async function bridgeHAlphaToAlpha(
    request: BridgeRequest,
    onStep?: OnStepCallback,
): Promise<BridgeResult> {
    const txId = generateTxId();
    const recipient = request.recipientAddress || request.senderAddress;

    const trackedTx: TrackedTransaction = {
        id: txId,
        direction: 'halpha-to-alpha',
        status: 'pending',
        amount: request.amount,
        senderAddress: request.senderAddress,
        recipientAddress: recipient,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attestations: 0,
        requiredAttestations: 3,
        events: [{ type: 'Submitted', timestamp: Date.now(), message: 'Submitting withdrawal…' }],
    };
    transactions.set(txId, trackedTx);
    notify(trackedTx);

    // Wizard step for withdrawal (single step) — declared outside try so catch can mark errors
    const steps: BridgeStep[] = [{
        step: 1,
        label: 'Submit Withdrawal',
        detail: 'Submitting withdrawal on Hippius…',
        state: 'active' as BridgeStepState,
    }];
    onStep?.([...steps]);

    try {
        // Build the polkadot-api PolkadotSigner from local keypair or extension.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let paSigner: any;
        if (request.keypair) {
            paSigner = getPolkadotSigner(
                request.keypair.publicKey,
                'Sr25519',
                (payload: Uint8Array) => request.keypair!.sign(payload),
            );
        } else {
            const extSigner = await createPolkadotApiSigner(request.senderAddress);
            paSigner = extSigner.polkadotSigner;
        }
        ensureHippius();

        const tx = hippiusApi.tx.AlphaBridge.withdraw({ amount: request.amount });
        console.log('[BridgeService] Submitting withdrawal tx, amount:', request.amount.toString());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await withTimeout(
            tx.signAndSubmit(paSigner, TX_OPTIONS),
            TX_TIMEOUT_MS,
            'AlphaBridge.withdraw',
        );

        if (!result.ok) {
            steps[0] = { ...steps[0], state: 'error', detail: `Withdrawal failed: ${JSON.stringify(result.dispatchError)}` };
            onStep?.([...steps]);
            throw new Error(`Withdrawal failed: ${JSON.stringify(result.dispatchError)}`);
        }

        steps[0] = { ...steps[0], state: 'done', detail: `Withdrawal submitted (tx: ${truncHash(result.txHash)})` };
        onStep?.([...steps]);

        // Extract withdrawal request ID from WithdrawalRequestCreated event
        // Event shape: { id: FixedSizeBinary<32>, sender, recipient, amount }
        let burnId: string | undefined;
        for (const event of result.events) {
            if (event.type === 'AlphaBridge') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const ev = event.value as any;
                if (ev?.type === 'WithdrawalRequestCreated') {
                    const raw = ev.value?.id ?? ev.id;
                    if (raw) {
                        burnId = typeof raw === 'string' ? raw
                            : raw.asHex?.() ?? raw.toHex?.()
                            ?? (raw instanceof Uint8Array ? '0x' + Array.from(raw).map((b: number) => b.toString(16).padStart(2, '0')).join('') : String(raw));
                    }
                    break;
                }
            }
        }

        updateTx(txId, {
            status: 'confirmed',
            sourceTxHash: result.txHash,
            burnId,
            withdrawalId: burnId,
        });

        addEvent(txId, {
            type: 'WithdrawalRequested',
            message: `Withdrawal confirmed (tx: ${truncHash(result.txHash)}). Guardians releasing Alpha…`,
            data: { txHash: result.txHash, burnId },
        });

        return { success: true, txHash: result.txHash, bridgeTransactionId: txId };
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isCancelled = isUserCancellation(msg);
        // Safety: mark any step still "active" as "error" so spinners stop
        if (steps[0].state === 'active') {
            steps[0] = { ...steps[0], state: 'error', detail: isCancelled ? 'Cancelled' : msg };
            onStep?.([...steps]);
        }
        addEvent(txId, { type: 'Error', message: isCancelled ? 'User cancelled the transaction' : msg });
        updateTx(txId, { status: 'failed', error: isCancelled ? 'Cancelled by user' : msg });
        return { success: false, error: isCancelled ? 'Cancelled by user' : msg, bridgeTransactionId: txId };
    }
}

// ---------------------------------------------------------------------------
// Transaction accessors (used by hook for minimal local tracking)
// ---------------------------------------------------------------------------

export function getTransaction(txId: string): TrackedTransaction | null {
    return transactions.get(txId) ?? null;
}

export function getPendingTransactions(): TrackedTransaction[] {
    return Array.from(transactions.values()).filter(
        tx => tx.status === 'pending' || tx.status === 'confirmed' || tx.status === 'processing',
    );
}

export function getAllTransactions(): TrackedTransaction[] {
    return Array.from(transactions.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export function getRecentTransactions(limit = 10): TrackedTransaction[] {
    return getAllTransactions().slice(0, limit);
}

export function getTransactionsForAddress(address: string): TrackedTransaction[] {
    return Array.from(transactions.values()).filter(
        tx => tx.senderAddress === address || tx.recipientAddress === address,
    );
}

/** Remove a completed/failed local tx after the API has picked it up */
export function removeLocalTransaction(txId: string): void {
    transactions.delete(txId);
}

// ---------------------------------------------------------------------------
// Fee estimation
// ---------------------------------------------------------------------------

export async function estimateBridgeFees(
    amount: bigint,
    direction: string,
): Promise<{ bridgeFee: bigint; gasFee: bigint; totalFee: bigint; receivedAmount: bigint }> {
    const bridgeFee = calculateBridgeFee(amount);
    const receivedAmount = calculateReceivedAmount(amount);
    const gasFee = direction === 'alpha-to-halpha' ? BigInt(10_000_000_000) : BigInt(1_000_000_000);
    return { bridgeFee, gasFee, totalFee: bridgeFee + gasFee, receivedAmount };
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

export async function checkConnectionStatus(): Promise<{
    bittensor: boolean;
    hippius: boolean;
    hippiusTestnet: boolean;
}> {
    let bt = false;
    let hip = false;

    try { if (bittensorClient) { await bittensorClient.getFinalizedBlock(); bt = true; } } catch { /* */ }
    try { if (hippiusClient) { await hippiusClient.getFinalizedBlock(); hip = true; } } catch { /* */ }

    return { bittensor: bt, hippius: hip, hippiusTestnet: hip };
}

// ---------------------------------------------------------------------------
// Subscriptions (for BridgeStatusWidget)
// ---------------------------------------------------------------------------

export async function subscribeToTransactionUpdates(
    onUpdate: (_tx: TrackedTransaction) => void,
): Promise<() => void> {
    subscribers.add(onUpdate);
    return () => { subscribers.delete(onUpdate); };
}

// ---------------------------------------------------------------------------
// Minimum amounts
// ---------------------------------------------------------------------------

export function getMinimumAlphaTransfer(): bigint {
    return BRIDGE_CONFIG.minimumTransfer.alpha;
}

export function getMinimumHAlphaTransfer(): bigint {
    return BRIDGE_CONFIG.minimumTransfer.hAlpha;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

export function alphaToHAlpha(alphaAmount: bigint): bigint {
    return alphaAmount * BigInt(10 ** 9);
}

export function hAlphaToAlpha(hAlphaAmount: bigint): bigint {
    return hAlphaAmount / BigInt(10 ** 9);
}

// ---------------------------------------------------------------------------
// No-op stubs for removed functionality (keeps old callers happy)
// ---------------------------------------------------------------------------

export function loadTransactionsFromStorage(): void {
    const stored = loadFromStorage();
    for (const [id, tx] of stored) transactions.set(id, tx);
}
export function saveTransactionsToStorage(): void { saveToStorage(transactions); }
export async function refreshTransactionStatus(): Promise<void> { /* no-op */ }
export function clearCompletedTransactions(): void {
    for (const [id, tx] of transactions) {
        if (tx.status === 'completed' || tx.status === 'failed') transactions.delete(id);
    }
    saveToStorage(transactions);
}
export function clearAllTransactions(): void {
    transactions.clear();
    saveToStorage(transactions);
}

// ---------------------------------------------------------------------------
// On-chain bridge data queries (same approach as Guardian Explorer poller.ts)
// ---------------------------------------------------------------------------

// Dummy origin for read-only contract queries (any valid SS58)
const READ_ORIGIN = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY' as SS58String;

// Amount formatting (matches Explorer's poller.ts)
const HALPHA_RAO_PER_ALPHA_RAO = BigInt(1_000_000_000);
const ALPHA_RAO_PER_ALPHA = BigInt(1_000_000_000);

function formatHalphaRao(amount: bigint): string {
    const alphaRao = amount / HALPHA_RAO_PER_ALPHA_RAO;
    const wholeAlpha = alphaRao / ALPHA_RAO_PER_ALPHA;
    const fractionalRao = alphaRao % ALPHA_RAO_PER_ALPHA;
    const fractional = fractionalRao.toString().padStart(9, '0').replace(/0+$/, '');
    if (fractional === '') return `${wholeAlpha}`;
    return `${wholeAlpha}.${fractional}`;
}

function formatAlphaRao(amount: bigint): string {
    const wholeAlpha = amount / ALPHA_RAO_PER_ALPHA;
    const fractionalRao = amount % ALPHA_RAO_PER_ALPHA;
    const fractional = fractionalRao.toString().padStart(9, '0').replace(/0+$/, '');
    if (fractional === '') return `${wholeAlpha}`;
    return `${wholeAlpha}.${fractional}`;
}

// Raw types from chain (matches Explorer's poller.ts)
interface RawHippiusDeposit {
    recipient?: string;
    amount?: bigint | number | string;
    votes?: string[];
    status?: { type?: string };
    created_at_block?: bigint | number | string;
    finalized_at_block?: bigint | number | string | null;
}

interface RawHippiusWithdrawalRequest {
    sender?: string;
    amount?: bigint | number | string;
    nonce?: bigint | number | string;
    status?: { type?: string };
    created_at_block?: bigint | number | string;
}

interface RawBittensorDepositRequest {
    sender?: string;
    amount?: bigint | number | string;
    nonce?: bigint | number | string;
    hotkey?: string;
    netuid?: number;
    status?: { type?: string };
    created_at_block?: bigint | number | string;
}

interface RawBittensorWithdrawal {
    amount?: bigint | number | string;
    votes?: string[];
    status?: { type?: string };
    created_at_block?: bigint | number | string;
    finalized_at_block?: bigint | number | string | null;
}

// Public types (same shape as Explorer)
export interface DepositView {
    requestId: string;
    recipient: string;
    amount: string;
    amountDisplay: string;
    votes: string[];
    voteCount: number;
    status: string;
    createdAtBlock: string;
    finalizedAtBlock?: string;
    bittensorSide?: {
        sender: string;
        amount: string;
        amountDisplay: string;
        nonce: string;
        status: string;
        createdAtBlock: string;
    };
}

export interface WithdrawalView {
    requestId: string;
    sender: string;
    amount: string;
    amountDisplay: string;
    status: string;
    createdAtBlock: string;
    bittensorSide?: {
        amount: string;
        amountDisplay: string;
        votes: string[];
        voteCount: number;
        status: string;
        createdAtBlock: string;
        finalizedAtBlock?: string;
    };
}

export interface BridgeStats {
    totalDeposits: number;
    totalWithdrawals: number;
    pendingDeposits: number;
    pendingWithdrawals: number;
    hippiusHeight: number;
    bittensorHeight: number;
    approveThreshold: number;
    cleanupTtlBlocks: string;
    guardians: string[];
    lastPollAt: string | null;
}

export interface BridgeOnChainData {
    deposits: DepositView[];
    withdrawals: WithdrawalView[];
    stats: BridgeStats;
}

/**
 * Fetch bridge deposits and withdrawals directly from chain storage.
 * Exact same approach as Guardian Explorer's poller.ts:
 * - Reads AlphaBridge.Deposits + WithdrawalRequests from Hippius chain
 * - Cross-references with Bittensor contract (graceful — skips on error)
 */
export async function fetchBridgeDataOnChain(): Promise<BridgeOnChainData> {
    ensureHippius();
    ensureBittensor();

    // Get chain heights
    const [hippiusBlock, bittensorBlock] = await Promise.all([
        withTimeout(hippiusClient!.getFinalizedBlock(), QUERY_TIMEOUT_MS, 'Hippius block'),
        withTimeout(bittensorClient!.getFinalizedBlock(), QUERY_TIMEOUT_MS, 'Bittensor block'),
    ]);

    const hippiusHeight = Number(hippiusBlock.number);
    const bittensorHeight = Number(bittensorBlock.number);

    // Get bridge config from chain
    const [threshold, ttl, guardians] = await Promise.all([
        withTimeout(hippiusApi.query.AlphaBridge.ApproveThreshold.getValue(), QUERY_TIMEOUT_MS, 'Threshold'),
        withTimeout(hippiusApi.query.AlphaBridge.CleanupTTLBlocks.getValue(), QUERY_TIMEOUT_MS, 'TTL'),
        withTimeout(hippiusApi.query.AlphaBridge.Guardians.getValue(), QUERY_TIMEOUT_MS, 'Guardians'),
    ]);

    // Get all deposits and withdrawal requests from Hippius pallet storage
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const [depositEntries, withdrawalEntries]: [any[], any[]] = await Promise.all([
        withTimeout(hippiusApi.query.AlphaBridge.Deposits.getEntries(), QUERY_TIMEOUT_MS, 'Deposits') as Promise<any[]>,
        withTimeout(hippiusApi.query.AlphaBridge.WithdrawalRequests.getEntries(), QUERY_TIMEOUT_MS, 'Withdrawals') as Promise<any[]>,
    ]);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // Map deposits with Bittensor cross-reference
    const deposits: DepositView[] = [];
    for (const entry of depositEntries) {
        const id = entry.keyArgs[0].asHex();
        const d = entry.value as unknown as RawHippiusDeposit;
        const amount = BigInt((d.amount ?? 0).toString());
        const statusKey = d.status?.type ?? 'Pending';

        const view: DepositView = {
            requestId: id,
            recipient: (d.recipient ?? '') as string,
            amount: amount.toString(),
            amountDisplay: formatHalphaRao(amount),
            votes: (d.votes ?? []) as string[],
            voteCount: (d.votes ?? []).length,
            status: statusKey,
            createdAtBlock: BigInt((d.created_at_block ?? 0).toString()).toString(),
        };

        if (d.finalized_at_block) {
            view.finalizedAtBlock = BigInt(d.finalized_at_block.toString()).toString();
        }

        // Cross-reference with Bittensor contract (graceful)
        try {
            if (bridgeContract) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const btResult: any = await withTimeout(
                    bridgeContract.query('get_deposit_request', {
                        origin: READ_ORIGIN,
                        data: { request_id: FixedSizeBinary.fromHex(id) },
                    }),
                    QUERY_TIMEOUT_MS,
                    'BT deposit query',
                );

                if (btResult.success && btResult.value?.response) {
                    const r = btResult.value.response as RawBittensorDepositRequest;
                    const btAmount = BigInt((r.amount ?? 0).toString());
                    view.bittensorSide = {
                        sender: (r.sender ?? '') as string,
                        amount: btAmount.toString(),
                        amountDisplay: formatAlphaRao(btAmount),
                        nonce: BigInt((r.nonce ?? 0).toString()).toString(),
                        status: r.status?.type ?? 'Requested',
                        createdAtBlock: BigInt((r.created_at_block ?? 0).toString()).toString(),
                    };
                }
            }
        } catch {
            console.warn(`[BridgeService] BT cross-ref failed for deposit ${id.slice(0, 10)}...`);
        }

        deposits.push(view);
    }

    // Map withdrawal requests with Bittensor cross-reference
    const withdrawals: WithdrawalView[] = [];
    for (const entry of withdrawalEntries) {
        const id = entry.keyArgs[0].asHex();
        const r = entry.value as unknown as RawHippiusWithdrawalRequest;
        const amount = BigInt((r.amount ?? 0).toString());
        const statusKey = r.status?.type ?? 'Requested';

        const view: WithdrawalView = {
            requestId: id,
            sender: (r.sender ?? '') as string,
            amount: amount.toString(),
            amountDisplay: formatHalphaRao(amount),
            status: statusKey,
            createdAtBlock: BigInt((r.created_at_block ?? 0).toString()).toString(),
        };

        // Cross-reference with Bittensor contract (graceful)
        try {
            if (bridgeContract) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const btResult: any = await withTimeout(
                    bridgeContract.query('get_withdrawal', {
                        origin: READ_ORIGIN,
                        data: { withdrawal_id: FixedSizeBinary.fromHex(id) },
                    }),
                    QUERY_TIMEOUT_MS,
                    'BT withdrawal query',
                );

                if (btResult.success && btResult.value?.response) {
                    const w = btResult.value.response as RawBittensorWithdrawal;
                    const btAmount = BigInt((w.amount ?? 0).toString());
                    const btView: WithdrawalView['bittensorSide'] = {
                        amount: btAmount.toString(),
                        amountDisplay: formatAlphaRao(btAmount),
                        votes: (w.votes ?? []) as string[],
                        voteCount: (w.votes ?? []).length,
                        status: w.status?.type ?? 'Pending',
                        createdAtBlock: BigInt((w.created_at_block ?? 0).toString()).toString(),
                    };
                    if (w.finalized_at_block) {
                        btView.finalizedAtBlock = BigInt(w.finalized_at_block.toString()).toString();
                    }
                    view.bittensorSide = btView;
                }
            }
        } catch {
            console.warn(`[BridgeService] BT cross-ref failed for withdrawal ${id.slice(0, 10)}...`);
        }

        withdrawals.push(view);
    }

    const guardianList = Array.isArray(guardians) ? (guardians as string[]) : [];

    return {
        deposits,
        withdrawals,
        stats: {
            totalDeposits: deposits.length,
            totalWithdrawals: withdrawals.length,
            pendingDeposits: deposits.filter((d) => d.status === 'Pending').length,
            pendingWithdrawals: withdrawals.filter((w) => w.status === 'Requested').length,
            hippiusHeight,
            bittensorHeight,
            approveThreshold: Number(threshold),
            cleanupTtlBlocks: BigInt(String(ttl ?? 0)).toString(),
            guardians: guardianList,
            lastPollAt: new Date().toISOString(),
        },
    };
}
