# Browsable Folder Shares — Desktop Phase 3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use subagent-driven development to
> implement this plan task-by-task. Every subagent prompt must include:
> "Call `mcp__hippius-mem__recall` about the task before making changes, and
> `mcp__hippius-mem__remember` any durable decision/gotcha you discover."
> Load the `rust-style` skill before any Rust edit.

**Goal:** Replace the desktop's zip-snapshot folder share with the live
browsable share: a one-POST mint producing `/share/folder/{token}` links,
gated on `capabilities.folder_shares`, deleting the zip pipeline.

**Architecture:** Server = hcfs `27a48bd` (anonymous
`/v1/folder-shares/{token}/meta|browse|blob` + owner CRUD; design doc
`docs/plans/2026-08-23-browsable-folder-share-design.md` in hcfs). Client
surface = `hcfs_client::client::folder_share` (mint/list/revoke/update,
URL builders, `folder_share_token_hash`). Console phase 2 = hippius-console
PR #697 (recipient page — desktop links point at the console). Desktop work:
rev-bump the hcfs-client pin, swap the mint under the existing IPC surface,
delete `zip_dir.rs` + preflight + settlement guard, wire owner ops + badges,
gate on the capability.

**Tech Stack:** Tauri (Rust src-tauri + Next.js frontend), SQLite keystore,
pnpm typecheck/test, cargo check/clippy/test.

**Branch/base:** `feat/browsable-folder-shares` off `origin/staging` (PR
target `staging`). Worktree: `hippius-desktop-internal-wt-folder-shares`.

## Server/client contract (authoritative: hcfs @ 27a48bd)

- `HcfsClient::create_folder_share(&self, file_key: &[u8; 32],
  &FolderShareOptions{path_prefix, display_name, ttl, password,
  console_base_url}, &dyn ShareKeystore) -> CreatedFolderShare` —
  `folder_hash` comes from the CLIENT CONFIG, so the mint needs a
  DRIVE-scoped client (the file-share flow's account-scoped label-less
  client from `src-tauri/src/shares/client.rs:15` returns
  `MissingFolderHash`). The caller supplies the drive's DERIVED 32-byte file
  key (what the sync engine derives per drive), never folder-mnemonic
  entropy.
- Password validated pre-network; `ShareSecret::{Public,Private}` reuse — a
  password share can never rebuild `#k=`; keystore stores a fresh copy.
- `list_folder_shares` rows carry `token_hash` (blake3 hex) ONLY — match
  stored keystore tokens via `folder_share_token_hash`. Desktop's SQLite
  keystore is PERSISTENT, so shares minted on this machine stay resolvable
  across restarts (better than the console's in-memory story); rows minted
  elsewhere are view-only.
- `update_folder_share_expiry` → new expiry only (PATCH response carries NO
  token); `revoke_folder_share(token, keystore)` forgets the secret.
- Create's 404 `folder_not_found` slug is discriminated from a bare 404
  (not-yet-deployed server) as `FolderShareError::FolderNotRegistered`.
- Gate ALL folder-share UI on `capabilities.folder_shares == true`
  (`hcfs_get_capabilities` already exists; extend its wire type if the
  desktop mirror lacks the field).
- Links: `{console_base}/share/folder/{token}#k=…|#p=…` via
  `build_folder_share_url_for`; console base from the existing
  compile-time-channel resolver (`shares/commands.rs:35-110`) — unchanged.

## Tasks

### Task 1: hcfs-client rev bump + contract pins

- `src-tauri/Cargo.toml:148`: rev `ab4b5cd…` → `27a48bd…` (full SHA of hcfs
  origin/main); `cargo update -p hcfs-client` (and hcfs-shared if pinned).
- Fix any compile fallout across src-tauri (expect none beyond new API
  surface; the shared-drives-era required-field lessons are already
  absorbed).
- Extend `tests/hcfs_contract.rs` (the shared-drives precedent) with
  folder-share pins: `build_folder_share_url(_private)` exact vectors
  (copy hcfs's unit vectors: zero key → 43 'A's, [1,2,3] → `#p=AQID`),
  `folder_share_token_hash` KAT, `FolderShareOptions`/list-item wire-shape
  pins, and the `ShareSecret` private-never-`#k=` invariant via
  `build_folder_share_url_for`.
- Verify: `cargo check` + `cargo test` (src-tauri) + existing suites green;
  `pnpm typecheck` + `pnpm test` untouched-green (823 baseline).
- Commit: `chore: bump hcfs-client for folder-share client surface`

### Task 2: Rust mint swap + zip deletion

- Rewrite `hcfs_create_folder_share` (`src-tauri/src/shares/commands.rs:852`)
  as a thin mint: resolve the drive + rel path via the existing
  `folderShareRelativePath`-equivalent inputs, build a DRIVE-scoped client,
  derive/fetch the drive file key the way the sync engine does (find the
  canonical derivation — do NOT invent a second one), call
  `create_folder_share` with `SqliteShareKeystore`, return the link +
  optional password (mirror the file-share IPC's response shape so the FE
  contract stays stable — check what ShareFileModal expects).
- Keep the IPC name; drop the `Channel<ShareProgress>` param if present on
  the folder path (one round trip — check FE wrapper signature; change both
  sides together).
- DELETE: `src-tauri/src/shares/zip_dir.rs`, `hcfs_folder_share_preflight`
  IPC (+ registration in `main.rs`), `folder_settlement_blocks_share` guard,
  `share_directory_as_zip` funnel — the finder_bridge confirm flow
  (`finder_bridge/commands.rs`) must route to the mint instead; verify what
  the shell right-click actually needs now (probably just the mint + copied
  link) and keep its limits-free.
- `share_origin` sidecar (`shares/origin.rs`): record folder shares too if
  the "Shared" badge derives from it — read how the badge resolves and keep
  ONE identity source ({folder_hash|label, relative_path}), mirroring the
  console's folderShareTarget lesson.
- Capability check: mint IPC fails with a distinct error when
  `folder_shares` is absent (FE gates too, but the IPC must not rely on FE).
- Tests: Rust unit tests for the mint plumbing (mock server via the crate's
  existing test idioms if present; else wire-shape/validation tests), plus
  make sure deleted-module references are gone (`cargo check` proves it).
- Commit: `feat: folder shares mint a live browsable link` (+ a separate
  commit for the deletions if cleaner: `chore: delete the zip folder-share
  pipeline`).

### Task 3: Rust owner ops

- New/updated IPCs: `hcfs_list_folder_shares` (rows + keystore resolution →
  `resolvable` flag + rebuilt URL for resolvable rows),
  `hcfs_revoke_folder_share`, `hcfs_update_folder_share_expiry`.
  Reuse the account-scoped client (list/revoke/PATCH are drive-agnostic
  owner ops — VERIFY against hcfs-client's implementation which base it
  needs; list uses the bearer only).
- History: mirror the file-share local history (`shares/history.rs`) for
  folder shares ONLY if it drops in cleanly; else skip with a comment
  (console precedent: folder listing retains dead rows until reap, which
  breaks disappearance-diff history).
- Tests per the crate's idiom.
- Commit: `feat: folder-share listing, revoke, and expiry over IPC`

### Task 4: Frontend swap

- `app/lib/tauri/shares.ts`: folder-share wrappers updated to the new IPC
  shapes; delete `folderSharePreflight`.
- `ShareFileModal.tsx`: folder flow = instant mint (no phases/progress),
  zip copy → live-view copy, password/TTL UI unchanged, errors surface the
  IPC error message (incl. the not-registered and capability cases).
- `folderShareGating.ts`: drop settlement/preflight gating; gate on
  `capabilities.folder_shares` with a disabled tooltip (reuse
  FOLDER_SHARE_DISABLED_TOOLTIP-style constant if present; else add one).
  Member-drive rows stay non-mintable (server is owner-mint-only v1) —
  verify existing member gating covers this.
- Shares page (`app/(pages)/shares/page.tsx` + `shareRowDisplay.ts`): folder
  rows (display_name + path_prefix, whole-drive rendering), copy/revoke/
  change-expiry for resolvable rows, honest view-only for foreign rows
  (console copy precedent), badges via the origin/identity source from
  Task 2.
- FE tests per repo idiom (vi.mock the tauri wrappers as existing tests do).
- Verify: `pnpm typecheck`, `pnpm test` (823 baseline + new).
- Commit: `feat: live folder-share UI replaces the zip flow`

### Task 5: Finish

- Full pipeline: `pnpm typecheck && pnpm test`; `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings` (match the repo's actual lint
  gate — check CI workflows for the exact invocations), `cargo test`.
- Whole-branch diff re-read; delete dead references; update any docs.
- PR → `staging`, factual description; run the review-pr flow; remember
  durable decisions.

## Known constraints

- Recipient links resolve only on the production console once console
  PR #697 merges + deploys — note in the PR description.
- A REAL end-to-end check (mint on desktop → open link in browser) needs
  prod server (deployed) + prod console; the desktop test story is contract
  pins + mocked-transport tests, same as file shares.
