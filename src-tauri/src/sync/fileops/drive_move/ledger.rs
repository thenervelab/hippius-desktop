//! The moves this computer has opened and not yet seen end, so a move a
//! crash (or a quit, or a lost connection) left open is aborted at the next
//! launch instead of holding the destination's room until it expires a day
//! later.
//!
//! Each move is noted twice: in this process's running set, the moment the
//! server names it, and in SQLite (`drive_moves_open`), so it outlives the
//! process. Both are dropped when the move ends: a commit that lands, or an
//! abort the server confirmed (or answers was already over). A commit that
//! got no answer stays noted: it may not have landed.
//!
//! # Which open moves the launch sweep aborts
//!
//! `GET /v1/drive_moves` lists every open move this ACCOUNT opened, on any
//! device. The sweep ([`left_behind`]) aborts one only when:
//!
//! - this computer noted opening it, and no move in this app is running it
//!   now (a move started after launch is in the running set before its row
//!   is written, so a row the sweep reads is never one of them while it
//!   runs); or
//! - it has expired: the server refuses every stage and commit of it, so
//!   nothing can still be running it, and aborting only frees its room
//!   before the hourly sweep would.
//!
//! A move another device opened is never aborted while it can still commit:
//! that device may be running it right now. It frees itself when it
//! expires.

use super::wire::OpenDriveMove;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

/// The moves this process has opened and not seen end.
pub type RunningMoves = Arc<Mutex<HashSet<String>>>;

/// Where one account's moves are noted.
#[derive(Clone)]
pub struct MoveLedger {
    /// `None` keeps the note in memory only (tests).
    pub pool: Option<sqlx::SqlitePool>,
    /// `account_key` of the account the moves are opened as.
    pub owner: String,
    pub running: RunningMoves,
}

impl MoveLedger {
    /// The server just opened `move_id`. Running first, then the row: a row
    /// the launch sweep can read is never one of a move it might still miss
    /// in the running set.
    pub async fn opened(&self, move_id: &str) {
        lock(&self.running).insert(move_id.to_string());
        if let Some(pool) = &self.pool
            && let Err(e) = record(pool, &self.owner, move_id, chrono::Utc::now().timestamp()).await
        {
            // Only the crash case is lost: the move itself carries on, and
            // the server frees it within a day if it is left open.
            tracing::warn!(error = %e, "drive move: could not note the open move");
        }
    }

    /// `move_id` is over: committed, or aborted.
    pub async fn ended(&self, move_id: &str) {
        if let Some(pool) = &self.pool
            && let Err(e) = forget(pool, &self.owner, move_id).await
        {
            tracing::debug!(error = %e, "drive move: could not drop the note of a finished move");
        }
        lock(&self.running).remove(move_id);
    }

    /// The moves this process is running now.
    pub fn running_now(&self) -> HashSet<String> {
        lock(&self.running).clone()
    }
}

fn lock(running: &RunningMoves) -> std::sync::MutexGuard<'_, HashSet<String>> {
    running.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Note an open move.
pub async fn record(pool: &sqlx::SqlitePool, owner: &str, move_id: &str, opened_at: i64) -> sqlx::Result<()> {
    sqlx::query("INSERT OR IGNORE INTO drive_moves_open (owner, move_id, opened_at) VALUES (?, ?, ?)")
        .bind(owner)
        .bind(move_id)
        .bind(opened_at)
        .execute(pool)
        .await?;
    Ok(())
}

/// Drop the note of a move.
pub async fn forget(pool: &sqlx::SqlitePool, owner: &str, move_id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM drive_moves_open WHERE owner = ? AND move_id = ?")
        .bind(owner)
        .bind(move_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// The moves noted for `owner`.
pub async fn noted(pool: &sqlx::SqlitePool, owner: &str) -> sqlx::Result<HashSet<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT move_id FROM drive_moves_open WHERE owner = ?")
        .bind(owner)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// What the launch sweep does with the open moves the server lists.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Sweep {
    /// Open moves to abort (see the module docs for the rule).
    pub abort: Vec<String>,
    /// Notes of moves the server no longer lists (they committed, were
    /// aborted, or were swept): nothing to abort, so the note goes.
    pub forget: Vec<String>,
}

/// Decide the sweep. `noted` must be read BEFORE `running` is: a move this
/// process starts meanwhile is running before it is noted, so it is either
/// not in `noted` or in `running`.
#[must_use]
pub fn left_behind<S: std::hash::BuildHasher, R: std::hash::BuildHasher>(
    listed: &[OpenDriveMove],
    noted: &HashSet<String, S>,
    running: &HashSet<String, R>,
    now: i64,
) -> Sweep {
    let abort = listed
        .iter()
        .filter(|m| !running.contains(&m.move_id))
        .filter(|m| noted.contains(&m.move_id) || m.expires_at <= now)
        .map(|m| m.move_id.clone())
        .collect();
    let listed_ids: HashSet<&str> = listed.iter().map(|m| m.move_id.as_str()).collect();
    let mut forget: Vec<String> = noted
        .iter()
        .filter(|id| !listed_ids.contains(id.as_str()) && !running.contains(*id))
        .cloned()
        .collect();
    forget.sort();
    Sweep { abort, forget }
}

#[cfg(test)]
mod tests {
    use super::super::wire::DriveRef;
    use super::*;

    fn open(id: &str, expires_at: i64) -> OpenDriveMove {
        let drive = DriveRef {
            ss58_address: "5Owner".into(),
            folder_hash: "0123456789abcdef".into(),
        };
        OpenDriveMove {
            move_id: id.into(),
            source: drive.clone(),
            dest: drive,
            created_at: expires_at - 86_400,
            expires_at,
            staged_files: 1,
            staged_bytes: 10,
        }
    }

    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn only_a_move_this_computer_left_behind_or_an_expired_one_is_aborted() {
        let now = 1_000_000;
        let listed = [
            open("mine-crashed", now + 3_600),
            open("mine-running", now + 3_600),
            open("other-device", now + 3_600),
            open("other-device-expired", now - 1),
        ];
        let sweep = left_behind(
            &listed,
            &set(&["mine-crashed", "mine-running", "mine-done"]),
            &set(&["mine-running"]),
            now,
        );
        assert_eq!(sweep.abort, vec!["mine-crashed".to_string(), "other-device-expired".to_string()]);
        assert_eq!(sweep.forget, vec!["mine-done".to_string()], "a note the server no longer lists goes");
    }

    #[test]
    fn a_running_move_is_never_aborted_even_when_expired() {
        let now = 1_000_000;
        let sweep = left_behind(&[open("m", now - 10)], &set(&["m"]), &set(&["m"]), now);
        assert!(sweep.abort.is_empty());
        assert!(sweep.forget.is_empty());
    }

    #[test]
    fn a_running_moves_note_is_kept_while_the_server_does_not_list_it_yet() {
        let sweep = left_behind(&[], &set(&["new"]), &set(&["new"]), 0);
        assert_eq!(sweep, Sweep::default());
    }

    #[tokio::test]
    async fn the_ledger_notes_a_move_until_it_ends() {
        // The app's own schema, so the table this reads is the one it makes.
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::utils::schema::ensure_table_schema(&pool).await.unwrap();
        let ledger = MoveLedger {
            pool: Some(pool.clone()),
            owner: "a".into(),
            running: RunningMoves::default(),
        };
        ledger.opened("m1").await;
        assert_eq!(noted(&pool, "a").await.unwrap(), set(&["m1"]));
        assert!(noted(&pool, "b").await.unwrap().is_empty(), "per account");
        assert_eq!(ledger.running_now(), set(&["m1"]));
        ledger.ended("m1").await;
        assert!(noted(&pool, "a").await.unwrap().is_empty());
        assert!(ledger.running_now().is_empty());
    }
}
