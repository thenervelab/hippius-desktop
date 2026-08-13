//! Bridge between Bittensor Alpha and Hippius hAlpha, ported from the
//! renderer-side `app/lib/bridge/` (audit H-8 Part B / bridge logic-placement).
//!
//! Construction, dry-run, signing, submission, and contract/event decoding all
//! live here so the renderer only sends `{amount, recipient, direction,
//! password}` and never constructs an extrinsic the wallet blind-signs.
//!
//! Build-out is staged (see the audit doc): this module currently provides the
//! subxt codegen scaffold and the pure conversion/fee math; the contract,
//! read, and write paths land in subsequent stages.

pub mod client;
pub mod config;
pub mod contract;
pub mod convert;
pub mod deposit;
pub mod explorer;
pub mod history;
pub mod queries;
pub mod runtime;
pub mod status;
pub mod types;
pub mod withdraw;
