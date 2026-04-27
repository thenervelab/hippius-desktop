# Backend Performance Audit — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Apply 25 validated performance fixes to `src-tauri/` across SQLite, async hygiene, login latency, sync hot path, listings, network/charts, and cleanup.

**Architecture:** Seven independently-shippable batches, each one git commit. Order is risk-ascending: foundational config first, hot-path code last. No batch depends on a later batch; any batch can be reverted in isolation.

**Tech Stack:** Rust (Tokio, SQLx, Subxt, reqwest, Tauri), with existing integration tests in `src-tauri/tests/`.

---

## Source of truth

Findings come from the validation pass in this conversation. Of the 28 originally identified:

- **#17 retracted**: eligibility check is already at batch entry, not per-file.
- **#28 deferred**: hcfs-client's `register_relative_paths` at `operations.rs:595` takes `Vec<RegisterRelativePathEntry>` by value — `chunk.to_vec()` is forced by the API. Filed as a hcfs-client follow-up; not actionable from desktop side.
- **#26 / Task 6.6 dropped**: per project CLAUDE.md "no speculative features". Adding `get_wallet_overview` without a frontend consumer is dead code. The cross-call drift it would fix is real but small (one block); revisit when the FE wants to switch.

The remaining 25 are tracked here. PARTIAL findings (#4, #10, #20, #23, #26-cross) ship the underlying fix; the framing nuance is noted in each task.

## Verification rituals (apply to every batch)

Before committing any batch:

```bash
cd /Users/georgiosdelkos/Documents/GitHub/Bitensor/hippius-desktop/src-tauri
SQLX_OFFLINE=true cargo build               # must succeed
cargo clippy --all-targets -- -D warnings   # must succeed (deny warnings)
cargo test                                  # all tests pass
```

If a batch touches a specific test (e.g. `eligibility_enforcement.rs` for batch 4), run that test first with `--nocapture` for fast feedback.

Commit message format: `perf(<scope>): <one-line summary>` referencing the finding numbers.

## Order rationale

| Batch | Title | Findings | Why this position |
|-------|-------|----------|-------------------|
| 1 | SQLite foundation | 1, 2, 15, 27 | Pool config + WAL is the single biggest win and is independent of everything else. Ships in isolation, easy to roll back. |
| 2 | Async runtime hygiene | 6 (sync), 6 (nebula), 19 | Removes blocking calls from the executor. Pure correctness improvement; no behavior change. |
| 3 | Cold-path parallelism | 5, 13, 14, 18 | Login + restore + recovery latency. Touches multiple files but the change is uniform (`for ... .await` → `JoinSet`). |
| 4 | Sync hot-path emissions | 3, 4, 12 | Reduces idle CPU. Behavior-visible, so each gets a test. |
| 5 | File listing efficiency | 8, 9, 10, 11, 22, 28 | All localized to `sync/files.rs` + `relative_path_backfill.rs`. One large but cohesive refactor. |
| 6 | Network and charts | 7, 16, 20, 21, 23, 25 | Independent surface (billing/blockchain). #21 is a correctness bug, not just perf. |
| 7 | Cleanup | 24 | Single change (Nebula GitHub gate). Last because it's lowest impact. |

---

# Batch 1 — SQLite foundation

**Findings:** #1 (pool defaults), #2 (schema in transaction), #15 (unread count single query), #27 (batch INSERT).

**Files:**
- Modify: `src-tauri/src/main.rs:574-588`
- Modify: `src-tauri/src/utils/schema.rs` (whole file)
- Modify: `src-tauri/src/notifications/crud.rs:380-424`
- Modify: `src-tauri/src/notifications/credits.rs:370-402`

## Task 1.1: WAL pool config

**Step 1.1.1** — Replace `SqlitePool::connect(&db_url)` in `src-tauri/src/main.rs:574`.

Before:
```rust
let pool = match SqlitePool::connect(&db_url).await { ... };
```

After:
```rust
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::str::FromStr;

let opts = SqliteConnectOptions::from_str(&db_url)
    .map_err(...)?
    .create_if_missing(true)
    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
    .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
    .busy_timeout(std::time::Duration::from_secs(5))
    .foreign_keys(true);

let pool = match SqlitePoolOptions::new()
    .max_connections(8)
    .connect_with(opts)
    .await { ... };
```

**Step 1.1.2** — Verify: `SQLX_OFFLINE=true cargo build`. After running once, `ls ~/.hippius/*.db-wal` should show the WAL file (manual smoke check at end of batch).

## Task 1.2: Schema initialization in one transaction

**Step 1.2.1** — Wrap `ensure_table_schema` body in `pool.begin() … tx.commit()`. Open `src-tauri/src/utils/schema.rs:43`. The function currently calls `.execute(pool)` ~30 times. Change every `.execute(pool)` to `.execute(&mut *tx)` where `tx = pool.begin().await?`.

**Step 1.2.2** — **Critical** (reviewer C1): there are two existing `let mut tx = pool.begin().await?` calls inside the function — at `schema.rs:218` (swap-table for `sync_paths` UNIQUE constraint) and `schema.rs:539` (inside `migrate_account_keys`). After wrapping the outer scope in a top-level `tx`, both inner blocks must change to `let mut sp = tx.begin().await?` (savepoint) instead of `pool.begin()`. Otherwise they grab a second pooled connection and commit independently of the outer tx, defeating atomicity. Adjust their `.commit()` to `sp.commit()` — they nest cleanly because sqlx-sqlite maps `Transaction::begin` on an existing tx to `SAVEPOINT`.

**Step 1.2.3** — Cache `PRAGMA table_info(sync_paths)` once. Current code reads it at lines 152, 164, 183. Read once into a `HashSet<String>` of column names at line 150 and reuse.

**Step 1.2.4** — Run `cargo test --test local_db_commands` to verify schema setup still works.

## Task 1.3: Single-query unread count

**Step 1.3.1** — Replace `src-tauri/src/notifications/crud.rs:385-421` with one query using a correlated subquery:

```sql
SELECT COUNT(*) FROM notifications
WHERE (user_address = ? OR user_address = 'system')
  AND is_unread = 1 AND is_deleted = 0
  AND (notification_type = 'Hippius'
    OR notification_type IN (
      SELECT label FROM notification_preferences WHERE enabled = 1
    ))
```

**Step 1.3.2** — Delete the empty-enabled fallback path at 392-404. The new query handles it naturally: `notification_type IN (SELECT label FROM notification_preferences WHERE enabled = 1)` evaluates to false against the empty set, so only the `notification_type = 'Hippius'` arm survives. (The empty `IN ()` literal is invalid SQL in SQLite; the subquery form is not — that's why we use it.)

**Step 1.3.3** — Add a test in `src-tauri/tests/local_db_commands.rs` named `unread_count_filters_disabled_labels` that creates one Hippius notification + one disabled-label notification and asserts count == 1.

## Task 1.4: Multi-row INSERT for credit notifications

**Step 1.4.1** — In `src-tauri/src/notifications/credits.rs:375-399`, replace the per-row INSERT loop with a built `INSERT … VALUES (…), (…), …` for the whole batch. Cap at chunks of 100 rows (each row binds 4 params; SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 32766, so 100×4=400 is safe with margin). The transaction wrapper stays.

**Step 1.4.2** — Run `cargo test --test local_db_commands` and `cargo test create_credit_notifications` for any inline tests in `notifications/credits.rs`.

## Batch 1 commit

```bash
git add src-tauri/src/main.rs src-tauri/src/utils/schema.rs \
        src-tauri/src/notifications/crud.rs src-tauri/src/notifications/credits.rs \
        src-tauri/tests/local_db_commands.rs
git commit -m "perf(db): WAL pool, single-tx schema init, batched notification ops"
```

---

# Batch 2 — Async runtime hygiene

**Findings:** #6 (canonicalize sync side), #6 (nebula process commands), #19 (stop_nebula child handle).

**Files:**
- Modify: `src-tauri/src/sync/files.rs:99, :167, :219, :410-414`
- Modify: `src-tauri/src/sync/paths.rs:45, :52`
- Modify: `src-tauri/src/nebula/manager.rs:1832, :1854, :1876`
- Modify: `src-tauri/src/nebula/manager.rs:1357-1395 (start), :1578-1610 (stop)`
- Modify: `src-tauri/src/nebula/state.rs` (add `child: Mutex<Option<Child>>`)

## Task 2.1: tokio::fs::canonicalize in sync paths

**Step 2.1.1** — In each call site listed above, replace `parent.canonicalize()` (which is `std::path::Path::canonicalize`, a blocking syscall) with `tokio::fs::canonicalize(parent).await`.

**Step 2.1.2** — `validate_no_path_overlap` (at `src-tauri/src/sync/paths.rs:44`) is sync and currently calls `std::fs::canonicalize` at lines 45 and 52. Verified callers: exactly **one** non-test caller at `src-tauri/src/sync/paths.rs:84` (inside `set_sync_path_internal`, which is async). All other 7 references are in `#[test]` modules. Convert the function signature to `async fn`, change the body to `tokio::fs::canonicalize(...).await`, and add `.await` at the single non-test call site. Test callers stay sync because the unit tests pass `&[(String, String)]` of pre-known paths and never hit the disk — wait, they do call canonicalize. Use `tokio_test::block_on` or convert tests to `#[tokio::test]`. Easier: keep tests sync by extracting a `validate_no_path_overlap_with` helper that takes pre-canonicalized paths, and call it from both async and sync sites.

**Step 2.1.3** — In `src-tauri/src/sync/files.rs:386-440` (the `add_files` IPC), canonicalize the sync root **once** before the per-file loop instead of redoing it inside `add_file_internal` for every file. Pass the resolved `PathBuf` into `add_file_internal` as a new parameter.

**Step 2.1.4** — Run `cargo test --test file_commands` and `cargo test --test list_sync_folder_nested` for fast feedback.

## Task 2.2: tokio::process for Nebula network probes

**Step 2.2.1** — Replace `std::process::Command` with `tokio::process::Command` at `src-tauri/src/nebula/manager.rs:1832, :1854, :1876` and `await` the `.output()` calls. Wrap in `tokio::time::timeout` (e.g. 2 s) so a hung `ifconfig` doesn't hang `get_nebula_stats`.

## Task 2.3: Persist Nebula child handle for direct kill

**Step 2.3.1** — Add `child: Mutex<Option<tokio::process::Child>>` to `NebulaState` in `src-tauri/src/nebula/state.rs`.

**Step 2.3.2** — In `start_nebula_internal` (`manager.rs:1357-1395`), capture the spawned `Child` and store it in `NebulaState.child` instead of dropping it.

**Step 2.3.3** — In `stop_nebula` (`manager.rs:1578-1610`), replace the `pkill` + 50× `ps` poll loop with: take the stored child, call `child.kill().await`, then `child.wait().await` with a 5-second `tokio::time::timeout`. Fall back to `pkill` only if no child was stored (covers leftover-from-crash case).

**Step 2.3.4** — Run `cargo test` to confirm nothing broke; Nebula functional verification is manual (start/stop VPN in dev build).

## Batch 2 commit

```bash
git add src-tauri/src/sync/files.rs src-tauri/src/sync/paths.rs \
        src-tauri/src/nebula/manager.rs src-tauri/src/nebula/state.rs
git commit -m "perf(async): tokio::fs/process throughout, persist Nebula child for direct kill"
```

---

# Batch 3 — Cold-path parallelism

**Findings:** #5 (auto_init_sync), #13 (restore_session), #14 (reencrypt_all_folder_mnemonics), #18 (restore_remote_folders).

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs:1545-1582`
- Modify: `src-tauri/src/auth/session_restore.rs:183-471`
- Modify: `src-tauri/src/sync/mnemonic.rs:399-464`
- Modify: `src-tauri/src/sync/folders.rs:278-300`

## Task 3.1: Parallel auto_init_sync

**Step 3.1.1** — In `src-tauri/src/sync/lifecycle.rs:1545`, replace the `for sp in &regular { initialize_sync_inner(...).await }` loop with a `JoinSet`-driven fan-out. Preserve the per-drive Paused emit ordering by emitting Paused entries inline (synchronously, before joinset starts) for every drive that has `is_paused=true`, then awaiting the joinset for non-paused drives. Limit concurrency to e.g. 8 with `JoinSet` + a `tokio::sync::Semaphore` if HCFS server fan-in is a concern (start with no limit; add only if probes start failing).

**Step 3.1.2** — Verify by adding a small unit test or smoke-running the app with multiple drives configured. Log timing in dev build.

## Task 3.2: Parallel session restore probes

**Step 3.2.1** — In `src-tauri/src/auth/session_restore.rs`, identify probes that are independent: `migrate_if_needed`, `arm_asset_scope_for_account`, `check_recovery_state_inner`. Group them inside `tokio::join!` so they run concurrently. Keep `get_token_and_expiry` first (downstream depends on it).

**Step 3.2.2** — Run `cargo test --test auth_commands` and `cargo test --test auth_tokens`.

## Task 3.3: Parallel folder mnemonic re-encryption

**Step 3.3.1** — In `src-tauri/src/sync/mnemonic.rs:399-464`, replace the `for label in labels.iter() { spawn_blocking(...).await }` loop with a single pass that pushes each `spawn_blocking` future into a `JoinSet`, then awaits them all and aggregates errors. Argon2 is CPU-bound, so concurrency = number of cores; let the blocking pool size handle that.

**Step 3.3.2** — Run `cargo test --test recovery` to verify recovery flow still works.

## Task 3.4: Parallel restore_remote_folders

**Step 3.4.1** — In `src-tauri/src/sync/folders.rs:278`, replace the sequential `for folder in &folders { restore_single_folder(...).await }` with `futures::future::join_all` over the futures. Keep the result-ordering guarantee by zipping `folders.iter()` with the `Vec<Result<...>>`.

## Batch 3 commit

```bash
git add src-tauri/src/sync/lifecycle.rs src-tauri/src/auth/session_restore.rs \
        src-tauri/src/sync/mnemonic.rs src-tauri/src/sync/folders.rs
git commit -m "perf(login): parallelize drive init, restore probes, folder reencrypt"
```

---

# Batch 4 — Sync hot-path emissions

**Findings:** #3 (block subscription throttle), #4 (snapshot dirty flag), #12 (single-pass failure counts).

**Files:**
- Modify: `src-tauri/src/blockchain/subscription.rs:116-132`
- Modify: `src-tauri/src/sync/progress.rs` (add version counter), `src-tauri/src/sync/tauri_bridge.rs:323-335` (gate emit)
- Modify: `src-tauri/src/sync/tauri_bridge.rs:91-103`

> **Note on #4 framing:** the prior 100%-CPU fix (commit e93ec206) added the 250 ms throttle. This batch adds the orthogonal **no-change short-circuit** — even with a throttle, an idle drive currently still emits a snapshot every 250 ms with identical content.

## Task 4.1: Block subscription throttle

**Step 4.1.1** — Write a test in `src-tauri/tests/blockchain_commands.rs` (or new file) that exercises the throttle gate: simulate 6 block-emit calls within 1 second; assert the FE event channel sees ≤2 emits.

**Step 4.1.2** — Implement: in `src-tauri/src/blockchain/subscription.rs:116`, add a `last_emit_ms: AtomicU64` to `BlockSubscriptionState` and gate the `app.emit("block_number_updated", …)` call to fire at most once every 1000 ms (configurable constant). Forced emit on connection state change (`is_connected` toggle).

**Step 4.1.3** — Run the new test.

## Task 4.2: Snapshot dirty/version short-circuit

**Step 4.2.1** — Write a test that:
1. Builds a sync session with one file in progress
2. Calls the snapshot emit twice within 250 ms with no state change
3. Asserts only the first emit reaches the bridge

**Step 4.2.2** — Add `version: AtomicU64` to the progress session struct (in `src-tauri/src/sync/progress.rs`). Bump it on every state mutation that changes user-visible fields. In `tauri_bridge.rs:323-335`, before serializing, compare `session.version` to `last_emitted_version`; skip emit if equal.

**Step 4.2.3** — Run the new test + existing sync tests.

## Task 4.3: Single-pass failure counts

**Step 4.3.1** — In `src-tauri/src/sync/tauri_bridge.rs:91-103`, replace the two `session.files.values().filter(...).map(...).collect()` sweeps with a single `for f in session.files.values()` that pushes into either `failed` or `succeeded` based on `f.status`.

**Step 4.3.2** — Run `cargo test --test sync_cancel_notifications`.

## Batch 4 commit

```bash
git add src-tauri/src/blockchain/subscription.rs src-tauri/src/sync/progress.rs \
        src-tauri/src/sync/tauri_bridge.rs src-tauri/tests/blockchain_commands.rs
git commit -m "perf(sync): throttle block emits, dirty-gate snapshots, single-pass failures"
```

---

# Batch 5 — File listing efficiency

**Findings:** #8 (label hashmap), #9 (dir_stats cache), #10 (trust synced cache), #11 (single drive map lock), #22 (fold compute_label_stats), #28 (backfill chunk no-clone).

**Files:**
- Modify: `src-tauri/src/sync/files.rs` (lines 481-499, 539-573, 747-771, 820-823, 896, 1177-1183, 1240-1310)
- Modify: `src-tauri/src/sync/relative_path_backfill.rs:278-279`

> **Note on #10 framing:** the original audit said "clones map twice"; validation confirmed it's actually one map clone + per-row string clones. Fix is the same: trust the cache.

## Task 5.1: Label→path HashMap in get_user_files

**Step 5.1.1** — In `src-tauri/src/sync/files.rs:1240` (the outer `for (label, entries) in &results` loop), build a `HashMap<&str, &str>` of `label → folder_path` once before the inner loop. Replace the linear `sync_paths.iter().find(...)` at line 1273 with a single hashmap lookup.

**Step 5.1.2** — Reuse the existing `label_to_path` builder pattern from `get_recent_files` at `files.rs:637`.

## Task 5.2: Single-pass label stats

**Step 5.2.1** — Fold `compute_label_stats` (currently at `files.rs:1183`) into the existing `for (label, entries)` loop in `get_user_files`. Avoids the second walk + the per-entry `entry.label.clone()`. Change the stats key type to `&str` referencing the existing label, then convert to `String` once at the end.

## Task 5.3: Single drive-map lock per list_sync_folder

**Step 5.3.1** — In `src-tauri/src/sync/files.rs`, refactor `synced_paths_for_label` (line 481) and the exclusion-pattern fetch (line 820) to share one drive-map lock acquisition. Either: (a) inline both into `list_sync_folder_inner` so the lock is held once and both pieces of state are pulled out together, or (b) introduce a helper `synced_paths_and_excludes_for_label` that returns both.

**Step 5.3.2** — Cache exclude patterns per drive in `DriveSlot` so they're not re-read on every UI tick. Invalidate when the user changes exclusion settings.

**Step 5.3.3** — Run `cargo test --test list_sync_folder_nested`.

## Task 5.4: Trust the synced-paths cache

**Step 5.4.1** — In `src-tauri/src/sync/files.rs:539-559`, change `get_synced_file_metadata` to read from `sync.get_cached_synced_paths()` first; only fall back to `manager.load_sync_state().await` + `build_synced_paths_from_state()` when the cache is empty. The cache is updated by sync events; trust it on the read path.

## Task 5.5: dir_stats memoization

**Step 5.5.1** — Add a per-drive `Mutex<HashMap<PathBuf, (size: u64, count: u64, mtime: SystemTime)>>` cache. Before walking a directory, stat it; if mtime matches the cached entry, return the cached value. On miss, walk and update the cache.

**Step 5.5.2** — Cache lives in `DriveSlot`; cleared on drive removal.

**Step 5.5.3** — Add a unit test that calls `dir_stats_recursive` twice on an unchanging directory and asserts the second call doesn't `read_dir`. (Use a counter wrapper for the test if needed; or assert via timing.)

## Task 5.6: ~~Backfill chunk pass-through~~ — DEFERRED

Verified at `~/.cargo/git/checkouts/hcfs-a5708048dcc2875c/475df4b/hcfs-client/src/client/operations.rs:595`: `register_relative_paths` takes `entries: Vec<RegisterRelativePathEntry>` by value. The `chunk.to_vec()` is forced by the API. Eliminating it requires changing the upstream signature to accept `&[RegisterRelativePathEntry]` or `impl IntoIterator`. File a hcfs-client follow-up and skip from this plan.

## Batch 5 commit

```bash
git add src-tauri/src/sync/files.rs
git commit -m "perf(listings): label hashmap, single-lock listing, dir-stats cache, fold label-stats"
```

---

# Batch 6 — Network and charts

**Findings:** #7 (indexer limits), #16 (referral_links join_all), #20 (chart formatters), #21 (format_balance precision — **correctness**), #23 (typed deserialize), #25 (indexer env once). Note: #26 dropped per "no speculative features"; #28 deferred (hcfs-client API constraint).

**Files:**
- Modify: `src-tauri/src/billing/queries.rs:208, :266`
- Modify: `src-tauri/src/blockchain/queries.rs:184-194` (referral), :11-39, :43-120 (wallet/staking)
- Modify: `src-tauri/src/billing/charts.rs:60-69, :228-306`
- Modify: `src-tauri/src/billing/credits.rs:55`
- Modify: `src-tauri/src/billing/eligibility.rs:152`
- Modify: `src-tauri/src/api/indexer.rs:9-32` and `src-tauri/src/app_state.rs`

## Task 6.1: format_balance precision (CORRECTNESS)

**Step 6.1.1** — Promote `planck_to_hip_with_decimals` at `src-tauri/src/blockchain/convert.rs:115` from private `fn` to `pub(crate) fn` (currently `fn`, no visibility modifier).

**Step 6.1.2** — Write a test in `src-tauri/src/billing/charts.rs` `#[cfg(test)] mod tests` (charts has no integration test file; co-locating with the function under test is the right move) that calls `format_balance("100000000000000000000", 6)` (= 100 HIP, well above the f64 threshold of ~9 HIP at 6 decimals) and asserts the formatted output is exact, not rounded.

**Step 6.1.3** — Reuse `crate::blockchain::convert::planck_to_hip_with_decimals` in `src-tauri/src/billing/charts.rs:60-69`. Drop the `f64` parse path entirely.

**Step 6.1.4** — Run the test; expect green.

## Task 6.2: Lower indexer limits

**Step 6.2.1** — In `src-tauri/src/billing/queries.rs:208`, change `unwrap_or(100_000)` to `unwrap_or(2000)`. At line 266, change `unwrap_or(20_000)` to `unwrap_or(2000)`. Add a comment explaining: a year of daily samples is 365, two years is 730; 2000 covers any chart range and the dedup downstream further reduces.

**Step 6.2.2** — Add an inline `#[tokio::test]` in `src-tauri/src/billing/queries.rs` (or `charts.rs`) that asserts `get_credits` callers get back a non-empty series for the largest chart range the FE supports. Stub the indexer with a mock client. If mocking is too heavy here, add a comment to manually verify in dev build instead — but state explicitly which test was used.

**Step 6.2.3** — Run charts manually in dev build to confirm series still render at "max" range.

## Task 6.3: Cache indexer env

**Step 6.3.1** — In `src-tauri/src/app_state.rs`, add `indexer_url: OnceLock<String>` and `indexer_api_key: OnceLock<String>`. Populate in `AppState::new()` from the env vars. Provide accessor methods.

**Step 6.3.2** — In `src-tauri/src/api/indexer.rs:9-32`, change `IndexerClient::from_env(client)` to `IndexerClient::from_state(state)` (or similar) reading from the cached values. Update the 7 call sites in `src-tauri/src/billing/queries.rs:118, 138, 151, 206, 264, 334, 457`.

## Task 6.4: Typed credits deserialize

**Step 6.4.1** — Define `#[derive(Deserialize)] pub struct CreditBalanceResponse { pub balance: String }` in `src-tauri/src/billing/credits.rs` (or `api/client.rs` if shared).

**Step 6.4.2** — Replace `serde_json::Value` reads in `credits.rs:55` and `eligibility.rs:152` with the typed struct.

## Task 6.5: Parallel referral_links

**Step 6.5.1** — In `src-tauri/src/blockchain/queries.rs:184-194`, instead of `await`ing each `storage.fetch(&reward_query)` inside the loop, collect them into `Vec<impl Future>` and await with `futures::future::try_join_all`.

## Task 6.6: ~~Combined wallet overview~~ — DROPPED

Per project CLAUDE.md "no speculative features": adding `get_wallet_overview` without a frontend consumer is dead code. The cross-call drift is real but small (one block at most). When the FE adopts a wallet-overview screen, revisit and add the IPC at that point. Skip this task.

## Task 6.7: Chart formatter allocations

**Step 6.7.1** — In `src-tauri/src/billing/charts.rs:228-306` (`format_credits_chart`, `format_storage_chart`, `format_balance_chart`), change the `HashMap<String, &RawPoint>` to `HashMap<NaiveDate, &RawPoint>` (`NaiveDate` is `Copy`). Eliminate the `format!("{}", (val * 1e18) as u128)` pattern by passing the original planck `String` from upstream and using the typed `format_balance` (post-#21 fix). Drop `String::new()` for empty timestamp; use `Cow<'_, str>` or `Option<String>`.

**Step 6.7.2** — Add a microbenchmark or smoke test (open billing page in dev build; expect lower allocator pressure).

## Batch 6 commit

```bash
git add src-tauri/src/billing/queries.rs src-tauri/src/billing/charts.rs \
        src-tauri/src/billing/credits.rs src-tauri/src/billing/eligibility.rs \
        src-tauri/src/blockchain/queries.rs src-tauri/src/api/indexer.rs \
        src-tauri/src/app_state.rs src-tauri/src/main.rs \
        src-tauri/tests/blockchain_commands.rs
git commit -m "perf(net): typed deserialize, lower indexer limits, parallel referral, combined wallet"
```

---

# Batch 7 — Cleanup

**Findings:** #24 (Nebula GitHub gating).

**Files:**
- Modify: `src-tauri/src/nebula/manager.rs:1077-1118`
- Modify: `src-tauri/src/utils/preferences.rs` (add helper if needed)

## Task 7.1: Gate Nebula GitHub check on 24-hour preference

**Step 7.1.1** — Add a new user-preferences key `nebula_last_release_check_ms`. Read from `user_preferences` table (already exists, generic key-value).

**Step 7.1.2** — In `setup_nebula_background` at `manager.rs:1077`, before calling `run_check_nebula_requirements`, check if `now - nebula_last_release_check_ms < 86_400_000`. If yes, skip the GitHub fetch and use the cached version info (whatever the last successful run wrote into `nebula_state`/DB).

**Step 7.1.3** — On successful check, write `now` back to the preference.

## Batch 7 commit

```bash
git add src-tauri/src/nebula/manager.rs src-tauri/src/utils/preferences.rs
git commit -m "perf(nebula): gate GitHub release check on 24h preference"
```

---

# Risks and mitigations

| Risk | Mitigation |
|------|------------|
| WAL mode (#1) creates `*.db-wal` and `*.db-shm` files that persist; users moving the DB by file copy may miss them | WAL is standard for desktop SQLite; document in CLAUDE.md if there's a backup script. None known here. |
| `synchronous=NORMAL` (#1) trades the last in-flight transaction on power loss for ~10× write throughput | This is the SQLite-recommended default for app-local DBs. The lost data is at most one IPC's worth of state and can be re-derived from server-of-record (HCFS, blockchain). Call this out in commit message. |
| Switching an existing rollback-journal DB to WAL on first launch | sqlx applies `journal_mode=WAL` per connection at `after_connect`; SQLite handles the conversion automatically when there are no other connections. Cold start is the only path here, so no contention. Test by running on a populated DB once before commit. |
| Schema in transaction (#2) means a partial migration on crash leaves the DB unchanged — but if startup hits this, the user can't open the app at all | Add a panic-on-failure log; the alternative (leaving partial schema) is worse. |
| Parallel auto_init_sync (#5) may overwhelm HCFS server on accounts with 50+ drives | Add `Semaphore` limit (e.g. 8) if observed; ship without first to measure. |
| Snapshot dirty flag (#4) introduces version counter; missed bumps will silently drop UI updates | Test asserts a known mutation triggers an emit. Use a single helper to mutate-and-bump so the contract is hard to bypass. FE consumers verified to be event-driven only (no `setInterval`/`setTimeout` tied to snapshot cadence in `app/lib/hooks/useSyncSnapshot.ts` or `useTraySync.ts`). |
| `format_balance` precision fix (#21) changes formatted output for large values | Document as a correctness fix in commit message. Snapshot tests for chart render may need to update. |
| Combined `get_wallet_overview` (#6.6) is a new IPC; FE must still work without it | Keep old commands; new one is additive. |
| 7 commits in a row is a lot for one branch | Each batch commit is independently revertable; if any breaks, `git revert <sha>` and re-plan that batch only. |

# Acceptance criteria

A batch is "done" when:

1. All listed file changes are committed.
2. `SQLX_OFFLINE=true cargo build` succeeds.
3. `cargo clippy --all-targets -- -D warnings` is clean.
4. `cargo test` is green (full suite, not just touched tests).
5. For batches 4 and 6 specifically: the new test for the behavior change exists and passes.
6. The commit message references the finding numbers from this plan.

# Out of scope

- Frontend changes. Combined `get_wallet_overview` lands as additive IPC; FE migration is a separate task.
- Benchmarks. Adding a `criterion` harness is a meta-task — flag for follow-up if any of these fixes need quantitative justification.
- The `mcp__illu__quality_gate` guard from CLAUDE.md is acknowledged but illu MCP is currently broken in this session; replace with rigorous `cargo clippy` + `cargo test` per batch.

# References

- Validated findings list: this conversation, two messages prior.
- Prior sync-progress perf fix: commit `e93ec206` ("perf: fix 100% CPU during bulk file downloads") and `docs/plans/2026-04-09-sync-progress-perf.md`.
