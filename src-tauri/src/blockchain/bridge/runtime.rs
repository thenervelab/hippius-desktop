//! subxt type bindings for the two chains the bridge talks to.
//!
//! These are SEPARATE from `blockchain::runtime::custom_runtime` (Hippius
//! mainnet): the bridge operates against the Bittensor chain (ink! contract +
//! proxy + stake APIs) and the Hippius **testnet** `AlphaBridge` pallet, neither
//! of which the bundled mainnet `metadata.scale` describes. Both chains are
//! sr25519 / `PolkadotConfig`-compatible, so the existing signer + client types
//! work unchanged.
//!
//! Metadata is the SCALE-encoded `RuntimeMetadataPrefixed` exported by the
//! `.papi` tooling (`.papi/metadata/{bittensor,hippius}.scale`), copied to the
//! crate root for codegen.

/// Bittensor chain bindings — `Proxy`, `Contracts` (ink! `pallet-contracts`),
/// `System`, and the `ContractsApi`/`StakeInfoRuntimeApi` runtime APIs.
#[subxt::subxt(runtime_metadata_path = "bittensor_metadata.scale")]
pub mod bittensor {}

/// Hippius **testnet** bindings — the `AlphaBridge` pallet (`withdraw`,
/// `Deposits`/`WithdrawalRequests` storage, `WithdrawalRequestCreated` event).
#[subxt::subxt(runtime_metadata_path = "hippius_testnet_metadata.scale")]
pub mod hippius_tn {}
