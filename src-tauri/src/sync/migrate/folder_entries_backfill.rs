//! One-shot folder-entity backfill for drives created before first-class
//! empty folders existed server-side.
//!
//! Phase 1 Task 1.12 of the first-class-empty-folders plan.
//!
//! # Why this exists
//!
//! An empty directory leaves no trace in the sync engine's `path_index` —
//! that map is keyed by *file* `path_hash`, and an empty folder has no files.
//! So a drive that predates the `folder_entries` server table has its empty
//! (and otherwise file-less) directories invisible to every other device: the
//! `/browse` endpoint only knew about directories implied by file paths. This
//! one-shot pass walks the drive's on-disk tree, collects EVERY directory's
//! drive-relative path, and registers them as server folder entities so the
//! folders persist and surface on other devices.
//!
//! # Why a directory walk, not `path_index`
//!
//! The sibling [`crate::sync::relative_path_backfill`] reads the in-memory
//! `path_index`. That source is wrong here by construction: empty dirs aren't
//! in it. The authoritative source for "which directories exist" is the
//! filesystem, so this backfill walks the sync root directly.
//!
//! # State machine
//!
//! The backfill state lives in `sync_paths.folder_entries_backfilled_at`:
//!
//! - `NULL` → pending. Retries on next launch.
//! - `Some(unix_epoch_seconds)` → done. Never retries again.
//!
//! A single fully-successful pass sets the timestamp. Any transient failure
//! (network, server error, drive path momentarily unreadable) leaves the row
//! NULL so the next launch picks it up. Server-side registration is idempotent
//! and the local cache write is `INSERT OR IGNORE`, so re-running a partially
//! completed pass is safe.
//!
//! # Why it runs on a detached task
//!
//! Drive init must not block on the directory walk + HTTP round-trips. We spawn
//! a background task from [`crate::sync::lifecycle::initialize_sync_inner`]
//! after the drive has transitioned to Active; any failure is logged and
//! forgotten — the next launch gets another chance.

use crate::app_state::AppState;
use crate::auth::account_key::account_key;
use crate::auth::tokens::get_api_token;
use crate::error::{AppError, Result};
use crate::sync::config::{build_hcfs_config, get_sync_path_for_label};
use crate::sync::mnemonic::folder_hash;
use crate::sync::remote::get_server_url;
use hcfs_client::client::HcfsClient;
use hcfs_shared::network::MAX_REGISTER_RELATIVE_PATHS_BATCH;
use sqlx::sqlite::SqlitePool;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use tracing::{debug, info, warn};

/// Outcome of a single folder-entity backfill attempt for one drive.
///
/// Mirrors [`crate::sync::relative_path_backfill::BackfillOutcome`]'s rich-enum
/// shape so the startup dispatcher stays honest: network-flavoured failures are
/// retryable (`RetryLater`), the gate short-circuits (`AlreadyDone`), an absent
/// sync root is transient (`NotReady`), and only genuinely unexpected
/// conditions (DB corruption) surface via the outer `Result::Err`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FolderEntriesBackfillOutcome {
    /// The flag was already set — this drive is done and will never retry.
    AlreadyDone,
    /// The sync root isn't on disk yet (drive not finished initializing).
    /// Harmless — the next launch or `initialize_sync_inner` retries.
    NotReady,
    /// The label names a MEMBER drive (shared-drives phase 2). Folder
    /// entities are a v1 scope cut for member drives — the server entities
    /// belong to the OWNER's namespace and must not be registered from a
    /// member device. The flag is stamped (this is final, not transient) so
    /// the drive doesn't re-walk on every launch.
    SkippedMemberDrive,
    /// A transient failure (walk I/O error, network error, missing client
    /// config). Flag stays NULL so the next launch retries.
    RetryLater,
    /// Every directory was registered and the flag has been set. Never runs
    /// again for this drive. `total_dirs` is the number of directories the
    /// walk found (zero is legitimate — a drive with no subdirectories).
    Completed { total_dirs: u64 },
}

/// Run a one-shot folder-entity backfill for the drive with the given label.
///
/// See [module docs][self] for the full state machine.
///
/// Network, walk-I/O, and client-config errors become `Ok(RetryLater)`/
/// `Ok(NotReady)` — only programmer errors (DB corruption, account-key lookup
/// failures) surface as `Err(AppError)`. The caller-side spawn in
/// [`crate::sync::lifecycle::initialize_sync_inner`] relies on this so one
/// drive's flakiness doesn't take down the whole startup sweep.
///
/// NOTE: the full walk→register→cache→flag happy path's NETWORK round-trip is
/// exercised by the Task 1.15 real-backend harness, not a mock. The hermetic
/// unit tests below cover the pure walk, the cache+flag persistence, and the
/// gate; the static regression test pins the spawn wiring.
pub async fn run_folder_entries_backfill_for_drive(state: &AppState, account_id: &str, label: &str) -> Result<FolderEntriesBackfillOutcome> {
    let pool = state.pool()?.clone();
    let owner = account_key(account_id);

    // 1. Gate: skip if the flag is already set. Cheap read so the detached
    //    task collapses into a no-op when an older invocation already won.
    if is_folder_entries_backfilled(&pool, &owner, label).await? {
        return Ok(FolderEntriesBackfillOutcome::AlreadyDone);
    }

    // 1.5. Member drives never run the folder-entity jobs (v1 scope cut —
    //      the entities live under the OWNER's namespace). Stamp the flag so
    //      this decision is made once, not re-walked every launch; the
    //      per-cycle folder-entity sync carries its own member gate, so the
    //      stamped flag cannot accidentally enable it.
    // A vanished row (`None`) means a remove_drive / logout race between the
    // flag check and here — the same transient state the later root lookup
    // reported as NotReady before this gate existed.
    let Some(identity) = crate::sync::identity::lookup_drive_identity(&pool, account_id, label).await? else {
        return Ok(FolderEntriesBackfillOutcome::NotReady);
    };
    if identity.is_member {
        info!(label = %label, "folder-entries backfill: member drive; folder entities are owner-side — marking done");
        mark_folder_entries_backfilled(&pool, &owner, label).await?;
        return Ok(FolderEntriesBackfillOutcome::SkippedMemberDrive);
    }

    // 2. Resolve the on-disk sync root. Unlike the relative-path backfill we
    //    don't need the drive registered/unlocked — the filesystem is the
    //    source of truth. A missing path means init hasn't created the dir
    //    yet (transient); treat as NotReady and retry next launch.
    let sync_root = match get_sync_path_for_label(&pool, account_id, label).await {
        Ok(p) => PathBuf::from(p),
        Err(e) => {
            debug!(label = %label, error = %e, "folder-entries backfill: no sync_paths row; not ready");
            return Ok(FolderEntriesBackfillOutcome::NotReady);
        }
    };
    if !sync_root.is_dir() {
        debug!(label = %label, root = %sync_root.display(), "folder-entries backfill: sync root not on disk yet; not ready");
        return Ok(FolderEntriesBackfillOutcome::NotReady);
    }

    // 3. Walk the tree for every directory's drive-relative path. On a real
    //    drive (tens of thousands of dirs) the synchronous `read_dir` walk is
    //    a long run of blocking syscalls, so it runs on `spawn_blocking` to
    //    keep the tokio runtime — and the sync engine sharing it — responsive
    //    (mirrors the cousin backfill's "we don't block the sync engine"). A
    //    walk I/O error is transient (a folder being moved/locked mid-walk),
    //    so retry.
    let walk = tokio::task::spawn_blocking(move || collect_directory_rel_paths(&sync_root))
        .await
        // tokio JoinError (the blocking walk panicked) has no typed variant →
        // documented Other; the inner walk io::Error is matched below.
        .map_err(|e| AppError::Other(format!("Join error walking sync root for folder-entries backfill: {e}")))?;
    let dir_paths = match walk {
        Ok(p) => p,
        Err(e) => {
            warn!(label = %label, error = %e, "folder-entries backfill: directory walk failed; will retry next launch");
            return Ok(FolderEntriesBackfillOutcome::RetryLater);
        }
    };

    if dir_paths.is_empty() {
        // No subdirectories — a legitimate "nothing to backfill" case. Mark
        // the flag so we don't re-walk a flat drive on every launch.
        info!(label = %label, "folder-entries backfill: no directories; marking drive done");
        mark_folder_entries_backfilled(&pool, &owner, label).await?;
        return Ok(FolderEntriesBackfillOutcome::Completed { total_dirs: 0 });
    }

    // 4. Build the one-shot HTTP client. A missing token / bad config is
    //    retryable — nothing about the drive is corrupt, the user just needs
    //    to finish logging in or wait.
    let client = match build_one_shot_client(&pool, account_id, label).await {
        Ok(c) => c,
        Err(e) => {
            warn!(label = %label, error = %e, "folder-entries backfill: could not build HCFS client; will retry next launch");
            return Ok(FolderEntriesBackfillOutcome::RetryLater);
        }
    };

    let fhash = folder_hash(label);
    let total_dirs = dir_paths.len() as u64;

    // 5. Register in chunks. After EACH chunk succeeds, persist its paths to
    //    the local cache (INSERT OR IGNORE) so a mid-way failure still records
    //    progress; the flag stays NULL so the next launch re-registers the
    //    rest (register is idempotent server-side). A chunk failure aborts the
    //    sweep as RetryLater without marking the flag.
    for chunk in dir_paths.chunks(MAX_REGISTER_RELATIVE_PATHS_BATCH) {
        // `register_folder_entries` takes the ss58 address; in this app the
        // `account_id` IS the substrate SS58 wire identity (the same value fed
        // to `build_hcfs_config` as `ss58_address` and to the relative-path
        // backfill's register call).
        if let Err(e) = client.register_folder_entries(account_id, &fhash, chunk).await {
            warn!(label = %label, error = %e, "folder-entries backfill: register_folder_entries failed; will retry next launch");
            return Ok(FolderEntriesBackfillOutcome::RetryLater);
        }
        cache_folder_entries(&pool, &owner, label, chunk).await?;
    }

    // 6. Every chunk accepted — set the flag so we never retry.
    mark_folder_entries_backfilled(&pool, &owner, label).await?;
    info!(label = %label, total = total_dirs, "folder-entries backfill: completed directory registration");
    Ok(FolderEntriesBackfillOutcome::Completed { total_dirs })
}

/// NFC-normalize a drive-relative path string.
///
/// macOS APFS/HFS+ return filenames in NFD (decomposed — `é` as `e` + combining
/// acute), and the server's `path_validator` hard-rejects any non-NFC path.
/// NFC recomposition is segment-local (never crosses `/`), so normalizing the
/// whole joined string is byte-equivalent to per-segment normalization and one
/// allocation cheaper — the same chokepoint hcfs-client uses for upload/rename
/// manifest paths and that [`crate::sync::relative_path_backfill`] uses for the
/// file backfill.
fn normalize_rel_path(rel: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    rel.nfc().collect()
}

/// Mirror of hcfs-client's `drive::exclude::should_skip_path` core rule: skip
/// the `.hippius` config directory and any hidden entry (name starting with
/// `.`). That helper is `pub(super)` upstream so it can't be reused directly;
/// the dot-prefix rule is the load-bearing part and is reproduced here.
///
/// follow-up: the user-defined `.hippius/exclude` glob rules (loaded via
/// `Drive::is_excluded` / `ExcludeRules::load`) are NOT applied here — reaching
/// them needs a live `Drive` instance, which isn't available at this disk-walk
/// site. A directory the user excluded from file sync would still be registered
/// as a folder entity. Acceptable for the one-shot bootstrap; closing it needs
/// an engine-side accessor over the drive's exclude rules.
fn is_skipped_dir_name(name: &str) -> bool {
    // The dot-prefix is the whole rule — `.hippius` is just its most important
    // instance (see doc above), so a separate `== ".hippius"` clause is dead.
    name.starts_with('.')
}

/// Walk `root`'s directory tree and return every subdirectory's drive-relative
/// path, NFC-normalized, forward-slash separated, no leading slash, sorted.
/// The root itself is excluded. Hidden / `.hippius` directories (and their
/// subtrees) are skipped.
///
/// Pure except for the `std::fs::read_dir` walk, so it's hermetically testable
/// on a `tempfile::tempdir()` tree. Iterative (explicit work-stack) rather than
/// recursive to avoid stack-depth limits on pathological trees. Rel paths are
/// assembled from path *segments* joined with `/` — never via `Path::display()`
/// or string-splitting — so the separator is forward-slash on every platform.
/// Non-UTF-8 directory names are skipped with a warning (they'd be rejected by
/// the server's path validator anyway), mirroring the file backfill's handling.
pub(crate) fn collect_directory_rel_paths(root: &Path) -> std::io::Result<Vec<String>> {
    // Work items: (absolute dir to read, its already-normalized rel prefix).
    // The root carries an empty prefix and is never emitted.
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    let mut out: Vec<String> = Vec::new();

    while let Some((dir, prefix)) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            // Use the cached dirent file-type where possible; fall back to a
            // stat only when the OS didn't provide it. Skipping symlinks keeps
            // the walk from escaping the sync root via a directory symlink.
            let file_type = entry.file_type()?;
            if !file_type.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                warn!(path = ?entry.path(), "folder-entries backfill: skipping non-UTF8 directory name");
                continue;
            };
            if is_skipped_dir_name(&name) {
                continue;
            }
            let rel = if prefix.is_empty() {
                normalize_rel_path(&name)
            } else {
                normalize_rel_path(&format!("{prefix}/{name}"))
            };
            stack.push((entry.path(), rel.clone()));
            out.push(rel);
        }
    }

    out.sort();
    Ok(out)
}

/// Cheap read of the folder-entities backfill timestamp column. `true` iff the
/// row exists AND the column is non-NULL.
pub(crate) async fn is_folder_entries_backfilled(pool: &SqlitePool, owner: &str, label: &str) -> Result<bool> {
    let row: Option<(Option<i64>,)> = sqlx::query_as("SELECT folder_entries_backfilled_at FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(owner)
        .bind(label)
        .fetch_optional(pool)
        .await?;
    Ok(matches!(row, Some((Some(_),))))
}

/// Persist a chunk of directory rel-paths into the per-drive `folder_entries_local`
/// cache. `INSERT OR IGNORE` makes the write idempotent against the composite
/// `PRIMARY KEY (owner, label, relative_path)`, so re-running a partially
/// completed backfill never duplicates or errors. Read-then-insert only — this
/// never deletes (the per-cycle reconcile, Task 1.13, owns removals).
pub(crate) async fn cache_folder_entries(pool: &SqlitePool, owner: &str, label: &str, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    for rel in paths {
        sqlx::query("INSERT OR IGNORE INTO folder_entries_local (owner, label, relative_path) VALUES (?, ?, ?)")
            .bind(owner)
            .bind(label)
            .bind(rel)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Drop every cached directory for one drive. Owner is the account-key
/// hash (`account_key(ss58)`), matching every other writer of this table.
pub(crate) async fn clear_folder_entries_for_drive(pool: &SqlitePool, owner: &str, label: &str) -> Result<()> {
    sqlx::query("DELETE FROM folder_entries_local WHERE owner = ? AND label = ?")
        .bind(owner)
        .bind(label)
        .execute(pool)
        .await?;
    Ok(())
}

/// Read a drive's cached folder-entity rel-paths as a set, scoped to owner+label.
///
/// Shared by both halves of the combined folder-entity sync — the reconcile reads
/// it as its pre-push view, the materialize re-reads it as its post-reconcile view
/// — so the two can never drift on the underlying query. Read-only.
pub(crate) async fn read_cached_dir_set(pool: &SqlitePool, owner: &str, label: &str) -> Result<BTreeSet<String>> {
    let rows = sqlx::query_scalar::<_, String>("SELECT relative_path FROM folder_entries_local WHERE owner = ? AND label = ?")
        .bind(owner)
        .bind(label)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().collect())
}

/// Walk a drive's sync root on a blocking thread and return its on-disk directory
/// set, or `None` on a (transient) walk I/O error or task panic.
///
/// This is the SINGLE per-cycle disk walk the combined folder-entity sync runs
/// once and feeds to BOTH the reconcile (disk→server) and materialize
/// (server→disk) halves, so they observe an identical on-disk view and there is
/// exactly one tree walk per cycle, not two. `collect_directory_rel_paths` is the
/// blocking `read_dir` walk, hence `spawn_blocking`.
pub(crate) async fn walk_on_disk_dir_set(sync_root: PathBuf, label: &str) -> Option<BTreeSet<String>> {
    match tokio::task::spawn_blocking(move || collect_directory_rel_paths(&sync_root)).await {
        Ok(Ok(paths)) => Some(paths.into_iter().collect()),
        Ok(Err(e)) => {
            warn!(label = %label, error = %e, "folder-entity sync: directory walk failed; will retry next cycle");
            None
        }
        Err(e) => {
            warn!(label = %label, error = %e, "folder-entity sync: directory walk task panicked; will retry next cycle");
            None
        }
    }
}

/// Set `folder_entries_backfilled_at` to the current Unix epoch. Idempotent: a
/// repeat just overwrites the (older) timestamp. A vanished row (logout /
/// remove_drive mid-backfill) is logged and ignored — there's nothing to mark.
async fn mark_folder_entries_backfilled(pool: &SqlitePool, owner: &str, label: &str) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    let affected = sqlx::query("UPDATE sync_paths SET folder_entries_backfilled_at = ? WHERE owner = ? AND label = ?")
        .bind(now)
        .bind(owner)
        .bind(label)
        .execute(pool)
        .await?
        .rows_affected();
    if affected == 0 {
        debug!(label = %label, "folder-entries backfill: row missing when marking; drive was removed concurrently");
    }
    Ok(())
}

/// Stand up a fresh `HcfsClient` for a one-shot folder-entity call, sharing the
/// sync engine's connection parameters via the canonical helpers
/// (`sync::remote::get_server_url`, `sync::config::build_hcfs_config`) so this
/// path can't drift from the engine's TLS/auth/billing-bypass behaviour. We do
/// NOT reuse the drive's own client — it lives behind the per-drive mutex, and
/// grabbing it would serialize against in-progress syncs for no reason.
///
/// `pub(crate)` so the sibling per-cycle reconcile
/// ([`crate::sync::folder_entries_reconcile`]) builds its client identically.
pub(crate) async fn build_one_shot_client(pool: &SqlitePool, account_id: &str, label: &str) -> Result<HcfsClient> {
    let server_url = get_server_url(pool, account_id).await?;
    let bearer_token = get_api_token(pool, account_id)
        .await?
        .ok_or_else(|| AppError::Auth("No authentication token found. Please log in again.".into()))?;
    // Structurally own-drive: every caller (this backfill, the per-cycle
    // reconcile/materialize) skips member drives before building a client —
    // the folder-entity jobs are a v1 scope cut for member drives — so the
    // label-derived hash is correct here.
    let config = build_hcfs_config(
        &server_url,
        &bearer_token,
        &crate::sync::identity::DriveIdentity::own(account_id, &folder_hash(label)),
    );
    HcfsClient::new(config).map_err(|e| AppError::Hcfs(format!("Failed to create HCFS client for folder-entries backfill: {e}")))
}

/// Spawn the folder-entity backfill as a detached tokio task.
///
/// Called from [`crate::sync::lifecycle::initialize_sync_inner`] at the end of
/// a successful drive init, right next to the relative-path backfill spawn. We
/// don't pre-check the flag here — `run_folder_entries_backfill_for_drive` does
/// it as its first step, and a spawn + one SELECT against the in-process pool
/// is sub-millisecond. All failure modes are logged inside the task; the caller
/// never awaits it. This is a single fire-and-forget task per init (not a
/// spawn-per-item loop), so it carries no unbounded-concurrency risk.
pub(crate) fn spawn_folder_entries_backfill(app: tauri::AppHandle, account_id: String, label: String) {
    tokio::spawn(async move {
        use tauri::Manager;
        let state = app.state::<AppState>();
        match run_folder_entries_backfill_for_drive(&state, &account_id, &label).await {
            Ok(FolderEntriesBackfillOutcome::Completed { total_dirs }) => {
                info!(label = %label, total = total_dirs, "folder-entries backfill task finished");
            }
            Ok(FolderEntriesBackfillOutcome::AlreadyDone) => {
                debug!(label = %label, "folder-entries backfill: already done; skipping");
            }
            Ok(FolderEntriesBackfillOutcome::NotReady) => {
                debug!(label = %label, "folder-entries backfill: drive not ready; will retry next launch");
            }
            Ok(FolderEntriesBackfillOutcome::SkippedMemberDrive) => {
                debug!(label = %label, "folder-entries backfill: member drive; folder entities stay owner-side");
            }
            Ok(FolderEntriesBackfillOutcome::RetryLater) => {
                debug!(label = %label, "folder-entries backfill: transient failure; will retry next launch");
            }
            Err(e) => {
                warn!(label = %label, error = ?e, "folder-entries backfill: unexpected error");
            }
        }
    });
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// In-memory pool with the production schema applied, so the
    /// `folder_entries_local` table and `folder_entries_backfilled_at` column
    /// stay in lockstep with production.
    async fn temp_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect sqlite::memory:");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");
        pool
    }

    async fn insert_sync_path(pool: &SqlitePool, owner: &str, label: &str, backfilled: Option<i64>) {
        sqlx::query(
            "INSERT INTO sync_paths (owner, path, type, label, timestamp, folder_entries_backfilled_at)
             VALUES (?, ?, 'private', ?, ?, ?)",
        )
        .bind(owner)
        .bind("/tmp/test-path")
        .bind(label)
        .bind(0i64)
        .bind(backfilled)
        .execute(pool)
        .await
        .expect("insert sync_paths");
    }

    async fn cached_paths(pool: &SqlitePool, owner: &str, label: &str) -> Vec<String> {
        sqlx::query_scalar::<_, String>("SELECT relative_path FROM folder_entries_local WHERE owner = ? AND label = ? ORDER BY relative_path")
            .bind(owner)
            .bind(label)
            .fetch_all(pool)
            .await
            .expect("select cached paths")
    }

    /// A synthetic substrate address. The orchestrator hashes it through
    /// `account_key` for the `owner` scope, so seed rows must use the SAME
    /// derivation — `insert_sync_path_for_account` does that.
    const TEST_ACCOUNT: &str = "TEST_ACCOUNT_folder_entries_backfill_xxxxxxxx";

    /// Seed a `sync_paths` row whose `owner` is `account_key(account_id)` (what
    /// the orchestrator looks up) and whose `path` is a real on-disk directory.
    async fn insert_sync_path_for_account(pool: &SqlitePool, account_id: &str, label: &str, path: &str) {
        sqlx::query(
            "INSERT INTO sync_paths (owner, path, type, label, timestamp, folder_entries_backfilled_at)
             VALUES (?, ?, 'private', ?, ?, NULL)",
        )
        .bind(account_key(account_id))
        .bind(path)
        .bind(label)
        .bind(0i64)
        .execute(pool)
        .await
        .expect("insert sync_paths");
    }

    /// `AppState` with only the DB pool injected. `AppState::new` touches no
    /// real service, so the orchestrator's non-network branches run hermetically.
    fn make_state(pool: SqlitePool) -> crate::app_state::AppState {
        let state = crate::app_state::AppState::new();
        state.set_pool(pool);
        state
    }

    /// The exact tree the task specifies: a top file, a non-empty subdir with a
    /// file, a nested empty dir (`a/b`), and a wholly-empty dir (`c`). Expect
    /// exactly the directories, root excluded, sorted: `["a", "a/b", "c"]`.
    #[test]
    fn collect_returns_only_dirs_root_excluded_sorted() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        std::fs::write(root.join("top.txt"), b"x").unwrap();
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/file.txt"), b"y").unwrap();
        std::fs::create_dir(root.join("c")).unwrap();

        let dirs = collect_directory_rel_paths(root).expect("walk");
        assert_eq!(dirs, vec!["a".to_string(), "a/b".to_string(), "c".to_string()]);
    }

    /// Hidden and `.hippius` directories (and their subtrees) are skipped, so
    /// the engine's config dir never becomes a server folder entity.
    #[test]
    fn collect_skips_hidden_and_hippius_dirs() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".hippius/state")).unwrap();
        std::fs::create_dir_all(root.join(".git/objects")).unwrap();
        std::fs::create_dir(root.join("visible")).unwrap();

        let dirs = collect_directory_rel_paths(root).expect("walk");
        assert_eq!(dirs, vec!["visible".to_string()]);
    }

    /// macOS APFS yields NFD; the server rejects non-NFC. A directory whose
    /// name is NFD must be emitted in NFC.
    #[test]
    fn collect_normalizes_nfd_dir_names_to_nfc() {
        use unicode_normalization::is_nfc;
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        // "café" / "résumé" in NFD: e + combining acute.
        std::fs::create_dir_all(root.join("cafe\u{0301}/re\u{0301}sume\u{0301}")).unwrap();

        let dirs = collect_directory_rel_paths(root).expect("walk");
        for d in &dirs {
            assert!(is_nfc(d), "rel path not NFC: {d:?}");
        }
        assert!(dirs.contains(&"caf\u{00E9}".to_string()));
        assert!(dirs.contains(&"caf\u{00E9}/r\u{00E9}sum\u{00E9}".to_string()));
    }

    /// Cache write persists rows scoped by owner; a second persist of the same
    /// paths is a no-op (INSERT OR IGNORE against the composite PK), and two
    /// owners' rows for the same label/path never collide.
    #[tokio::test]
    async fn cache_is_owner_scoped_and_idempotent() {
        let pool = temp_pool().await;
        let paths = vec!["a".to_string(), "a/b".to_string(), "c".to_string()];

        cache_folder_entries(&pool, "owner-a", "docs", &paths).await.unwrap();
        // Re-persist: must not error, must not duplicate.
        cache_folder_entries(&pool, "owner-a", "docs", &paths).await.unwrap();
        assert_eq!(cached_paths(&pool, "owner-a", "docs").await, paths);

        // A different owner with the same label/paths is isolated.
        cache_folder_entries(&pool, "owner-b", "docs", &["a".to_string()]).await.unwrap();
        assert_eq!(cached_paths(&pool, "owner-b", "docs").await, vec!["a".to_string()]);
        // owner-a is unchanged by owner-b's write.
        assert_eq!(cached_paths(&pool, "owner-a", "docs").await, paths);
    }

    #[tokio::test]
    async fn clear_folder_entries_for_drive_is_owner_and_label_scoped() {
        let pool = temp_pool().await;
        cache_folder_entries(&pool, "owner-a", "docs", &["a".into(), "a/b".into()]).await.unwrap();
        cache_folder_entries(&pool, "owner-a", "photos", &["p".into()]).await.unwrap();
        cache_folder_entries(&pool, "owner-b", "docs", &["a".into()]).await.unwrap();

        clear_folder_entries_for_drive(&pool, "owner-a", "docs").await.unwrap();
        assert!(cached_paths(&pool, "owner-a", "docs").await.is_empty());
        assert_eq!(cached_paths(&pool, "owner-a", "photos").await, vec!["p".to_string()]);
        assert_eq!(cached_paths(&pool, "owner-b", "docs").await, vec!["a".to_string()]);
    }

    /// The flag gate: NULL → false, set → true, and `mark` flips it. A second
    /// `run`-style gate check after marking short-circuits.
    #[tokio::test]
    async fn flag_gate_reflects_mark() {
        let pool = temp_pool().await;
        insert_sync_path(&pool, "owner-a", "docs", None).await;

        assert!(!is_folder_entries_backfilled(&pool, "owner-a", "docs").await.unwrap());
        mark_folder_entries_backfilled(&pool, "owner-a", "docs").await.unwrap();
        assert!(is_folder_entries_backfilled(&pool, "owner-a", "docs").await.unwrap());
    }

    #[tokio::test]
    async fn flag_is_false_when_row_missing() {
        let pool = temp_pool().await;
        assert!(!is_folder_entries_backfilled(&pool, "ghost", "nowhere").await.unwrap());
    }

    #[tokio::test]
    async fn mark_is_noop_when_row_missing() {
        let pool = temp_pool().await;
        // Must not error — the spawn-after-init task can race drive removal.
        mark_folder_entries_backfilled(&pool, "nobody", "nowhere").await.unwrap();
    }

    /// Chunking math: 501 entries split into two chunks at the 500 cap, so an
    /// oversized batch never reaches `register_folder_entries` (which rejects
    /// anything over the cap client-side).
    #[test]
    fn chunking_respects_max_batch_size() {
        let entries: Vec<String> = (0..501u32).map(|i| format!("dir_{i}")).collect();
        let chunks: Vec<&[String]> = entries.chunks(MAX_REGISTER_RELATIVE_PATHS_BATCH).collect();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), MAX_REGISTER_RELATIVE_PATHS_BATCH);
        assert_eq!(chunks[1].len(), 1);
    }

    /// Orchestration invariant: a drive whose tree has no subdirectories
    /// short-circuits to `Completed { total_dirs: 0 }` AND sets the flag — the
    /// empty-tree branch's mark coupling, so a flat drive isn't re-walked every
    /// launch. Hermetic: an empty tempdir means the run returns before
    /// `build_one_shot_client`, so no network/mock is involved.
    #[tokio::test]
    async fn run_marks_done_and_completes_on_empty_tree() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = temp_pool().await;
        insert_sync_path_for_account(&pool, TEST_ACCOUNT, "docs", tmp.path().to_str().unwrap()).await;
        let owner = account_key(TEST_ACCOUNT);
        assert!(!is_folder_entries_backfilled(&pool, &owner, "docs").await.unwrap(), "pre: flag NULL");

        let state = make_state(pool.clone());
        let outcome = run_folder_entries_backfill_for_drive(&state, TEST_ACCOUNT, "docs")
            .await
            .expect("run must not error on the empty-tree path");

        assert_eq!(outcome, FolderEntriesBackfillOutcome::Completed { total_dirs: 0 });
        assert!(
            is_folder_entries_backfilled(&pool, &owner, "docs").await.unwrap(),
            "empty-tree completion must set the flag so the drive isn't re-walked"
        );
    }

    /// Member gate: a member row (owner_ss58 + wire_folder_hash set) skips
    /// the walk and the wire entirely and STAMPS the flag — the decision is
    /// final, not transient, so the drive must not re-walk every launch and
    /// the FE's pre-backfill banner must clear. A broken gate would fall
    /// through to the walk and (here) return `RetryLater` on the missing
    /// client config, so the assertions distinguish the two.
    #[tokio::test]
    async fn run_skips_member_drives_and_stamps_the_flag() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // A subdir that WOULD be registered if the gate failed open.
        std::fs::create_dir(tmp.path().join("owner-made")).expect("mk subdir");
        let pool = temp_pool().await;
        insert_sync_path_for_account(&pool, TEST_ACCOUNT, "team", tmp.path().to_str().unwrap()).await;
        sqlx::query("UPDATE sync_paths SET owner_ss58 = ?, wire_folder_hash = ? WHERE owner = ? AND label = 'team'")
            .bind("5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty")
            .bind("0123456789abcdef")
            .bind(account_key(TEST_ACCOUNT))
            .execute(&pool)
            .await
            .expect("paint member columns");
        let owner = account_key(TEST_ACCOUNT);
        let state = make_state(pool.clone());

        let outcome = run_folder_entries_backfill_for_drive(&state, TEST_ACCOUNT, "team")
            .await
            .expect("member skip must not error");
        assert_eq!(outcome, FolderEntriesBackfillOutcome::SkippedMemberDrive);
        assert!(
            is_folder_entries_backfilled(&pool, &owner, "team").await.unwrap(),
            "the member skip must stamp the flag"
        );
        assert!(
            cached_paths(&pool, &owner, "team").await.is_empty(),
            "no directory may be cached for a member drive"
        );

        // A second run short-circuits on the stamped flag.
        let again = run_folder_entries_backfill_for_drive(&state, TEST_ACCOUNT, "team")
            .await
            .expect("second run must not error");
        assert_eq!(again, FolderEntriesBackfillOutcome::AlreadyDone);
    }

    /// Orchestration invariant: with no `sync_paths` row, the run is `NotReady`
    /// (drive not finished initializing) and never marks a flag. A regression
    /// that marked here would permanently poison a drive that simply hadn't
    /// registered its path yet.
    #[tokio::test]
    async fn run_not_ready_when_no_sync_path_row() {
        let pool = temp_pool().await;
        let state = make_state(pool.clone());

        let outcome = run_folder_entries_backfill_for_drive(&state, TEST_ACCOUNT, "ghost")
            .await
            .expect("run must not error on the NotReady path");

        assert_eq!(outcome, FolderEntriesBackfillOutcome::NotReady);
        assert!(
            !is_folder_entries_backfilled(&pool, &account_key(TEST_ACCOUNT), "ghost").await.unwrap(),
            "NotReady must leave the flag NULL so the next launch retries"
        );
    }

    /// Orchestration invariant: a `sync_paths` row whose path isn't on disk yet
    /// (init hasn't created the dir) is also `NotReady`, flag untouched.
    #[tokio::test]
    async fn run_not_ready_when_sync_root_absent() {
        let pool = temp_pool().await;
        insert_sync_path_for_account(&pool, TEST_ACCOUNT, "docs", "/no/such/hippius/sync/root").await;
        let state = make_state(pool.clone());

        let outcome = run_folder_entries_backfill_for_drive(&state, TEST_ACCOUNT, "docs")
            .await
            .expect("run must not error when the root is absent");

        assert_eq!(outcome, FolderEntriesBackfillOutcome::NotReady);
        assert!(!is_folder_entries_backfilled(&pool, &account_key(TEST_ACCOUNT), "docs").await.unwrap());
    }

    proptest::proptest! {
        /// NFC normalization is idempotent: `normalize(normalize(x)) == normalize(x)`.
        /// This is the contract the server's NFC validator depends on — a second
        /// pass must be a fixed point, never further mutate the string.
        #[test]
        fn normalize_rel_path_is_idempotent(s in ".*") {
            let once = normalize_rel_path(&s);
            let twice = normalize_rel_path(&once);
            proptest::prop_assert_eq!(once, twice);
        }
    }
}
