//! Integration tests for the per-drive status query.
//!
//! These exercise `get_all_drive_statuses_inner` against a real
//! `AppState` with an in-memory SQLite pool. The IPC wrapper is a
//! one-line delegation so testing the inner is sufficient.
//!
//! What we verify:
//!
//! 1. **Empty when no account is logged in** — defensive contract.
//! 2. **Empty when no sync paths exist** — fresh-install state.
//! 3. **Active vs Paused mapping** — `is_paused=false` → `Active`,
//!    `is_paused=true` → `Paused`. This is the entire status semantics.
//! 4. **Filters out the internal `migration` pseudo-drive** — the
//!    settings page / tray menu must never show it.
//! 5. **Multi-drive isolation** — pausing one drive doesn't affect
//!    the others.
//! 6. **Owner scoping** — paths from a different owner are excluded.
//!
//! These guarantees combined with the existing per-module unit tests
//! in `sync::drive_status` and `sync::user_stopped_migration` cover
//! the entire Phase 1 backend rewrite.

use sqlx::sqlite::SqlitePool;

use tauri_project_lib::app_state::AppState;
use tauri_project_lib::auth::state::AuthCapabilities;
use tauri_project_lib::sync::drive_status::DriveStatus;
use tauri_project_lib::sync::status::get_all_drive_statuses_inner;

/// Build an in-memory pool with the minimum schema this test touches:
/// just `sync_paths` plus the unique constraint that production uses.
async fn make_pool() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.expect("open in-memory db");

    sqlx::query(
        "CREATE TABLE sync_paths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            path TEXT NOT NULL,
            type TEXT NOT NULL,
            label TEXT NOT NULL,
            is_paused INTEGER NOT NULL DEFAULT 0,
            UNIQUE(owner, label)
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    pool
}

/// Helper that mirrors `account_key()` from `auth/account_key.rs`. The
/// production owner column is the hex-encoded SHA-256 of the substrate
/// address truncated to 16 chars. Mirror it here so the tests insert
/// rows with the same owner key the production query reads.
fn account_key(account_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..8])
}

async fn insert_path(pool: &SqlitePool, account_id: &str, label: &str, paused: bool) {
    sqlx::query("INSERT INTO sync_paths (owner, path, type, label, is_paused) VALUES (?, ?, 'private', ?, ?)")
        .bind(account_key(account_id))
        .bind(format!("/tmp/{label}"))
        .bind(label)
        .bind(i32::from(paused))
        .execute(pool)
        .await
        .unwrap();
}

/// Build an `AppState` with the given pool and an active account.
fn make_state_with_account(pool: SqlitePool, account_id: &str) -> AppState {
    let state = AppState::new();
    state.set_pool(pool);
    state
        .set_active_account(account_id, AuthCapabilities::default())
        .expect("set active account");
    state
}

#[tokio::test]
async fn returns_empty_when_no_account_set() {
    let pool = make_pool().await;
    let state = AppState::new();
    state.set_pool(pool);
    // Note: NOT calling set_active_account.

    let result = get_all_drive_statuses_inner(&state).await.unwrap();
    assert!(result.is_empty(), "expected empty list, got {result:?}");
}

#[tokio::test]
async fn returns_empty_when_no_sync_paths_exist() {
    let pool = make_pool().await;
    let state = make_state_with_account(pool, "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");

    let result = get_all_drive_statuses_inner(&state).await.unwrap();
    assert!(result.is_empty(), "expected empty list, got {result:?}");
}

#[tokio::test]
async fn maps_is_paused_to_paused_status() {
    let pool = make_pool().await;
    let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    insert_path(&pool, account, "default", false).await;
    insert_path(&pool, account, "photos", true).await;

    let state = make_state_with_account(pool, account);
    let mut result = get_all_drive_statuses_inner(&state).await.unwrap();
    result.sort_by(|a, b| a.label.cmp(&b.label));

    assert_eq!(result.len(), 2);
    assert_eq!(result[0].label, "default");
    assert_eq!(result[0].status, DriveStatus::Active);
    assert_eq!(result[1].label, "photos");
    assert_eq!(result[1].status, DriveStatus::Paused);
}

#[tokio::test]
async fn folder_name_is_basename_of_sync_path() {
    // The tray submenu and per-drive settings rows display
    // `folder_name`, not the internal `label`. Pin the basename
    // extraction so a path like `/tmp/photos` shows as "photos".
    let pool = make_pool().await;
    let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    insert_path(&pool, account, "drive_a", false).await;
    insert_path(&pool, account, "drive_b", true).await;

    let state = make_state_with_account(pool, account);
    let mut result = get_all_drive_statuses_inner(&state).await.unwrap();
    result.sort_by(|a, b| a.label.cmp(&b.label));

    // insert_path uses `/tmp/{label}` as the path, so the basename is
    // the label string. Verifies the basename plumbing end-to-end.
    assert_eq!(result[0].folder_name, "drive_a");
    assert_eq!(result[1].folder_name, "drive_b");
}

#[tokio::test]
async fn filters_out_internal_migration_pseudo_drive() {
    let pool = make_pool().await;
    let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    insert_path(&pool, account, "default", false).await;
    insert_path(&pool, account, "migration", false).await;
    insert_path(&pool, account, "photos", false).await;

    let state = make_state_with_account(pool, account);
    let result = get_all_drive_statuses_inner(&state).await.unwrap();

    let labels: Vec<&str> = result.iter().map(|e| e.label.as_str()).collect();
    assert_eq!(labels.len(), 2, "migration drive should be filtered out");
    assert!(labels.contains(&"default"));
    assert!(labels.contains(&"photos"));
    assert!(!labels.contains(&"migration"));
}

#[tokio::test]
async fn multi_drive_independence() {
    // The whole point of the per-drive redesign: pausing one drive
    // does not affect the others' reported status. This test pins
    // that contract.
    let pool = make_pool().await;
    let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    insert_path(&pool, account, "drive_a", false).await;
    insert_path(&pool, account, "drive_b", true).await;
    insert_path(&pool, account, "drive_c", false).await;
    insert_path(&pool, account, "drive_d", true).await;

    let state = make_state_with_account(pool, account);
    let result = get_all_drive_statuses_inner(&state).await.unwrap();

    let active: Vec<&str> = result
        .iter()
        .filter(|e| e.status == DriveStatus::Active)
        .map(|e| e.label.as_str())
        .collect();
    let paused: Vec<&str> = result
        .iter()
        .filter(|e| e.status == DriveStatus::Paused)
        .map(|e| e.label.as_str())
        .collect();

    assert_eq!(active.len(), 2);
    assert!(active.contains(&"drive_a"));
    assert!(active.contains(&"drive_c"));
    assert_eq!(paused.len(), 2);
    assert!(paused.contains(&"drive_b"));
    assert!(paused.contains(&"drive_d"));
}

#[tokio::test]
async fn owner_scoping_excludes_other_accounts() {
    // Verify the underlying query joins on owner so a stale row from
    // a different substrate address doesn't leak into the result.
    let pool = make_pool().await;
    let alice = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    let bob = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

    insert_path(&pool, alice, "alice_default", false).await;
    insert_path(&pool, alice, "alice_photos", true).await;
    insert_path(&pool, bob, "bob_default", false).await;
    insert_path(&pool, bob, "bob_work", true).await;

    let state = make_state_with_account(pool, alice);
    let result = get_all_drive_statuses_inner(&state).await.unwrap();

    let labels: Vec<&str> = result.iter().map(|e| e.label.as_str()).collect();
    assert_eq!(labels.len(), 2, "expected only alice's paths, got {labels:?}");
    assert!(labels.contains(&"alice_default"));
    assert!(labels.contains(&"alice_photos"));
    assert!(!labels.contains(&"bob_default"));
    assert!(!labels.contains(&"bob_work"));
}

#[tokio::test]
async fn cached_status_wins_over_db_derived_status() {
    // Regression guard: the per-drive cache in `AppState.drive_status_cache`
    // must take precedence over the `is_paused`-derived fallback. Without
    // this, an `Error { message }` state emitted by `auto_init_sync_inner`
    // would be silently clobbered to `Active` the next time the FE
    // bootstraps `get_all_drive_statuses` (e.g. on Settings page mount),
    // which is exactly the bug the cache was added to prevent.
    let pool = make_pool().await;
    let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    // Both rows have `is_paused=false`, so the DB-derived fallback
    // would return Active for both. The cache overrides one.
    insert_path(&pool, account, "working_drive", false).await;
    insert_path(&pool, account, "failed_drive", false).await;

    let state = make_state_with_account(pool, account);

    // Simulate `emit_drive_status` having previously written an Error
    // for "failed_drive" (e.g. from a failed auto_init_sync run).
    {
        let mut cache = state.drive_status_cache.lock().expect("cache lock");
        cache.insert(
            "failed_drive".to_string(),
            DriveStatus::Error {
                message: "Failed to initialize: test message".to_string(),
            },
        );
    }

    let mut result = get_all_drive_statuses_inner(&state).await.unwrap();
    result.sort_by(|a, b| a.label.cmp(&b.label));

    assert_eq!(result.len(), 2);
    assert_eq!(result[0].label, "failed_drive");
    assert!(
        matches!(result[0].status, DriveStatus::Error { ref message } if message.contains("Failed to initialize")),
        "expected cached Error state to win over is_paused=false; got {:?}",
        result[0].status
    );

    // The non-cached drive still gets the DB-derived Active status.
    assert_eq!(result[1].label, "working_drive");
    assert_eq!(result[1].status, DriveStatus::Active);
}

/// Read `src/sync/lifecycle.rs` for the static funnel pins below.
fn lifecycle_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/drive/lifecycle.rs")).expect("read lifecycle.rs")
}

/// Read `src/sync/lifecycle_guard.rs` for the commit-step pin below.
fn lifecycle_guard_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/drive/lifecycle_guard.rs")).expect("read lifecycle_guard.rs")
}

/// Extract the brace-matched body of the function whose declaration
/// contains `sig`. Brace-matching (rather than a loose window) means a
/// matching call in a *sibling* function can never satisfy a pin
/// against this one. Format-string braces (`"{label}"`) are balanced,
/// so counting raw `{`/`}` chars is sufficient for this source file.
fn fn_body<'a>(src: &'a str, sig: &str) -> &'a str {
    let sig_idx = src
        .find(sig)
        .unwrap_or_else(|| panic!("declaration `{sig}` not found in the pinned source file"));
    let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
    let mut depth = 0usize;
    let mut body_end = body_start;
    for (i, ch) in src[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    body_end = body_start + i;
                    break;
                }
            }
            _ => {}
        }
    }
    let body = &src[body_start..=body_end];
    // Over-match canary: module-level items start at column 0, while every
    // line inside a brace-matched body is indented. A column-0 function
    // declaration inside the extracted slice means the brace matching ran
    // past the function's real end into a sibling — every pin below would
    // then silently match against the wrong function. The pinned files mix
    // `async fn` and plain `fn` siblings behind `pub`/`pub(crate)` prefixes,
    // so probe every column-0 declaration shape they use.
    for needle in [
        "\nasync fn ",
        "\nfn ",
        "\npub async fn ",
        "\npub fn ",
        "\npub(crate) async fn ",
        "\npub(crate) fn ",
    ] {
        assert!(
            !body[1..].contains(needle),
            "fn_body over-matched into a sibling (found `{}` inside the body of `{sig}`)",
            needle.trim()
        );
    }
    body
}

/// Static funnel pin: `initialize_sync_inner` MUST commit through the
/// epoch-checked `apply_init_commit` step, with the epoch snapshot taken
/// strictly BEFORE the commit (at function entry, before any teardown),
/// so a pause/removal landing anywhere inside the init window — the
/// pre-register steps included — is observed at commit time.
///
/// Why the funnel matters: every surface that starts a drive flows
/// through `initialize_sync_inner`, but only `resume_drive` used to
/// clear `is_paused`. The files-page resume (`DriveOnboarding` →
/// `initialize_sync`) skipped it, leaving a *running* drive DB-flagged
/// paused. Committing at the funnel makes "drive successfully
/// initialized ⇒ is_paused = 0" hold for every entry point — and the
/// epoch check makes the converse hold too: a superseding pause is
/// never overwritten by a stale in-flight init (the PR #17 race).
/// Mirrors the `spawn_backfill` funnel pin in
/// `hippius_relative_path_backfill.rs`.
#[test]
fn initialize_sync_inner_commits_via_epoch_check() {
    let src = lifecycle_src();
    let body = fn_body(&src, "async fn initialize_sync_inner(");

    let snapshot_idx = body.find("drive_lifecycle.snapshot(").expect(
        "initialize_sync_inner must snapshot the drive-lifecycle epoch at entry \
         so a pause landing anywhere during the init is observed at commit",
    );
    let commit_idx = body
        .find("apply_init_commit(")
        .expect("initialize_sync_inner must commit through the epoch-checked apply_init_commit step");
    assert!(
        snapshot_idx < commit_idx,
        "the epoch snapshot must be taken BEFORE the commit step (a commit-time \
         snapshot is trivially current and observes no supersession)"
    );
}

/// Static guard against the "app freezes when a second folder is added while
/// one is already syncing" regression. When a sync loop is already running,
/// `initialize_sync_inner` must SPAWN the loop hot-add, not `.await` it. The
/// awaited path runs hcfs-client's `hot_add_drives` → `collect_drive_paths`,
/// which blocks on every peer drive's manager lock (held for the whole of a
/// peer's in-flight sync cycle), stalling the `add_local_sync_folder` IPC and
/// its disabled-button modal for the length of that sync. The new drive is
/// already registered before this point, so the running loop syncs it on its
/// next cycle regardless. Reverting to an unconditional
/// `start_sync_loop(app).await` reintroduces the freeze; this pins the fix.
#[test]
fn initialize_sync_inner_spawns_loop_hot_add_when_running() {
    let src = lifecycle_src();
    let body = fn_body(&src, "async fn initialize_sync_inner(");

    let gate_idx = body.find("loop_already_running").expect(
        "initialize_sync_inner must branch on whether a loop is already running so the \
         hot-add never stalls the init IPC on a peer drive's manager lock",
    );
    let spawn_idx = body.find("async_runtime::spawn").expect(
        "initialize_sync_inner must SPAWN start_sync_loop when a loop is already running — \
         awaiting hot_add_drives blocks on a peer drive's manager lock (the freeze bug)",
    );
    assert!(
        gate_idx < spawn_idx,
        "the spawn must live inside the `loop_already_running` branch",
    );
}

/// Static pin on the commit step itself: `apply_init_commit` is where the
/// "successfully initialized ⇒ is_paused = 0" write now lives, so IT must
/// call `set_sync_path_paused(.., false)` — clear, never set.
#[test]
fn apply_init_commit_clears_paused_flag() {
    let src = lifecycle_guard_src();
    let body = fn_body(&src, "async fn apply_init_commit(");

    let call_idx = body
        .find("set_sync_path_paused(")
        .expect("apply_init_commit must clear sync_paths.is_paused for a still-current init");
    // The call must clear (pass `false`), not set, the flag. Bind the
    // assertion to the call's own argument list — not a loose window —
    // so a stray `false` in a nearby comment or log string can never
    // satisfy it. The call takes no nested parens, so the first `)`
    // after the call closes its argument list.
    let args_start = call_idx + "set_sync_path_paused(".len();
    let args_end = body[args_start..].find(')').expect("set_sync_path_paused call closes its argument list") + args_start;
    let args = &body[args_start..args_end];
    assert!(
        args.trim_end().ends_with("false"),
        "set_sync_path_paused inside apply_init_commit must pass `false` (clear) as its last argument; got args: {args}"
    );
}

/// Static funnel pin: `pause_drive` MUST bump the drive-lifecycle epoch
/// under the label's commit lock (`sync::lifecycle_guard` single-writer
/// protocol). Without the bump, an in-flight init's commit step would
/// silently overwrite the user's pause — the PR #17 race. The
/// `drive_lifecycle.`-qualified needles bind to real call sites, not a
/// comment mention.
#[test]
fn pause_drive_bumps_epoch_under_commit_lock() {
    let src = lifecycle_src();
    let body = fn_body(&src, "async fn pause_drive(");
    let lock_idx = body
        .find("drive_lifecycle.commit_lock(")
        .expect("pause_drive must take the label's commit lock before writing is_paused");
    let bump_idx = body
        .find("drive_lifecycle.bump(")
        .expect("pause_drive must bump the pause epoch so in-flight inits see the supersession");
    let write_idx = body.find("set_sync_path_paused(").expect("pause_drive must persist is_paused=true");
    let emit_idx = body
        .find("emit_drive_status(")
        .expect("pause_drive must emit the Paused status inside its commit-locked block");
    // Protocol order, not mere presence: acquire the lock, bump under it,
    // write the flag, then emit Paused — all before the guard drops. A
    // bump after the write (or outside the lock) reopens the
    // pause-overwrite race one level down; an emit outside the lock can
    // be overtaken by an init's stale Active emit (the commit's
    // on_committed hook runs under this same lock), leaving the status
    // cache showing Active for a paused drive.
    assert!(
        lock_idx < bump_idx && bump_idx < write_idx && write_idx < emit_idx,
        "pause_drive must order commit_lock < bump < set_sync_path_paused < emit_drive_status \
         (got indices {lock_idx} / {bump_idx} / {write_idx} / {emit_idx})"
    );
}

/// Static funnel pin: the real drive teardown is
/// `remove_drive_for_account` (the `remove_drive` IPC is a one-line
/// wrapper over it), so the bump-under-commit-lock lives there. A
/// removal must invalidate in-flight init snapshots exactly like a
/// pause, or a slow init re-registers a zombie for the deleted row.
#[test]
fn remove_drive_for_account_bumps_epoch_under_commit_lock() {
    let src = lifecycle_src();
    let body = fn_body(&src, "async fn remove_drive_for_account(");
    let lock_idx = body
        .find("drive_lifecycle.commit_lock(")
        .expect("remove_drive_for_account must take the label's commit lock around teardown + row delete");
    let bump_idx = body
        .find("drive_lifecycle.bump(")
        .expect("remove_drive_for_account must bump the epoch so in-flight inits abandon their commit");
    let emit_idx = body
        .find("emit_drive_removed(")
        .expect("remove_drive_for_account must emit the removal inside its commit-locked block");
    // The bump announces the supersession and is only race-free while the
    // label's commit lock is held — so the lock acquisition must precede
    // it. The removal emit must follow the bump (inside the same locked
    // block) so it is totally ordered with an in-flight init's
    // on_committed Active emit: emitted-last must equal serialized-last.
    assert!(
        lock_idx < bump_idx && bump_idx < emit_idx,
        "remove_drive_for_account must order commit_lock < bump < emit_drive_removed \
         (got indices {lock_idx} / {bump_idx} / {emit_idx})"
    );
}

/// Static funnel pin: `stop_sync` (logout/reset cleanup) MUST bump every
/// registered drive's epoch so a slow in-flight init cannot re-register
/// a drive after the logout teardown completes. No commit lock is
/// required here — see the justification comment at the call site.
#[test]
fn stop_sync_bumps_every_drive_epoch() {
    let src = lifecycle_src();
    let body = fn_body(&src, "async fn stop_sync(");
    assert!(
        body.contains("drive_lifecycle.bump("),
        "stop_sync must bump the lifecycle epoch for every registered drive"
    );
}

/// Static funnel pin: `resume_drive`'s pre-init `is_paused=false` write
/// MUST happen under the label's commit lock (single-writer invariant:
/// EVERY `sync_paths.is_paused` write holds the label's commit lock).
/// Resume does NOT bump — it supersedes nothing. It MUST also capture
/// its lifecycle snapshot inside that same locked block and thread it
/// into `initialize_sync_inner`: a snapshot taken later (at init entry)
/// would miss a pause that fully completed between resume's pre-clear
/// and the init's entry, letting the init commit over the pause.
#[test]
fn resume_drive_clears_paused_under_commit_lock() {
    let src = lifecycle_src();
    let body = fn_body(&src, "async fn resume_drive(");
    assert!(
        body.contains("drive_lifecycle.commit_lock("),
        "resume_drive must hold the label's commit lock across its set_sync_path_paused(false) write"
    );
    assert!(
        body.contains("drive_lifecycle.snapshot("),
        "resume_drive must capture the lifecycle snapshot inside its commit-locked pre-clear block"
    );
    assert!(
        body.contains("Some(resume_snapshot)"),
        "resume_drive must thread its locked-block snapshot into initialize_sync_inner so a pause \
         completing between the pre-clear and init entry still supersedes the init"
    );
}

#[tokio::test]
async fn cached_status_falls_through_when_label_missing() {
    // Negative case: a cache that has an entry for one label must not
    // affect other labels' DB-derived status. Protects against an
    // accidental map-wide override in `get_all_drive_statuses_inner`.
    let pool = make_pool().await;
    let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    insert_path(&pool, account, "drive_with_cache", false).await;
    insert_path(&pool, account, "drive_without_cache", true).await;

    let state = make_state_with_account(pool, account);
    {
        let mut cache = state.drive_status_cache.lock().expect("cache lock");
        cache.insert("drive_with_cache".to_string(), DriveStatus::Paused);
    }

    let mut result = get_all_drive_statuses_inner(&state).await.unwrap();
    result.sort_by(|a, b| a.label.cmp(&b.label));

    // Cached entry: Paused (cache wins over is_paused=false).
    assert_eq!(result[0].label, "drive_with_cache");
    assert_eq!(result[0].status, DriveStatus::Paused);
    // Non-cached entry: DB-derived Paused (is_paused=true).
    assert_eq!(result[1].label, "drive_without_cache");
    assert_eq!(result[1].status, DriveStatus::Paused);
}
