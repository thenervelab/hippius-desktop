//! Bridge endpoints + contract constants, ported from `app/lib/bridge/config.ts`.
//!
//! Hardcoded here (matching the TS defaults) so the bridge no longer depends on
//! renderer `NEXT_PUBLIC_*` env config. A DB-backed override (like the mainnet
//! `wss_endpoint` row) is a possible later refinement.

/// Bittensor testnet RPC — the ink! contract + proxy + stake side.
pub const BITTENSOR_WS_URL: &str = "wss://tao-testnet.hippicode.com";
/// Hippius testnet RPC — the `AlphaBridge` pallet side.
pub const HIPPIUS_TESTNET_WS_URL: &str = "wss://hippius-testnet.starkleytech.com";

/// ink! bridge contract address (SS58) on Bittensor testnet.
pub const BRIDGE_CONTRACT_ADDRESS: &str = "5CXnPB8eTkHKTWdZCuB1Ha1kVQENEupnvjgaDzzfQqbURrqm";
/// Default validator hotkey a deposit is staked to when the caller doesn't pick one.
pub const DEFAULT_VALIDATOR_HOTKEY: &str = "5FPD6YkHFL7PU6H8UQFaf4ahcMqum6DW8uDgBZnPd6ysrecc";
/// Subnet id the bridge operates on.
pub const NETUID: u16 = 2;

/// `deposit(amount: Balance, hotkey: AccountId)` ink! message selector, from
/// `.papi/contracts/bridge.json`. The call data is `selector ++ scale(args)`.
pub const DEPOSIT_SELECTOR: [u8; 4] = [0x2d, 0x10, 0xc9, 0xbd];

/// Read-only ink! message selectors (same ABI source). Used by
/// `contract::query_contract` for the explorer cross-ref + deposit-id lookup.
pub const GET_DEPOSIT_REQUEST_SELECTOR: [u8; 4] = [0x63, 0x70, 0xed, 0x0c];
pub const GET_WITHDRAWAL_SELECTOR: [u8; 4] = [0x6a, 0x66, 0x76, 0x20];
pub const GET_DEPOSIT_REQUEST_ID_BY_NONCE_SELECTOR: [u8; 4] = [0xa1, 0xbb, 0x85, 0xdc];
