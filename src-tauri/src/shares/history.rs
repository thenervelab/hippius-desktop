//! Local history of expired/revoked share links.
//!
//! Per-device snapshot table. Rows enter via three triggers:
//! - active row's `expires_at` passes between two `list_shares` calls
//!   (`expired`)
//! - this device revokes via `hcfs_revoke_share` (`revoked_here`)
//! - active row vanishes from server's list before its TTL
//!   (`revoked_elsewhere` — another device or the server reaper got it)
//!
//! Cleanup is user-driven: per-row `remove_one` and bulk
//! `clear_all_for_account`. The server is never touched — these tokens
//! are already dead server-side, so this table is purely local
//! presentation state.
//!
//! Design plan (per the project's Rust Design Discipline):
//! - PRIMARY KEY (account_id, share_token) — idempotent upsert,
//!   per-account scoping mirrors every other local sidecar
//!   (`share_origin`, `sync_paths`, …). A multi-account install can
//!   never cross-evict.
//! - `EndReason` is a sealed enum serialized snake_case (Serde) so the
//!   wire contract with the FE matches the SQLite TEXT column verbatim.
//!   Storing a stringified enum keeps the table TEXT-only and lets us
//!   keep `Display`/`Deserialize` round-tripping without writing custom
//!   adapters. Source: serde docs on `rename_all`.
//! - `HistoryEntry` carries `Option<…>` for fields we may not have known
//!   when capturing the row:
//!     - cross-device shares lack `folder_label`/`relative_path` (no
//!       local `share_origin` row exists for them);
//!     - a revoke that fires before this device has called
//!       `list_shares` even once will lack `plaintext_size`/`mime_type`
//!       (no cached `ShareSummary` to copy from).
//!
//!   Required fields (`share_token`, timestamps, `end_reason`) are
//!   never `None`.
//! - `record_event` uses `ON CONFLICT (account_id, share_token) DO
//!   UPDATE` so the same token can be re-recorded with a corrected
//!   `end_reason`. Example: an `expired` row is recorded by the diff
//!   path, then a slightly-late server response confirms it was
//!   actually revoked elsewhere — the second write wins. Idempotent on
//!   repeat with the same fields.
//! - `diff_active_lists` is pure: takes two slice references plus a
//!   `now` timestamp and returns a Vec of events. The IPC layer does
//!   the I/O. `now` is parameterised so unit tests can pin the clock
//!   without freezing real time.
//!
//! Error policy: helpers return `sqlx::Error`. The IPC layer leans on
//! the existing `From<sqlx::Error> for AppError::Db` impl
//! (`crate::error::AppError`) so `?` does the conversion — same
//! posture as `crate::shares::origin`. No `AppError::Other(format!(...))`
//! collapse and no per-module error enum yet, because every failure
//! that reaches the IPC has the same handler shape.

use chrono::{DateTime, Utc};
use hcfs_client::client::share::ShareSummary as UpstreamShareSummary;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;
use std::collections::HashSet;

/// Why a share token left the active set. Stored verbatim as the
/// `end_reason` column, sent verbatim over the wire, so all three
/// representations agree by construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    /// `expires_at <= now` when the row dropped out of the active list.
    Expired,
    /// This device successfully called `hcfs_revoke_share`.
    RevokedHere,
    /// The row dropped out of the active list while still in TTL —
    /// must have been revoked from another device or by a server-side
    /// reaper before TTL.
    RevokedElsewhere,
}

impl EndReason {
    /// Stable string form used for the `end_reason` column. Kept on
    /// the type so the SQL builder doesn't have to know about Serde.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Expired => "expired",
            Self::RevokedHere => "revoked_here",
            Self::RevokedElsewhere => "revoked_elsewhere",
        }
    }

    /// Inverse of [`as_str`]. Returns `None` for an unknown column
    /// value so a schema drift surfaces as a `Result` error rather
    /// than a panic.
    #[must_use]
    pub fn from_db_str(s: &str) -> Option<Self> {
        match s {
            "expired" => Some(Self::Expired),
            "revoked_here" => Some(Self::RevokedHere),
            "revoked_elsewhere" => Some(Self::RevokedElsewhere),
            _ => None,
        }
    }
}

/// One persisted history row. Wire shape and DB shape are identical —
/// the FE consumes this directly via `hcfs_list_share_history`.
///
/// Required fields are non-optional; everything we may legitimately
/// not know is `Option`. See module-level docs for which is which.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub share_token: String,
    pub filename: Option<String>,
    pub folder_label: Option<String>,
    pub relative_path: Option<String>,
    pub plaintext_size: Option<i64>,
    pub mime_type: Option<String>,
    pub created_at: String,
    /// `None` for a share that never expired (ended by revocation).
    pub expires_at: Option<String>,
    pub ended_at: String,
    pub end_reason: EndReason,
}

/// One row of `shared_link_history` to upsert in response to an
/// active-list diff. Returned by [`diff_active_lists`]; passed to
/// [`record_event`] by the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEvent {
    pub end_reason: EndReason,
    pub entry: HistoryEntry,
}

/// Idempotent upsert keyed on `(account_id, share_token)`.
///
/// Re-recording the same token replaces every column. This is
/// intentional — the diff path may record a row as `Expired` based on
/// the cached snapshot, and a later refinement (e.g. a slightly-late
/// `revoke_share` confirmation) needs to be able to overwrite the
/// reason. Last-write-wins.
///
/// # Errors
/// Returns the underlying `sqlx::Error` on connection or constraint
/// failure. Callers in IPC paths convert via the existing
/// `From<sqlx::Error> for AppError::Db` impl.
pub async fn record_event(pool: &SqlitePool, account_id: &str, entry: &HistoryEntry) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO shared_link_history (
            account_id, share_token, filename, folder_label, relative_path,
            plaintext_size, mime_type, created_at, expires_at, ended_at, end_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, share_token) DO UPDATE SET
            filename       = excluded.filename,
            folder_label   = excluded.folder_label,
            relative_path  = excluded.relative_path,
            plaintext_size = excluded.plaintext_size,
            mime_type      = excluded.mime_type,
            created_at     = excluded.created_at,
            expires_at     = excluded.expires_at,
            ended_at       = excluded.ended_at,
            end_reason     = excluded.end_reason",
    )
    .bind(account_id)
    .bind(&entry.share_token)
    .bind(&entry.filename)
    .bind(&entry.folder_label)
    .bind(&entry.relative_path)
    .bind(entry.plaintext_size)
    .bind(&entry.mime_type)
    .bind(&entry.created_at)
    .bind(&entry.expires_at)
    .bind(&entry.ended_at)
    .bind(entry.end_reason.as_str())
    .execute(pool)
    .await?;
    Ok(())
}

/// Tuple shape of one row pulled from `shared_link_history`. Aliased
/// because the column count makes the inline tuple trip
/// `clippy::type_complexity`. Kept private — callers consume
/// `HistoryEntry`.
type HistoryRow = (
    String,         // share_token
    Option<String>, // filename
    Option<String>, // folder_label
    Option<String>, // relative_path
    Option<i64>,    // plaintext_size
    Option<String>, // mime_type
    String,         // created_at
    Option<String>, // expires_at (NULL for a never-expiring share)
    String,         // ended_at
    String,         // end_reason
);

/// List all history rows for an account, newest first. Ordering is
/// `ended_at DESC` so the FE can paginate from the most recent without
/// a re-sort.
///
/// # Errors
/// Returns the underlying `sqlx::Error` on connection or query failure.
pub async fn list_for_account(pool: &SqlitePool, account_id: &str) -> Result<Vec<HistoryEntry>, sqlx::Error> {
    // Pull the raw `end_reason` as String and re-validate via
    // `EndReason::from_db_str`. An unknown value (schema drift,
    // hand-edited DB) becomes a hard error rather than a silent skip
    // so the FE never gets a row whose reason it can't render.
    let rows: Vec<HistoryRow> = sqlx::query_as(
        "SELECT share_token, filename, folder_label, relative_path,
                plaintext_size, mime_type, created_at, expires_at, ended_at, end_reason
         FROM shared_link_history
         WHERE account_id = ?
         ORDER BY ended_at DESC",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for (share_token, filename, folder_label, relative_path, plaintext_size, mime_type, created_at, expires_at, ended_at, end_reason_raw) in rows {
        let end_reason = EndReason::from_db_str(&end_reason_raw).ok_or_else(|| {
            // Surface unknown column values as a decode error so the
            // IPC's `?` operator turns it into `AppError::Db` and the
            // FE shows a proper error rather than a half-rendered row.
            sqlx::Error::Decode(format!("unknown shared_link_history.end_reason: {end_reason_raw}").into())
        })?;
        out.push(HistoryEntry {
            share_token,
            filename,
            folder_label,
            relative_path,
            plaintext_size,
            mime_type,
            created_at,
            expires_at,
            ended_at,
            end_reason,
        });
    }
    Ok(out)
}

/// Remove a single history row. Idempotent — calling on a missing
/// `(account_id, share_token)` pair is a no-op.
///
/// # Errors
/// Returns the underlying `sqlx::Error` on connection failure.
pub async fn remove_one(pool: &SqlitePool, account_id: &str, share_token: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM shared_link_history WHERE account_id = ? AND share_token = ?")
        .bind(account_id)
        .bind(share_token)
        .execute(pool)
        .await?;
    Ok(())
}

/// Bulk clear all history rows for an account. Scoped by `account_id`
/// so a multi-account install never wipes another account's history.
///
/// # Errors
/// Returns the underlying `sqlx::Error` on connection failure.
pub async fn clear_all_for_account(pool: &SqlitePool, account_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM shared_link_history WHERE account_id = ?")
        .bind(account_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Build a `HistoryEntry` from an upstream `ShareSummary` plus the
/// derived `(end_reason, ended_at)` pair. Centralises the field
/// mapping so the diff path and the explicit-revoke path can't drift
/// apart.
fn entry_from_upstream(summary: &UpstreamShareSummary, ended_at: DateTime<Utc>, end_reason: EndReason) -> HistoryEntry {
    // `plaintext_size` is `u64` upstream but stored as `INTEGER` in
    // SQLite (signed 64-bit). For shares this is bounded by hcfs-server's
    // size limit, which is well under `i64::MAX`; cast via `try_from` to
    // surface the impossible-but-typed-violation as a `None` instead of
    // a panic. Source: SQLite type docs (max INTEGER is 2^63 - 1).
    let plaintext_size = i64::try_from(summary.plaintext_size).ok();
    HistoryEntry {
        share_token: summary.share_token.clone(),
        filename: Some(summary.filename.clone()),
        folder_label: None,
        relative_path: None,
        plaintext_size,
        mime_type: Some(summary.mime_type.clone()),
        created_at: summary.created_at.to_rfc3339(),
        expires_at: summary.expires_at.map(|e| e.to_rfc3339()),
        ended_at: ended_at.to_rfc3339(),
        end_reason,
    }
}

/// Diff two consecutive `list_shares` results to detect rows that
/// have left the active set.
///
/// `now` is parameterised so tests can pin the clock; production callers
/// pass `chrono::Utc::now()`.
///
/// For each row in `previous` whose `share_token` is NOT in `current`,
/// classify:
/// - `expires_at <= now` → [`EndReason::Expired`]
/// - `expires_at >  now` → [`EndReason::RevokedElsewhere`]
/// - `expires_at` is `None` (never expires) → [`EndReason::RevokedElsewhere`],
///   since the only way such a share can leave the active set is revocation.
///
/// Tokens that are still in `current` produce no event. If they later
/// expire or vanish, a future call will surface them — diffing is
/// cumulative across calls, not session-bound.
#[must_use]
pub fn diff_active_lists(previous: &[UpstreamShareSummary], current: &[UpstreamShareSummary], now: DateTime<Utc>) -> Vec<HistoryEvent> {
    // Index `current` by token for O(1) "is it still active?" lookup.
    // `HashSet` is the right shape: we only need membership, never the
    // associated row. `&str` borrows from the slice's `String`s, which
    // outlive this call.
    let current_tokens: HashSet<&str> = current.iter().map(|s| s.share_token.as_str()).collect();

    let mut events = Vec::new();
    for prev in previous {
        if current_tokens.contains(prev.share_token.as_str()) {
            continue;
        }
        let end_reason = if prev.expires_at.is_some_and(|e| e <= now) {
            EndReason::Expired
        } else {
            EndReason::RevokedElsewhere
        };
        events.push(HistoryEvent {
            end_reason,
            entry: entry_from_upstream(prev, now, end_reason),
        });
    }
    events
}

/// Build a `HistoryEntry` for a token revoked from this device. The
/// upstream `ShareSummary` (when we have one cached) gives us
/// filename/mime/timestamps; otherwise the entry is "minimal but
/// complete" with `None`s for the metadata we never saw.
///
/// Used by `hcfs_revoke_share`. Centralised here rather than inline in
/// the IPC so the field set stays in lockstep with `entry_from_upstream`.
#[must_use]
pub fn entry_for_revoke_here(share_token: String, cached: Option<&UpstreamShareSummary>, now: DateTime<Utc>) -> HistoryEntry {
    if let Some(summary) = cached {
        return entry_from_upstream(summary, now, EndReason::RevokedHere);
    }
    // No cached metadata — record only the load-bearing fields. The FE
    // already knows how to render a row whose filename/size are
    // missing (cross-device shares hit the same path).
    HistoryEntry {
        share_token,
        filename: None,
        folder_label: None,
        relative_path: None,
        plaintext_size: None,
        mime_type: None,
        // Without a cached summary we don't know when the token was
        // minted or when it was set to expire. `now` is the only
        // honest answer we can give for both, and downstream the FE
        // shows "Ended <relative time>" anyway. Marking `created_at`
        // and `expires_at` as `now` keeps the columns NOT NULL without
        // inventing a timestamp from a different timezone or epoch.
        created_at: now.to_rfc3339(),
        expires_at: Some(now.to_rfc3339()),
        ended_at: now.to_rfc3339(),
        end_reason: EndReason::RevokedHere,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use tempfile::TempDir;

    /// Build a fake upstream `ShareSummary` whose `expires_at = now + offset`.
    /// `now` defaults to `Utc::now()` rounded to seconds for stable RFC3339
    /// formatting in equality checks.
    fn mk_summary(token: &str, offset: Duration) -> UpstreamShareSummary {
        let now = Utc::now();
        UpstreamShareSummary {
            share_token: token.to_string(),
            filename: format!("{token}.bin"),
            plaintext_size: 1234,
            ciphertext_size: 1280,
            mime_type: "application/octet-stream".to_string(),
            created_at: now,
            expires_at: Some(now + offset),
        }
    }

    async fn fresh_pool() -> (TempDir, SqlitePool) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("test.db");
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))
            .expect("opts")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.expect("pool");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");
        (dir, pool)
    }

    // ── diff_active_lists ─────────────────────────────────────────────

    #[test]
    fn no_diff_for_unchanged_lists() {
        let now = Utc::now();
        let row = mk_summary("tok", Duration::days(1));
        let events = diff_active_lists(std::slice::from_ref(&row), std::slice::from_ref(&row), now);
        assert!(events.is_empty(), "unchanged list must produce no events");
    }

    #[test]
    fn row_removed_after_expiry_is_expired() {
        let now = Utc::now();
        let row = mk_summary("tok", Duration::minutes(-1)); // already expired
        let events = diff_active_lists(&[row], &[], now);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].end_reason, EndReason::Expired);
        assert_eq!(events[0].entry.share_token, "tok");
    }

    #[test]
    fn row_removed_before_expiry_is_revoked_elsewhere() {
        let now = Utc::now();
        let row = mk_summary("tok", Duration::days(1)); // still future
        let events = diff_active_lists(&[row], &[], now);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].end_reason, EndReason::RevokedElsewhere);
    }

    #[test]
    fn idempotent_upsert_under_repeat_diffs() {
        // Same input twice produces the same event each time. Caller's
        // `record_event` upsert is idempotent on PRIMARY KEY (account_id,
        // share_token), but pin the diff alone here.
        let now = Utc::now();
        let row = mk_summary("tok", Duration::minutes(-1));
        let first = diff_active_lists(std::slice::from_ref(&row), &[], now);
        let second = diff_active_lists(std::slice::from_ref(&row), &[], now);
        assert_eq!(first, second);
    }

    #[test]
    fn diff_only_emits_for_removed_tokens() {
        // Mixed input: one token still active, one expired-and-removed,
        // one revoked-elsewhere-and-removed. Only the removed two
        // should produce events.
        let now = Utc::now();
        let still_active = mk_summary("active", Duration::days(1));
        let expired = mk_summary("expired", Duration::minutes(-5));
        let revoked = mk_summary("revoked", Duration::days(2));
        let prev = vec![still_active.clone(), expired, revoked];
        let curr = vec![still_active];
        let events = diff_active_lists(&prev, &curr, now);
        assert_eq!(events.len(), 2);
        let by_token: std::collections::HashMap<&str, EndReason> = events.iter().map(|e| (e.entry.share_token.as_str(), e.end_reason)).collect();
        assert_eq!(by_token.get("expired"), Some(&EndReason::Expired));
        assert_eq!(by_token.get("revoked"), Some(&EndReason::RevokedElsewhere));
        assert!(!by_token.contains_key("active"));
    }

    // ── EndReason round-trip ──────────────────────────────────────────

    #[test]
    fn end_reason_db_strings_round_trip() {
        for reason in [EndReason::Expired, EndReason::RevokedHere, EndReason::RevokedElsewhere] {
            let s = reason.as_str();
            assert_eq!(EndReason::from_db_str(s), Some(reason), "round-trip failed for {reason:?}");
        }
        assert_eq!(EndReason::from_db_str("garbage"), None);
    }

    #[test]
    fn end_reason_serde_matches_db_string() {
        // Wire format and DB column must agree by construction. If a
        // future serde rename happens, this breaks before the FE does.
        for (reason, expected) in [
            (EndReason::Expired, "\"expired\""),
            (EndReason::RevokedHere, "\"revoked_here\""),
            (EndReason::RevokedElsewhere, "\"revoked_elsewhere\""),
        ] {
            let json = serde_json::to_string(&reason).expect("serialize");
            assert_eq!(json, expected);
        }
    }

    // ── DB integration ────────────────────────────────────────────────

    fn mk_entry(token: &str, reason: EndReason) -> HistoryEntry {
        let now = Utc::now();
        HistoryEntry {
            share_token: token.to_string(),
            filename: Some(format!("{token}.bin")),
            folder_label: Some("Drive".to_string()),
            relative_path: Some(format!("path/{token}")),
            plaintext_size: Some(42),
            mime_type: Some("text/plain".to_string()),
            created_at: now.to_rfc3339(),
            expires_at: Some((now + Duration::hours(1)).to_rfc3339()),
            ended_at: now.to_rfc3339(),
            end_reason: reason,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn record_then_list_returns_row() {
        let (_dir, pool) = fresh_pool().await;
        let entry = mk_entry("tok-a", EndReason::Expired);
        record_event(&pool, "acct-1", &entry).await.expect("record");
        let rows = list_for_account(&pool, "acct-1").await.expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0], entry);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn record_event_is_idempotent_on_repeat() {
        // Writing the same row twice must produce one row, not two —
        // the PRIMARY KEY (account_id, share_token) plus ON CONFLICT
        // ... DO UPDATE handles the dedup. Pin it explicitly so a
        // future refactor that drops the upsert clause fails this test.
        let (_dir, pool) = fresh_pool().await;
        let entry = mk_entry("tok", EndReason::Expired);
        record_event(&pool, "acct", &entry).await.expect("record-1");
        record_event(&pool, "acct", &entry).await.expect("record-2");
        let rows = list_for_account(&pool, "acct").await.expect("list");
        assert_eq!(rows.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn record_event_overwrites_on_reason_correction() {
        // The diff path can record an Expired row that a later refine
        // upgrades to RevokedElsewhere (or vice versa). The upsert
        // must let the second write win.
        let (_dir, pool) = fresh_pool().await;
        let mut entry = mk_entry("tok", EndReason::Expired);
        record_event(&pool, "acct", &entry).await.expect("record-1");
        entry.end_reason = EndReason::RevokedElsewhere;
        record_event(&pool, "acct", &entry).await.expect("record-2");
        let rows = list_for_account(&pool, "acct").await.expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].end_reason, EndReason::RevokedElsewhere);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_orders_newest_first_per_account() {
        let (_dir, pool) = fresh_pool().await;
        // Build rows with explicit `ended_at` so the order is
        // deterministic regardless of insert timing.
        let now = Utc::now();
        let mut older = mk_entry("older", EndReason::Expired);
        older.ended_at = (now - Duration::hours(2)).to_rfc3339();
        let mut newer = mk_entry("newer", EndReason::Expired);
        newer.ended_at = (now - Duration::minutes(5)).to_rfc3339();
        record_event(&pool, "acct", &older).await.expect("record-older");
        record_event(&pool, "acct", &newer).await.expect("record-newer");
        let rows = list_for_account(&pool, "acct").await.expect("list");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].share_token, "newer");
        assert_eq!(rows[1].share_token, "older");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_is_scoped_per_account() {
        let (_dir, pool) = fresh_pool().await;
        record_event(&pool, "acct-A", &mk_entry("tok", EndReason::Expired)).await.expect("A");
        record_event(&pool, "acct-B", &mk_entry("tok", EndReason::RevokedHere)).await.expect("B");
        let a = list_for_account(&pool, "acct-A").await.expect("list-A");
        let b = list_for_account(&pool, "acct-B").await.expect("list-B");
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1);
        assert_eq!(a[0].end_reason, EndReason::Expired);
        assert_eq!(b[0].end_reason, EndReason::RevokedHere);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remove_one_is_idempotent() {
        let (_dir, pool) = fresh_pool().await;
        // Removing a missing row is a no-op (idempotent).
        remove_one(&pool, "acct", "never-existed").await.expect("remove-missing");
        record_event(&pool, "acct", &mk_entry("tok", EndReason::Expired)).await.expect("record");
        remove_one(&pool, "acct", "tok").await.expect("remove-existing");
        remove_one(&pool, "acct", "tok").await.expect("remove-twice");
        let rows = list_for_account(&pool, "acct").await.expect("list");
        assert!(rows.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remove_one_only_targets_named_account() {
        let (_dir, pool) = fresh_pool().await;
        record_event(&pool, "acct-A", &mk_entry("tok", EndReason::Expired)).await.expect("A");
        record_event(&pool, "acct-B", &mk_entry("tok", EndReason::Expired)).await.expect("B");
        remove_one(&pool, "acct-A", "tok").await.expect("remove-A");
        assert!(list_for_account(&pool, "acct-A").await.expect("list-A").is_empty());
        assert_eq!(list_for_account(&pool, "acct-B").await.expect("list-B").len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn clear_all_only_clears_named_account() {
        let (_dir, pool) = fresh_pool().await;
        record_event(&pool, "acct-A", &mk_entry("a1", EndReason::Expired)).await.expect("A1");
        record_event(&pool, "acct-A", &mk_entry("a2", EndReason::RevokedHere)).await.expect("A2");
        record_event(&pool, "acct-B", &mk_entry("b1", EndReason::Expired)).await.expect("B1");
        clear_all_for_account(&pool, "acct-A").await.expect("clear-A");
        assert!(list_for_account(&pool, "acct-A").await.expect("list-A").is_empty());
        assert_eq!(list_for_account(&pool, "acct-B").await.expect("list-B").len(), 1);
    }

    // ── entry_for_revoke_here ─────────────────────────────────────────

    #[test]
    fn entry_for_revoke_here_with_cached_uses_summary_metadata() {
        let now = Utc::now();
        let summary = mk_summary("tok", Duration::hours(1));
        let entry = entry_for_revoke_here("tok".to_string(), Some(&summary), now);
        assert_eq!(entry.share_token, "tok");
        assert_eq!(entry.filename, Some("tok.bin".to_string()));
        assert_eq!(entry.mime_type, Some("application/octet-stream".to_string()));
        assert_eq!(entry.plaintext_size, Some(1234));
        assert_eq!(entry.end_reason, EndReason::RevokedHere);
    }

    #[test]
    fn entry_for_revoke_here_without_cached_is_minimal() {
        let now = Utc::now();
        let entry = entry_for_revoke_here("tok".to_string(), None, now);
        assert_eq!(entry.share_token, "tok");
        assert_eq!(entry.filename, None);
        assert_eq!(entry.plaintext_size, None);
        assert_eq!(entry.created_at, now.to_rfc3339());
        assert_eq!(entry.expires_at, Some(now.to_rfc3339()));
        assert_eq!(entry.end_reason, EndReason::RevokedHere);
    }
}
