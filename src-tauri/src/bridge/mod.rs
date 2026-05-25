//! Alpha ⇆ hAlpha bridge.
//!
//! Mirrors hippius-web's `lib/bridge/*` surface but with the chain logic
//! moved into Rust per the project's "business logic lives in src-tauri"
//! rule (`src-tauri/CLAUDE.md`).
//!
//! Module layout:
//! - [`config`]: chain endpoints, contract address, fee + minimum-amount
//!   constants. Kept separate so values can be tuned without touching
//!   the orchestration.
//! - [`types`]: data shapes shared between the IPC layer and the
//!   frontend. `camelCase` serde so the TypeScript interface matches
//!   hippius-web's existing shapes (lib/bridge/types.ts).
//! - [`cache`]: SQLite persistence for tracked bridge transactions —
//!   replaces the localStorage map in `lib/bridge/service.ts`.
//! - [`commands`]: Tauri IPC entry points (`bridge_*`).
//!
//! Direction status as of this commit:
//! - **hAlpha → Alpha**: live. Uses the existing `custom_runtime`
//!   AlphaBridge pallet that's already in `src-tauri/metadata.scale`.
//! - **Alpha → hAlpha**: stubbed. Needs (a) Bittensor chain metadata
//!   in `src-tauri/bittensor-metadata.scale`, and (b) the ink! escrow
//!   contract's ABI so the deposit selector + arg encoding are known.
//!   The IPC returns a structured error explaining the gap.

pub mod cache;
pub mod commands;
pub mod config;
pub mod types;
