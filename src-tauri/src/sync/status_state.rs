//! Authoritative sync engine status owned by the Rust backend.
//!
//! Replaces the frontend-side `syncEngineStatusAtom` race that flipped the
//! widget to "Stopped" on cold start because `is_drive_active` was called
//! before `auto_init_sync` had a chance to populate the drives map.
//!
//! The new model:
//!
//! - **Initializing**: app launched, `auto_init_sync` has not yet run to
//!   completion. The frontend should NOT show the "Stopped" alert in this
//!   state — it just means the engine hasn't decided yet.
//! - **Active**: `auto_init_sync` has completed AND at least one drive is
//!   loaded. Sync cycles run normally.
//! - **Stopping**: the user clicked Stop and `stop_drive` is in flight. The
//!   sync loop is being torn down.
//! - **Stopped**: the user explicitly stopped sync (persisted across restarts
//!   in `user_preferences.sync_user_stopped`), OR `auto_init_sync` ran and
//!   could not bring any drive up.
//!
//! State is held as an `AtomicU8` discriminant for lock-free reads on the
//! status query hot path. The `auto_init_complete` latch is a separate
//! `AtomicBool` because some queries care about the distinction between
//! "no drives loaded yet" (Initializing) and "no drives loaded ever"
//! (Stopped) — the latch is the disambiguator.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

/// Authoritative sync engine status.
///
/// Wire format is `camelCase` to match existing TypeScript expectations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncEngineStatus {
    /// `auto_init_sync` has not yet run to completion. Frontend treats this
    /// like Active for the purposes of the "Stopped" alert (i.e. don't show
    /// it).
    Initializing,
    /// At least one drive is loaded and the sync loop is running.
    Active,
    /// `stop_drive` is in flight; sync loop is being torn down.
    Stopping,
    /// User explicitly stopped sync, OR auto-init found no drives to bring
    /// up. The "Stopped" alert is shown when this state is combined with
    /// "sync was previously configured" gating.
    Stopped,
}

impl SyncEngineStatus {
    fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Active,
            2 => Self::Stopping,
            3 => Self::Stopped,
            // 0 and any unknown discriminant default to Initializing —
            // the next status update will overwrite it. We don't panic on
            // unknown values because they could come from a future variant
            // we haven't taught this match yet.
            _ => Self::Initializing,
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            Self::Initializing => 0,
            Self::Active => 1,
            Self::Stopping => 2,
            Self::Stopped => 3,
        }
    }
}

/// Atomic container for sync engine status + the auto-init latch.
///
/// All transitions are lock-free. Defaults to `Initializing` so the frontend
/// gets a deterministic answer immediately on cold start, before any drive
/// has been loaded.
pub struct SyncStatusState {
    status: AtomicU8,
    auto_init_complete: AtomicBool,
}

impl Default for SyncStatusState {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncStatusState {
    pub fn new() -> Self {
        Self {
            status: AtomicU8::new(SyncEngineStatus::Initializing.as_u8()),
            auto_init_complete: AtomicBool::new(false),
        }
    }

    /// Read the current status. Lock-free.
    pub fn get(&self) -> SyncEngineStatus {
        SyncEngineStatus::from_u8(self.status.load(Ordering::Acquire))
    }

    /// Overwrite the current status. Lock-free.
    ///
    /// Callers that need to emit a Tauri event after the change should use
    /// [`set_status_and_emit`](crate::sync::status::set_status_and_emit)
    /// instead so the emission can't be forgotten.
    pub fn set(&self, status: SyncEngineStatus) {
        self.status.store(status.as_u8(), Ordering::Release);
    }

    /// Latch flipped to `true` at the end of `auto_init_sync` (regardless
    /// of outcome). Allows `get_sync_engine_status` to distinguish "auto
    /// init hasn't run yet" (Initializing) from "auto init ran and brought
    /// up zero drives" (Stopped).
    pub fn mark_auto_init_complete(&self) {
        self.auto_init_complete.store(true, Ordering::Release);
    }

    /// Reset the latch back to `false`. Called from `stop_sync` (the
    /// internal lifecycle cleanup invoked from login, logout, and reset)
    /// so that the follow-up `auto_init_sync` transitions through
    /// `Initializing` again instead of jumping straight to `Stopped` on
    /// a logout-then-login within the same process.
    pub fn reset_auto_init_complete(&self) {
        self.auto_init_complete.store(false, Ordering::Release);
    }

    pub fn auto_init_complete(&self) -> bool {
        self.auto_init_complete.load(Ordering::Acquire)
    }
}

// ── Persisted user-stopped flag ──────────────────────────────────────────
//
// Stored in the existing `user_preferences` table so it survives app
// restarts. This replaces the frontend `localStorage["hippius_sync_stopped"]`
// flag that was the previous source of truth.

/// Key used in `user_preferences` to persist the user-stopped flag.
pub const USER_STOPPED_PREF_KEY: &str = "sync_user_stopped";

/// Read the persisted user-stopped flag. Returns `false` when the key is
/// missing (the default state for new installs).
pub async fn read_user_stopped(pool: &SqlitePool) -> Result<bool, sqlx::Error> {
    let row = sqlx::query_as::<_, (String,)>("SELECT preference_value FROM user_preferences WHERE preference_key = ?")
        .bind(USER_STOPPED_PREF_KEY)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_some_and(|(v,)| v == "true"))
}

/// Persist the user-stopped flag. Idempotent upsert.
pub async fn write_user_stopped(pool: &SqlitePool, stopped: bool) -> Result<(), sqlx::Error> {
    let value = if stopped { "true" } else { "false" };
    sqlx::query(
        "INSERT OR REPLACE INTO user_preferences (preference_key, preference_value, updated_at) VALUES (?, ?, CAST(strftime('%s','now') * 1000 AS INTEGER))",
    )
    .bind(USER_STOPPED_PREF_KEY)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminant_round_trip_covers_every_variant() {
        for s in [
            SyncEngineStatus::Initializing,
            SyncEngineStatus::Active,
            SyncEngineStatus::Stopping,
            SyncEngineStatus::Stopped,
        ] {
            assert_eq!(SyncEngineStatus::from_u8(s.as_u8()), s);
        }
    }

    #[test]
    fn unknown_discriminant_defaults_to_initializing() {
        // Defensive guard against a future variant being added without
        // updating from_u8 — the read should fall back to a safe state
        // rather than panic.
        assert_eq!(SyncEngineStatus::from_u8(99), SyncEngineStatus::Initializing);
    }

    #[test]
    fn new_state_starts_initializing_with_latch_false() {
        let state = SyncStatusState::new();
        assert_eq!(state.get(), SyncEngineStatus::Initializing);
        assert!(!state.auto_init_complete());
    }

    #[test]
    fn set_overwrites_status() {
        let state = SyncStatusState::new();
        state.set(SyncEngineStatus::Active);
        assert_eq!(state.get(), SyncEngineStatus::Active);
        state.set(SyncEngineStatus::Stopped);
        assert_eq!(state.get(), SyncEngineStatus::Stopped);
    }

    #[test]
    fn auto_init_latch_set_and_reset() {
        let state = SyncStatusState::new();
        assert!(!state.auto_init_complete());
        state.mark_auto_init_complete();
        assert!(state.auto_init_complete());
        // Setting it again is idempotent.
        state.mark_auto_init_complete();
        assert!(state.auto_init_complete());
        // Reset is what `stop_sync` calls before a follow-up auto-init.
        state.reset_auto_init_complete();
        assert!(!state.auto_init_complete());
        // And re-marking after reset works.
        state.mark_auto_init_complete();
        assert!(state.auto_init_complete());
    }

    #[test]
    fn json_round_trip_uses_camel_case() {
        // The wire format must match what the TypeScript atom expects:
        // "initializing" / "active" / "stopping" / "stopped".
        for (status, expected_json) in [
            (SyncEngineStatus::Initializing, "\"initializing\""),
            (SyncEngineStatus::Active, "\"active\""),
            (SyncEngineStatus::Stopping, "\"stopping\""),
            (SyncEngineStatus::Stopped, "\"stopped\""),
        ] {
            let json = serde_json::to_string(&status).expect("serialize");
            assert_eq!(json, expected_json);
            let parsed: SyncEngineStatus = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(parsed, status);
        }
    }

    // ── Persistence helpers ──────────────────────────────────────────────
    //
    // These tests use an in-memory SQLite to verify the user_stopped flag
    // round-trips correctly through the user_preferences table.

    async fn make_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.expect("open in-memory db");
        sqlx::query(
            "CREATE TABLE user_preferences (
                preference_key TEXT PRIMARY KEY,
                preference_value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create table");
        pool
    }

    #[tokio::test]
    async fn read_user_stopped_returns_false_when_missing() {
        let pool = make_pool().await;
        assert!(!read_user_stopped(&pool).await.expect("read"));
    }

    #[tokio::test]
    async fn write_then_read_user_stopped_round_trips_true() {
        let pool = make_pool().await;
        write_user_stopped(&pool, true).await.expect("write");
        assert!(read_user_stopped(&pool).await.expect("read"));
    }

    #[tokio::test]
    async fn write_then_read_user_stopped_round_trips_false() {
        let pool = make_pool().await;
        write_user_stopped(&pool, true).await.expect("write");
        write_user_stopped(&pool, false).await.expect("write");
        assert!(!read_user_stopped(&pool).await.expect("read"));
    }
}
