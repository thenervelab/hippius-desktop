# PR 7 / Task 7.2 — `relative_path` threading verification

Task 7.2 in the hcfs nested-folder-browsing plan asks us to:

> Thread `relative_path` through upload + rename — wherever the desktop builds a
> `Manifest` or `SingleRename`, plumb the existing relative-to-sync-folder path
> value into `Manifest.relative_path` / `SingleRename.new_relative_path`.

The plan was written before hcfs-client fully absorbed upload/rename manifest
construction. After the bump to hcfs-client `c0652ad` (Task 7.1), this task is
a verified no-op on the desktop side: hcfs-client owns every `Manifest` and
`SingleRename` construction and it already threads the relative path. This
note records the evidence so a future reader can re-derive the conclusion
without re-doing the search.

## Evidence: desktop builds no `Manifest` or `SingleRename` directly

Ran both an `illu` symbol query and a raw `ripgrep` at the worktree root
(`/Users/georgiosdelkos/Documents/GitHub/Bitensor/hippius-desktop/.worktrees/desktop-pr7-relative-path-backfill`)
on HEAD `f35c1d60` of branch `feat/desktop-pr7-relative-path-backfill`.

- `mcp__illu__query query="Manifest"` returned only unrelated hits
  (`SYNC_PLAN_READY` const, two migration-mock tests about filtering manifest
  files, and `load_env`). No struct literal, no `::new` call site.
- `mcp__illu__query query="SingleRename"` returned "No results found".
- `rg -n 'Manifest\s*::\s*new|Manifest\s*\{|SingleRename\s*\{|SingleRename\s*::\s*new' src-tauri/ --type rust`
  returned zero matches.
- The same `rg` expanded to the whole worktree (no `src-tauri/` scope) also
  returned zero matches.

Both scanners agree. The desktop crate does not construct either type.

## Evidence: hcfs-client `c0652ad` threads `relative_path` on both paths

Cross-repo `illu` queries against the `hcfs` repo (pinned in
`src-tauri/Cargo.toml:92` as `hcfs-client = { git = "...", rev = "c0652ad" }`)
show the canonical construction sites already carry the relative path:

- **Upload (per-drive loop)** — `hcfs-client/src/drive/upload.rs`:
  `impl Drive` at 429–742 contains `Drive::upload_file` (434–616). The body
  pulls `let relative_path = state.path_index.get(file_id)` from the sync
  state and hands it through to manifest construction.
- **Upload (standalone / `add_file` fast path)** — same file,
  `upload_file_standalone` at 753–1091 takes `relative_path: PathBuf` as a
  required parameter, so every caller is forced to supply it.
- **Rename** — `hcfs-client/src/drive/sync_flow.rs`,
  `Drive::execute_sync_plan` (540–963) produces `SingleRename` entries from
  `RenameOp` values whose struct definition
  (`hcfs-client/src/sync/mod.rs:62-69`) has
  `pub new_relative_path: PathBuf`. The body contains
  `let path_str = rename_op.new_relative_path.to_string_lossy();`, and the
  rename-hint pipeline (`hcfs-client/src/sync/rename.rs`) populates
  `new_relative_path` on every expansion.

With the upload helper requiring `relative_path: PathBuf` and the rename path
typed on a struct whose `new_relative_path` field is non-optional, hcfs-client
cannot produce a `Manifest` or `SingleRename` without the relative path — the
compiler prevents it. That makes any desktop-side "plumbing" redundant.

## Why no desktop edit is required

The desktop crate calls the sync engine only through hcfs-client's public
`Drive` API (see `src-tauri/src/sync/lifecycle.rs` and `sync/control.rs`).
Drive-level APIs (`sync_async`, `stage`, `add_file`) do not expose a
`Manifest`-shaped surface to the desktop. Threading `relative_path` through
"wherever the desktop builds a Manifest" therefore has no edit target in this
repo — the edit target is one dependency deeper and already landed.

## How to verify at runtime

Task 7.4 will automate this, but for a manual smoke test:

1. Configure a sync drive whose root contains a nested file, e.g.
   `~/Sync/alpha/beta/nested.txt`.
2. Run `pnpm tauri:dev` with `RUST_LOG=hcfs_client=debug`.
3. After the sync cycle completes, inspect the hcfs-server row for that file
   (`hcfs_files.relative_path`). It must read `alpha/beta/nested.txt`, not
   `NULL` and not just `nested.txt`.
4. Rename `~/Sync/alpha/beta/nested.txt` → `~/Sync/alpha/beta/renamed.txt`
   and trigger another sync. The same row's `relative_path` must update to
   `alpha/beta/renamed.txt` via the rename path (not a delete+re-upload).

If either check fails, the regression is in hcfs-client, not the desktop, and
belongs on the hcfs side.
