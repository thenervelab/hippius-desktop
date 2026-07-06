# First-class empty folders — design

**Date:** 2026-06-29
**Status:** Design (approved decisions, pending implementation)
**Repos touched:** `hcfs` (hcfs-server, hcfs-client, hcfs-shared, hcfs-e2e-tests), `hippius-desktop-internal` (src-tauri). **Console: no change.**

## Problem

Empty folders synced from the desktop app do not appear in the web Console.

Root cause, verified across all layers:

- A **top-level sync folder ("drive")** is first-class: `initialize_sync_inner` → `spawn_folder_registration` calls `register_folder` with no file requirement, writing a standalone `folder_registry` row that the Console's `/list_folders` shows even at `fileCount: 0`. Empty drives already work.
- A **nested subfolder** is *not* first-class anywhere:
  - hcfs-client `collect_files` (`drive/scan.rs:105`) records only `is_file()` entries; an empty directory uploads nothing.
  - hcfs-server `/browse` synthesizes subfolders by `GROUP BY split_part(relative_path, '/', 1)` over **file** rows (`browse_folder_aggregates`, `database.rs:1060`). No file under a prefix ⇒ no folder.
  - The Console faithfully renders every folder the server returns (no `file_count > 0` filter) and never path-splits HCFS folders client-side — it simply receives nothing.

So an empty nested folder produces **no server artifact**, which is why Console can't show it.

## Goal

Make an empty nested folder a real, server-side entity so it appears in Console (Phase 1) and, optionally, materializes on other devices' disks (Phase 2) — **without** altering how existing files are stored, counted, listed, or deleted, and **without** creating placeholder files in users' folders.

## Approach chosen: first-class folder entities (not placeholder files)

A placeholder/`.keep` marker was rejected: it writes real files into every user folder on every device, and "don't count the marker" forces filtering at every count/list/search site across **server + desktop + Console** (the browse `COUNT(*)` is computed server-side, so even the count fix is unavoidable there). That modifies the battle-tested file hot-paths and pollutes user data. First-class entities sit in an isolated table, leave the file paths untouched, and need **zero** Console change.

### Safety verification (why existing files are not at risk)

Both confirmed against real code before this design:

1. **No DB cascade.** There is no foreign key / `ON DELETE CASCADE` between `folder_registry` and `file_records` (`migrations/...initial_schema.up.sql`). The only file deletion on folder removal is an explicit hand-written `delete_user_files` call in `unregister_folder_handler` (`hcfs-server/src/handlers/folder.rs:167`). A new folder-entity delete simply omits that call; the DB pulls nothing down with it.
2. **Sync engine cannot misclassify a folder as a deleted file.** Every `SyncPlan` set is `Vec<FileId>` where `FileId = BLAKE3(relative path)` (`hcfs-client/src/sync/plan.rs`); `classify_file` decides purely on the per-file `(local, remote, synced)` triple. Directories are structurally unrepresentable in `SyncState` (no `is_dir` field). A folder entity registered through a **separate** client API never enters the file trees the reconciler reads, so the stale-baseline `local_deletes` data-loss pattern (fixed in `17b8e159`) cannot be triggered by it. Guardrail: keep folder entities out of the `get_all_files` file count so the existing `SuspiciousEmptyRemote` defense is unperturbed.

The only residual risk is a **recoverable display/pagination bug** in `/browse` (see UNION risk below) — never data loss.

## Data model

New table in hcfs-server (additive migration — `CREATE TABLE`, metadata-only, instant even with millions of file rows):

```
folder_entries
  user_id        TEXT NOT NULL    -- composite_key(base_address, folder_hash), same key as file_records.user_id
  relative_path  TEXT NOT NULL    -- the directory's path within the drive, no trailing slash
  created_at     BIGINT NOT NULL
  PRIMARY KEY (user_id, relative_path)
```

Chosen over a subpath column on `folder_registry` because that would force the nested path into `folder_registry`'s primary key, changing the meaning of every existing `register_folder`/`unregister_folder` query (which key on `(base_address, folder_hash)` only). A separate table keeps the new folder-delete confined to its own rows and gives `/browse` a clean union source keyed identically to `file_records`.

**Entity = directory exists** (one row per directory), *not* "empty directories only." A stateful "became empty / became non-empty" model would silently re-hide a folder whose files were all later deleted (it never got an entity). Registering every directory makes the model stateless; the `/browse` dedup makes a folder that has both files and an entity appear exactly once with the correct count.

## Per-layer changes

### hcfs-shared
- Extend `register_folder` request (or add a sibling request type) to carry a **batch** of `relative_path`s for nested folder entities, plus an unregister-batch variant. Add pin tests for the new wire shapes.

### hcfs-server
- **Migration:** create `folder_entries`.
- **Store API:** `register_folder_entries(user_id, &[relative_path])` (batch upsert, `ON CONFLICT DO NOTHING`), `unregister_folder_entries(user_id, &[relative_path])`, and (Phase 2) `list_folder_entries(user_id)`.
- **Handlers:** new endpoints for the above; on **drive `unregister_folder`**, also delete that drive's `folder_entries` rows (so dropping a drive cleans its entities — touches only `folder_entries`, never `file_records`).
- **`/browse` UNION (the one careful change):** inside `browse_folder_aggregates`, union the file-derived buckets with the direct-child folder-entity rows, **deduplicated by name** (FULL OUTER JOIN on name, or wrap the union in an outer `GROUP BY name`), emitting `(name, 0, 0)` for an entity with no descendant files. Preserve `ORDER BY LOWER(name)` and restrict entity rows to **direct children** of the requested prefix (mirror the `split_part(..., '/', 1)` derivation). `browse_files_page`, `browse_file_count`, and the Rust `slice_folders_and_compute_file_page` need **no** change.
  - **Risk if done wrong:** a naive `UNION ALL` double-counts a folder that has both files and an entity → inflates the Rust-computed `total_folders = folder_rows.len()` → corrupts offset / `has_more` / the folder→file page boundary. Dedup-by-name is mandatory and is the primary thing tests must pin.

### hcfs-client
- Add `register_folder_entries` / `unregister_folder_entries` (and Phase 2 `list_folder_entries`) to `HcfsClient` — standalone HTTP calls, **not** wired into `sync_async`, `scan_local_files`, or any `FileTree`. They must never inject a `FileMetadata` into any tree.
- A directory-enumeration helper for the desktop to batch current directories under a drive root (used by registration + backfill).

### hippius-desktop (src-tauri)
- **Lifecycle triggers:** register a folder entity on directory creation, unregister on directory removal:
  - The `add_folder` copy path (`sync/files/add.rs`) walks the copied tree and batch-registers all directories.
  - The file-watcher's directory create/remove events drive incremental register/unregister (extend the existing `notify`-based watcher path; reuse the rename-hint plumbing's event source).
  - A folder-create IPC for the desktop "New Folder" UI registers immediately.
- **Backfill (additive, idempotent):** a one-shot per drive mirroring `relative_path_backfill` exactly — walk the drive's directory tree, batch-upsert all directory entities. Gated by a new `sync_paths.folder_entries_backfilled_at` flag, spawned from `initialize_sync_inner` (the single funnel). Read-then-insert, never deletes. A static regression test asserts `initialize_sync_inner` references the spawn (same pattern as `tests/hippius_relative_path_backfill.rs`).
- **Listing overlay:** `list_sync_folder_grouped` already overlays rel-path cache onto disk; extend its server-only-folder derivation to include folder entities so the desktop's own UI matches Console.
- **Phase 2 only:** on sync, fetch folder entities and `create_dir_all` for ones missing locally; on remote-deleted entity, remove the local directory **only if it is still empty on disk** (never delete a directory containing local files). This stays strictly outside the file reconcile loop.

### Console
No change. It already renders `fileCount: 0` folders from `/browse` and `/list_folders`.

## Phasing

- **Phase 1 — visibility (ships the bug fix):** entity table + register/unregister/backfill + `/browse` UNION + desktop listing overlay. Empty folders appear in Console and the desktop. Lower risk; data model already supports Phase 2.
- **Phase 2 — cross-device materialization:** desktop fetches entities and creates/removes empty local directories under the empty-only-delete guard. Sequenced after Phase 1.

## Test strategy — no mocks anywhere

Layered, with the load-bearing tests being **regression/superset** and **safety-invariant**, not the happy path. No wiremock/mockito/httpmock/mockall/faux/axum-stub for the system under test (enforced in hcfs by `check-e2e-purity.sh`).

### Merge-gating, hermetic, no-mock: server DB tests (real Postgres)
Run in the **required** `integration` CI job against the postgres:16 service container via `TEST_DATABASE_URL`, through the public `HcfsStore` API (no direct SQL inserts that bypass it):
1. **Superset regression** — for existing non-empty folders, `/browse` output (folders, counts, sizes, `total_count`, `has_more`, pagination) is byte-identical to pre-change behavior. The "didn't break browsing" guard.
2. **Dedup** — a folder with both files and an entity appears exactly once with the file-derived count; pagination boundaries intact.
3. **Empty folder** — an entity-only folder appears as `(name, 0, 0)`.
4. **Delete-safety invariant** — registering then unregistering a folder entity deletes **zero** `file_records` rows (asserted directly). Dropping a drive (`unregister_folder`) removes its entities but the file-delete path is unchanged.
5. **External-API edges (Postgres):** deep nesting, unicode names, `ORDER BY LOWER(name)` collation, empty/whitespace/`/`-containing names rejected, offset/limit exactly at the folder→file boundary, max path length.
6. **Property tests** on the pure pieces (browse dedup/merge, direct-child path derivation): superset (`union ⊇ file-derived`) and idempotence (`register(register(x)) == register(x)`).

### Full-stack, no-mock, live lane (non-hermetic by nature)
Run as `#[ignore]` in the PR-only `e2e-live` job against the **real deployed hcfs-server + real Postgres + real Arion**, reusing the committed e2e bearer + `X-Billing-Bypass` tokens and a fresh random SS58 per run (cleaned up via unregister):
7. **hcfs-e2e-tests** (extend `folder.rs` / `browse.rs`): register an empty folder entity (no file upload) → `/browse` returns it with `file_count == 0`; register entity + sibling file → folder appears once; unregister entity → folder gone, sibling file still present.
8. **hcfs-client**: drive a real `SyncPlan::build` with entities registered and assert folders never appear in `local_deletes`/`remote_deletes` and the `SuspiciousEmptyRemote` guard is unperturbed.

### Desktop — new real-backend harness (no mock)
There is no real-backend desktop test today; build one. Seed the per-drive `server_url` with a real hcfs-server URL (the `region::resolve_base_url` passthrough seam — no production code change), run the **real** `hcfs-client` Drive (`new → init → unlock → sync_async`) against it on a real tempdir filesystem with real encryption:
9. Create an empty nested directory under a synced drive → entity registered → real `/browse` returns it.
10. **Phase 2:** second drive instance pointed at the same server materializes the empty directory on its own tempdir; deleting it remotely removes it locally only while empty.
11. **Wire-contract pin** for the new IPC/payload types (so a future hcfs git-rev bump can't silently break the FE), alongside the existing `hcfs_contract.rs` pins.
This harness is `#[ignore]`/live-lane (it needs a reachable server); the hermetic merge gate is the server DB suite above.

### Regression guard summary
"Won't break anything else" = tests 1 (browse byte-identical), 4 (no file deletion over folders), 8 (no file deletes in the plan), plus the existing `hcfs_contract.rs` KAT/serde pins and the desktop drive-status/lifecycle suites continuing to pass.

## Open follow-ups (not blockers)
- Batch size / chunking for backfill on very deep trees (one HTTP call per N paths).
- Whether Phase 2's empty-dir materialization should be opt-in per drive.
- The `e2e-live` lane being non-required means a green hermetic gate doesn't prove the live round-trip; the live lane must be watched on the feature PR.
