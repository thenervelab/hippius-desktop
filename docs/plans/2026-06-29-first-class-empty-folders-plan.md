# First-class Empty Folders Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make empty nested folders synced from the desktop app appear in the web Console (Phase 1) and materialize on other devices' disks (Phase 2), via a first-class `folder_entries` server entity — without changing how existing files are stored, counted, listed, or deleted.

**Architecture:** A new isolated `folder_entries` table in hcfs-server (keyed `(user_id, relative_path)`, same `user_id` composite as `file_records`) holds one row per directory. `/browse` unions file-derived folders with these entity rows, **deduplicated by name**. hcfs-client gets standalone register/unregister/list APIs that never touch the sync `FileTree`. The desktop registers entities (backfill + per-cycle reconcile) and, in Phase 2, materializes remote entities as empty local directories under an empty-only delete guard. Console is unchanged.

**Tech Stack:** Rust (hcfs-server: axum + sqlx/Postgres; hcfs-client: reqwest; desktop: Tauri + sqlx/SQLite), TypeScript (Console — no change). Tests: real Postgres (`TEST_DATABASE_URL`), the live `hcfs-e2e-tests` harness, and a new real-backend desktop harness. **No mocks of the system under test anywhere** (enforced by `hcfs/scripts/check-e2e-purity.sh`).

**Source design:** `docs/plans/2026-06-29-first-class-empty-folders-design.md` (read it first).

---

## Conventions for every task

- **TDD, no exceptions** — write the failing test, run it, confirm it fails for the *right* reason, implement minimally, confirm green, commit. Reference @superpowers:test-driven-development.
- **No mocks of the thing under test.** Server tests hit real Postgres; client/e2e tests hit a real hcfs-server. If a test needs a mock to pass, the test is at the wrong layer.
- **Rust gate workflow (mandatory per repo CLAUDE.md) on every Rust diff:** `mcp__illu__rust_preflight` → short data-structure/error plan → `mcp__illu__axioms` (baseline + task query) → `mcp__illu__project_style` + `mcp__illu__decisions` → `mcp__illu__exemplars` only if a trigger keyword matches → implement → `mcp__illu__critique` on the diff (if it touches unsafe/FFI/Box-of-primitive) → `mcp__illu__quality_gate` with the seven `self_review_*` answers. Use `mcp__illu__*` for code exploration, not Read/Grep.
- **Line numbers below are approximate** — confirm against current code in the task; symbol names are stable anchors.
- **Commits:** imperative mood, one logical change. Never push to a protected branch; work on the feature branch in each repo's worktree.
- **CLAUDE.md updates:** when a task adds an IPC command, event, table, or wire type, update the repo's CLAUDE.md in the same commit.

---

## Phase 0: Worktrees & branches

### Task 0.1: Create isolated worktrees in both repos
Reference @superpowers:using-git-worktrees.

- hcfs: `cd /Users/georgiosdelkos/Documents/GitHub/Bitensor/hcfs` → create worktree on branch `feat/first-class-empty-folders` off the repo's integration base (confirm base: `main` or `dev`).
- desktop: `cd /Users/georgiosdelkos/Documents/GitHub/Bitensor/hippius-desktop-internal` → create worktree on branch `feat/first-class-empty-folders` off `redesign` (the active integration branch).
- Verify each worktree is clean and on the new branch. Copy the two design/plan docs into the desktop worktree (or rebase the branch onto the commit that contains them).

**Commit:** none (scaffolding).

---

## Phase 1 — Visibility (fixes the reported bug)

> Order matters: hcfs-shared → hcfs-server → hcfs-client → hcfs-e2e-tests → desktop. Desktop depends on the server endpoints and client API existing.

### Task 1.1: Wire types in hcfs-shared

**Files:**
- Modify: `hcfs/hcfs-shared/src/network.rs` (near `BrowseResult` ~853 and the existing folder request types)
- Test: same file's `mod tests`, or the desktop-side pins in Task 1.16

**Step 1 — failing test:** add a serde round-trip + field-name pin test for the new request/response types:
- `RegisterFolderEntriesRequest { ss58_address: String, folder_hash: String, relative_paths: Vec<String> }`
- `UnregisterFolderEntriesRequest { ss58_address: String, folder_hash: String, relative_paths: Vec<String> }`
- (Phase 2) `ListFolderEntriesResponse { relative_paths: Vec<String> }`
Assert exact JSON keys (snake_case, matching existing folder requests) via `serde_json::to_value`.

**Step 2:** `cargo test -p hcfs-shared` → FAIL (types missing).

**Step 3:** Add the structs with `#[derive(Serialize, Deserialize, ...)]`, mirroring the existing `register_folder` request shape exactly. Add `#[non_exhaustive]` only if the existing siblings use it (match local style — check `project_style`).

**Step 4:** `cargo test -p hcfs-shared` → PASS.

**Step 5 — commit:** `feat(shared): add folder-entry register/unregister/list wire types`.

### Task 1.2: `folder_entries` migration (hcfs-server)

**Files:**
- Create: `hcfs/hcfs-server/migrations/<NEW_TIMESTAMP>_folder_entries.up.sql` and `.down.sql` (match the existing migration filename convention — check `migrations/` dir).
- Test: covered by Task 1.3's store tests (the migration runs via `sqlx::migrate!` in `HcfsStore::connect`).

**up.sql:**
```sql
CREATE TABLE folder_entries (
    user_id       TEXT   NOT NULL,
    relative_path TEXT   NOT NULL,
    created_at    BIGINT NOT NULL,
    PRIMARY KEY (user_id, relative_path)
);
CREATE INDEX idx_folder_entries_user ON folder_entries (user_id);
```
**down.sql:** `DROP TABLE folder_entries;`

Also add `folder_entries` to the `TRUNCATE` list in the test helpers (`database.rs` `truncate_tables` ~581 and `test_store` ~1776) so tests start clean.

**Commit:** `feat(server): add folder_entries table migration`.

### Task 1.3: Store API — register/unregister/list folder entities (hcfs-server)

**Files:**
- Modify: `hcfs/hcfs-server/src/database.rs` (mirror `register_folder` ~1410 / `unregister_folder` ~1450)
- Test: `database.rs` `mod tests` (mirror `test_folder_registry` ~3134; real Postgres via `TEST_DATABASE_URL`, gated by `require_db!`)

**Step 1 — failing tests** (through the public `HcfsStore` API, never raw INSERT):
- `register_folder_entries(user_id, &["a", "a/b"])` then a read returns both; calling again is idempotent (no error, no dup — PK conflict `DO NOTHING`).
- `unregister_folder_entries(user_id, &["a/b"])` removes only that row.
- **Safety invariant test:** seed `file_records` for the same `user_id` via the public file-ingestion path, register + unregister folder entities, assert the `file_records` count is unchanged (zero file rows deleted).
- Edge cases (Postgres): empty `relative_paths` slice is a no-op; a unicode path round-trips; a very long path (≤ column limit) round-trips.

**Step 2:** `TEST_DATABASE_URL=... cargo test -p hcfs-server folder_entries -- --nocapture` → FAIL.

**Step 3 — implement** `register_folder_entries`, `unregister_folder_entries`, `list_folder_entries` on `HcfsStore`. Batch insert with a single multi-row `INSERT ... ON CONFLICT (user_id, relative_path) DO NOTHING`; batch delete with `DELETE ... WHERE user_id=$1 AND relative_path = ANY($2)`. Use `composite_key(base_address, folder_hash)` for `user_id` exactly as files do. Wrap each in one statement (no transaction needed; single statement is atomic).

**Step 4:** tests → PASS.

**Step 5 — commit:** `feat(server): folder_entries store CRUD with file-deletion safety test`.

### Task 1.4: `/browse` UNION with dedup-by-name (hcfs-server) — the one careful change

**Files:**
- Modify: `hcfs/hcfs-server/src/database.rs` `browse_folder_aggregates` (~1060)
- Test: `database.rs` `mod tests` (mirror `test_browse_queries_against_fixture` ~3693)

**Step 1 — failing tests (real Postgres):**
1. **Superset regression:** with only `file_records` (no entities), `/browse` output is identical to current behavior — same folder names, `file_count`, `total_bytes`, ordering, `total_count`, `has_more` across pagination boundaries. (Snapshot the current output first as the oracle.)
2. **Empty folder:** an entity-only direct child returns `(name, 0, 0)`.
3. **Dedup:** a direct child that has both descendant files **and** an entity row appears **exactly once** with the file-derived count (not doubled); `total_folders`/offset/`has_more` unaffected.
4. **Direct-child only:** an entity at `a/b/c` does not surface as a direct child of the root (only `a` does).
5. **Ordering:** `ORDER BY LOWER(name)` preserved across the unioned set (mixed-case names interleave correctly).

**Step 2:** run → FAIL (entities ignored).

**Step 3 — implement:** change `browse_folder_aggregates` so the folder set is a **dedup-by-name union** of the existing file-derived buckets and the direct-child `folder_entries` rows for the prefix. Either:
- `FULL OUTER JOIN` the file-derived aggregate subquery with a `SELECT split_part(...) AS name` over `folder_entries` (same prefix/`substring` math), `COALESCE`-ing `file_count`/`total_bytes` to 0; or
- `UNION ALL` then wrap in an outer `GROUP BY name` taking `SUM(file_count)`, `SUM(total_bytes)` (entity rows contribute 0,0).
Keep the prefix `LIKE`/`substring` derivation identical so entity rows are scoped to direct children only. Leave `browse_files_page`, `browse_file_count`, and `slice_folders_and_compute_file_page` untouched.

**Step 4:** tests → PASS (all five). Run the existing browse tests too — they must stay green (superset).

**Step 5 — commit:** `feat(server): union folder_entries into /browse with dedup-by-name`.

### Task 1.5: Drive unregister cleans its folder entities (hcfs-server)

**Files:**
- Modify: `hcfs/hcfs-server/src/handlers/folder.rs` `unregister_folder_handler` (~152)
- Test: `database.rs` tests or a handler test

**Step 1 — failing test:** after `unregister_folder` for a drive, that drive's `folder_entries` rows are gone (so dropping a drive doesn't leak entities). Assert file-deletion behavior is unchanged (existing `delete_user_files` call still there; we only ADD a `folder_entries` cleanup).

**Step 3 — implement:** in `unregister_folder_handler`, after the existing steps, call `unregister_folder_entries`-equivalent scoped to the whole `user_id` (delete all rows for that `user_id`). Touches only `folder_entries`.

**Step 5 — commit:** `feat(server): drop folder_entries on drive unregister`.

### Task 1.6: HTTP endpoints + routes for folder entities (hcfs-server)

**Files:**
- Modify: `hcfs/hcfs-server/src/handlers/folder.rs` (mirror `register_folder` handler ~19) and the router/route registration module.
- Test: `hcfs-server/tests/server_integration.rs` is mock-storage but real-Postgres + real spawned binary — add a route-level test there that registers entities and reads them back via `/browse` (no storage needed; entities have no bytes). This runs in the **required** `integration` CI job.

**Step 1 — failing test:** POST register-entities → `/browse` returns the empty folder; POST unregister-entities → it's gone. Auth via the harness's existing bearer.

**Step 3 — implement:** `register_folder_entries_handler`, `unregister_folder_entries_handler`, (Phase 2) `list_folder_entries_handler`; validate `folder_hash` (16-hex) and each `relative_path` (non-empty, no traversal `..`, no leading `/`, depth/length bounds) exactly like the file path validation; authorize like `register_folder`. Register routes.

**Step 5 — commit:** `feat(server): folder-entry HTTP endpoints + routes`.

### Task 1.7: Client API — register/unregister folder entities (hcfs-client)

**Files:**
- Modify: `hcfs/hcfs-client/src/client/operations.rs` (mirror `register_folder` ~281 / `unregister_folder` ~403)
- Test: `hcfs-e2e-tests/tests/folder.rs` (live lane, Task 1.9) is the real-server test; add a unit test only for request-building if there's a pure helper.

**Step 3 — implement:** `register_folder_entries(&self, ss58, folder_hash, relative_paths: &[String])`, `unregister_folder_entries(...)`. POST the Task 1.1 request types to the Task 1.6 endpoints. **Must not** touch any `FileTree`/`SyncState`/`path_index` — these are standalone HTTP calls, never invoked from `sync_async`. Confirm via `mcp__illu__references` that no sync path calls them.

**Step 5 — commit:** `feat(client): folder-entry register/unregister API`.

### Task 1.8: Plan-safety regression test (hcfs-client)

**Files:**
- Test: `hcfs/hcfs-client/src/sync/plan.rs` `mod tests` (or wherever `SyncPlan::build` is unit-tested)

**Step 1 — failing/█guard test:** build a real `SyncPlan` from a real on-disk tree containing empty directories; assert **no** directory ever appears in `uploads`/`downloads`/`local_deletes`/`remote_deletes` (it never has a `FileId`). This is a guard that the engine remains file-only after our changes. (It should pass immediately — it's a regression pin; if it can't be written without the engine seeing folders, that's a red flag.)

**Step 5 — commit:** `test(client): pin SyncPlan stays file-only with empty dirs present`.

### Task 1.9: Live e2e — empty folder visible via real server (hcfs-e2e-tests)

**Files:**
- Modify: `hcfs/hcfs-e2e-tests/tests/folder.rs` and/or `browse.rs` (extend; `#[ignore]`, real deployment)
- Reuse: `hcfs-e2e-tests/tests/common/mod.rs` `TestHarness`, `browse_raw` (~674), the committed bearer/bypass tokens

**Step 1 — tests (no mocks, real server):**
- Register an empty folder entity (NO file upload) under a fresh drive → `browse` returns it with `file_count == 0`.
- Register entity + upload one sibling file under a different child → both children appear, each once.
- Register entity, then unregister it → folder gone; a previously uploaded sibling file is still present (safety).
- Cleanup via `unregister_folder` in the harness teardown.

**Step 2:** `TEST run` locally: `cargo test -p hcfs-e2e-tests -- --ignored --test-threads=1 folder` (needs network to the deployment + bearer envs). Confirm green.

**Step 5 — commit:** `test(e2e): empty folder appears in /browse via real server`.

### Task 1.10: Verify no-mock purity + CI wiring (hcfs)

- Run `bash scripts/check-e2e-purity.sh` → passes (no mock imports in e2e targets).
- Confirm the `integration` job picks up the new `server_integration.rs` route test and the `database.rs` folder/browse tests; confirm `e2e-live` triggers on the changed paths.
- **Commit:** none unless CI YAML needs a path glob added → `ci: include folder-entry tests in integration/e2e-live`.

### Task 1.11: Desktop schema — local entity cache + backfill flag (src-tauri)

**Files:**
- Modify: `src-tauri/src/utils/schema.rs` (`ensure_table_schema`) and/or `src-tauri/src/sync/paths.rs`
- Test: a Rust integration test mirroring `tests/drive_status.rs` (in-memory SQLite, real schema)

**Step 1 — failing test:** schema creates `folder_entries_local(label TEXT, relative_path TEXT, PRIMARY KEY(label, relative_path))` and adds `sync_paths.folder_entries_backfilled_at INTEGER NULL`; a fresh DB has the table and the nullable column.

**Step 3 — implement:** add the table + column via `ensure_table_schema` (idempotent, mirrors existing schema management — no migration files).

**Why a local cache table:** the per-cycle reconcile (Task 1.13) diffs on-disk directories against the last-known registered set to compute the register/unregister delta without a watcher change.

**Step 5 — commit:** `feat(desktop): folder_entries_local cache + backfill flag schema`.

### Task 1.12: Desktop backfill — register all existing directories (src-tauri)

**Files:**
- Create: `src-tauri/src/sync/folder_entries_backfill.rs` (mirror `sync/relative_path_backfill.rs`)
- Modify: `src-tauri/src/sync/lifecycle.rs` — spawn it from `initialize_sync_inner` (the single funnel, near the existing `spawn_backfill`)
- Test: `src-tauri/tests/folder_entries_backfill.rs` (mirror `tests/hippius_relative_path_backfill.rs`) + a static "init references spawn" regression like the relative-path one.

**Step 1 — failing tests:** a one-shot per drive walks the drive root, batch-registers every directory's rel-path via the client API, writes them into `folder_entries_local`, sets `sync_paths.folder_entries_backfilled_at`; idempotent on re-run; skipped when the flag is already set. The static test asserts `initialize_sync_inner`'s body references the spawn fn.

**Step 3 — implement:** mirror `run_backfill_for_drive`. Walk directories only (no file hashing — fast). Chunk the batch (e.g. 500 paths/call). Read-then-insert; never deletes.

**Step 5 — commit:** `feat(desktop): backfill registers existing directories as folder entities`.

### Task 1.13: Desktop per-cycle directory reconcile (src-tauri)

**Files:**
- Modify: the desktop sync-cycle hook (where a cycle starts/`trigger_sync` runs — confirm via `mcp__illu__references` on `trigger_sync`) and `src-tauri/src/sync/files/add.rs` `add_folder` (~138) for the immediate-register path.
- Test: `src-tauri/tests/folder_entries_reconcile.rs` (real SQLite + tempdir; the client call against the real-backend harness from Task 1.15, OR a pure delta-computation unit test for the diff logic).

**Step 1 — failing tests:**
- Pure delta: given on-disk dir set vs `folder_entries_local`, compute `(to_register, to_unregister)` correctly (added dirs, removed dirs, unchanged ignored). Unit-test this pure fn with a `proptest` invariant (applying the delta makes the cache equal the on-disk set).
- `add_folder` of a tree with empty subdirs registers those subdirs immediately.

**Step 3 — implement:** a pure `compute_dir_delta(on_disk: &BTreeSet<String>, cached: &BTreeSet<String>) -> DirDelta` + a reconcile that walks the drive's directories, computes the delta vs `folder_entries_local`, batch register/unregister via the client API, and updates the cache. Throttle so it doesn't run more often than needed. Keep it OUT of the file reconcile loop.

**Step 5 — commit:** `feat(desktop): reconcile directory entities each sync cycle`.

### Task 1.14: Desktop listing overlay shows entities (src-tauri)

**Files:**
- Modify: `src-tauri/src/sync/files/listing.rs` `list_sync_folder_grouped_inner` (~314) — include `folder_entries_local` (or a server fetch) in the server-only-folder derivation so the desktop UI matches Console.
- Test: `src-tauri/tests/list_sync_folder_nested.rs` (extend; real SQLite + tempdir)

**Step 1 — failing test:** an empty directory present on disk + cached as an entity appears in the grouped listing's folders (not dropped for having no files).

**Step 5 — commit:** `feat(desktop): show empty folders in grouped listing`.

### Task 1.15: Desktop real-backend test harness (src-tauri) — no mock

**Files:**
- Create: `src-tauri/tests/real_backend_harness.rs` (the first real-server desktop harness) + `src-tauri/tests/folder_sync_e2e.rs`
- Mechanism: seed the per-drive `server_url` with a real hcfs-server URL (env `HCFS_E2E_SERVER_URL`, falling back to the deployment) — `region::resolve_base_url` (`sync/shared/region.rs:37`) passes it through verbatim, so **no production code change**. Reuse the committed bearer/bypass tokens. Run the real `hcfs-client` Drive (`new → init → unlock → sync_async`) on a tempdir.

**Step 1 — test (`#[ignore]`, live lane):** create an empty nested directory under a synced drive → reconcile registers it → real `/browse` (via the client) returns it with `file_count == 0`.

**Step 2:** run locally with the server URL + bearer envs set; confirm green. Add the `#[ignore]` + env-skip guard so the hermetic CI run skips it.

**Step 5 — commit:** `test(desktop): real-backend e2e — empty folder round-trips to server`.

### Task 1.16: Wire-contract pins for new IPC/payloads (src-tauri)

**Files:**
- Modify: `src-tauri/tests/hcfs_contract.rs` (add serde/shape pins for the new request/response types crossing the IPC boundary)

**Step 1 — test:** pin exact JSON keys of the folder-entry request/response types so a future hcfs git-rev bump fails CI instead of silently breaking the FE.

**Step 5 — commit:** `test(desktop): pin folder-entry wire contract`.

### Task 1.17: Docs + Phase 1 close-out

- Update `hcfs` CLAUDE.md (new table, endpoints, client API) and `hippius-desktop-internal` CLAUDE.md (folder_entries_local, backfill, reconcile, listing overlay) in their respective worktrees.
- Run full gates: `cargo clippy --all-targets -- -D warnings` and `cargo test` (hermetic) in both repos; `pnpm lint` + `pnpm test` in desktop; the live lanes locally.
- Open two PRs (hcfs first, then desktop pinned to the merged hcfs rev). **Commit:** `docs: document first-class empty folders (phase 1)`.

---

## Phase 2 — Cross-device materialization

### Task 2.1: Client `list_folder_entries` (hcfs-client)
Implement + live e2e test (`folder.rs`): register entities on one identity, list them back. **Commit:** `feat(client): list_folder_entries`.

### Task 2.2: Desktop materializes remote empty dirs (src-tauri)

**Files:**
- Modify: the desktop sync-cycle path; add a `materialize_folder_entries` step.
- Test: `src-tauri/tests/folder_materialize_e2e.rs` (real-backend harness from Task 1.15)

**Step 1 — tests (real server):**
- Two drive instances on the same `folder_hash`: register an empty dir on A → after B's cycle, the empty dir exists on B's disk.
- **Empty-only delete guard:** when an entity is removed remotely, B deletes the local dir **only if it is still empty**; a dir that has local files is left intact. Add a `proptest`/fixture for the guard predicate.

**Step 3 — implement:** fetch entities, `create_dir_all` for missing ones; for removed entities, remove the local dir guarded by an emptiness check. Stays strictly outside the file reconcile loop (no `FileTree` interaction).

**Step 5 — commit:** `feat(desktop): materialize remote empty folders with empty-only delete guard`.

### Task 2.3: Phase 2 docs + close-out
Update both CLAUDE.md files; full gates; PR. **Commit:** `docs: document cross-device empty-folder materialization (phase 2)`.

---

## Acceptance criteria (the "won't break anything" guarantees)

1. Existing `/browse` output is byte-identical for non-empty folders (Task 1.4 test 1 + existing browse tests green).
2. Zero `file_records` deleted by any folder-entity operation (Task 1.3 safety test, Task 1.5).
3. No directory ever enters a `SyncPlan` mutation set (Task 1.8).
4. Empty folder appears in Console via real server (Task 1.9) and on the desktop (Task 1.14).
5. Phase 2: empty folder lands on a second device; an occupied dir is never deleted (Task 2.2).
6. `check-e2e-purity.sh` passes; required `integration` CI is green; live lanes verified locally/on PR.
