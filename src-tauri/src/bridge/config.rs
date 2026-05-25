//! Bridge configuration constants — mirrors `lib/bridge/config.ts`.
//!
//! Values default to the testnet endpoints + addresses that the web
//! client currently uses. They're shipped to the frontend via the
//! `bridge_get_config` IPC so the dialog can render minimum-amount
//! hints, estimated fees, and the deposit address without re-implementing
//! the math.

use serde::Serialize;

/// Polkadot decimals. 1 ALPHA token on Bittensor = 10^9 planck.
pub const ALPHA_DECIMALS: u8 = 9;
/// 1 hALPHA token on Hippius = 10^18 planck. Matches the Hippius
/// chain's `Balance` type and the desktop's existing `planck_to_hip`.
pub const HALPHA_DECIMALS: u8 = 18;

/// Bittensor testnet WebSocket. Switch to mainnet in a future release.
pub const BITTENSOR_WS_URL: &str = "wss://test.finney.opentensor.ai:443";
pub const BITTENSOR_NAME: &str = "Bittensor Testnet";

/// Hippius testnet WebSocket. Note that this is independent of the
/// per-account RPC endpoint stored in `wss_endpoint` — the bridge
/// always talks to the testnet that hosts the AlphaBridge pallet
/// until mainnet bridging is live.
pub const HIPPIUS_WS_URL: &str = "wss://hippius-testnet.starkleytech.com";
pub const HIPPIUS_NAME: &str = "Hippius";

/// AlphaEscrow ink! contract on Bittensor testnet. Bridge deposits
/// add this as a proxy on the user's account, then call its
/// `deposit` method via `Contracts::call`. Used by the
/// Alpha → hAlpha direction (not wired yet — see [`crate::bridge`]
/// module docs).
pub const BRIDGE_CONTRACT_ADDRESS: &str = "5ChKsmrvxKrcqnUWrnZx3er7arFCJdrpETKxhfgXKdQYdjga";

/// Default subnet + validator hotkey for Alpha staking. The dialog
/// overrides via the hotkey picker, but a sane default is needed
/// for cases where the user accepts the chain default.
pub const DEFAULT_VALIDATOR_HOTKEY: &str = "5HEiGxfQxEkPWjNCcFT9HTX7cfPi2kKEekxUGDmaFWGRJEFD";
pub const DEFAULT_NETUID: u16 = 75;

/// Bridge fee: 0.1% of the bridged amount. Represented as basis-points
/// (10 / 10_000) so the planck math stays in `u128`.
pub const FEE_NUMERATOR: u128 = 10;
pub const FEE_DENOMINATOR: u128 = 10_000;

/// Minimum bridge amounts, in chain-native smallest units. These are
/// the protocol-enforced floors, not UX hints — submitting below these
/// will be rejected by the chain / contract.
///
/// - Alpha → hAlpha floor: 15 ALPHA (9 decimals)
/// - hAlpha → Alpha floor: 15 hALPHA (18 decimals)
pub const MIN_ALPHA_PLANCK: u128 = 15 * 1_000_000_000;
pub const MIN_HALPHA_PLANCK_STR: &str = "15000000000000000000";

/// 5% buffer recommended on top of MIN_ALPHA_PLANCK at submission
/// time so price fluctuations between dry-run and submit don't push
/// the user back under the floor. Used as a UI hint.
pub const MIN_BUFFER_BPS: u64 = 500;

/// Snapshot of every value the frontend renders. Returned by the
/// `bridge_get_config` IPC so the TS side never hard-codes any of
/// these. `camelCase` rename keeps the TS interface readable.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BridgeConfig {
    pub bittensor_ws_url: String,
    pub bittensor_name: String,
    pub hippius_ws_url: String,
    pub hippius_name: String,
    pub bridge_contract_address: String,
    pub default_validator_hotkey: String,
    pub default_netuid: u16,
    pub alpha_decimals: u8,
    pub halpha_decimals: u8,
    /// Fee as basis-points (e.g. 10 = 0.10%). FE divides by
    /// `fee_denominator` to compute the percentage; keeping both
    /// fields explicit avoids float drift.
    pub fee_numerator: u128,
    pub fee_denominator: u128,
    pub min_alpha_planck: String,
    pub min_halpha_planck: String,
    pub min_buffer_bps: u64,
}

impl BridgeConfig {
    pub fn current() -> Self {
        BridgeConfig {
            bittensor_ws_url: BITTENSOR_WS_URL.to_string(),
            bittensor_name: BITTENSOR_NAME.to_string(),
            hippius_ws_url: HIPPIUS_WS_URL.to_string(),
            hippius_name: HIPPIUS_NAME.to_string(),
            bridge_contract_address: BRIDGE_CONTRACT_ADDRESS.to_string(),
            default_validator_hotkey: DEFAULT_VALIDATOR_HOTKEY.to_string(),
            default_netuid: DEFAULT_NETUID,
            alpha_decimals: ALPHA_DECIMALS,
            halpha_decimals: HALPHA_DECIMALS,
            fee_numerator: FEE_NUMERATOR,
            fee_denominator: FEE_DENOMINATOR,
            min_alpha_planck: MIN_ALPHA_PLANCK.to_string(),
            min_halpha_planck: MIN_HALPHA_PLANCK_STR.to_string(),
            min_buffer_bps: MIN_BUFFER_BPS,
        }
    }
}

/// `amount * FEE_NUMERATOR / FEE_DENOMINATOR`, saturating against
/// `u128::MAX` for absurd inputs. Mirrors web's `calculateBridgeFee`.
pub fn fee_planck(amount: u128) -> u128 {
    amount
        .saturating_mul(FEE_NUMERATOR)
        .saturating_div(FEE_DENOMINATOR)
}

/// `amount - fee`. Saturates at 0 for the (impossible) case where
/// rounding would underflow.
pub fn received_planck(amount: u128) -> u128 {
    amount.saturating_sub(fee_planck(amount))
}
