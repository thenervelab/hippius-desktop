# Shared Drives Phase 2 (Desktop) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or
> subagent-driven-development) task-by-task. Load `rust-style` before the first Rust
> edit. Re-read team memory `mem_01M0FX6YX0KVKWG7QW57G8RD0Y`,
> `mem_01M0FRRJA3C0N0ZY79NDZVRQ9V`, `mem_01M0FVPRAT1ENQNH9A1E13D82Q` before coding.

**Goal:** The desktop consumes hcfs PR #348: owners mint drive-invite links and manage
members; members see drives shared with them, sync them locally as first-class drives,
and get a clean "access revoked" state.

**Architecture:** A `DriveIdentity` resolver decouples the local label from the wire
identity (`owner_ss58`, `wire_folder_hash`) — own drives resolve to today's values, so
every existing path is unchanged by construction. Member drives branch inside the
existing `initialize_sync_inner` funnel (config overrides + skips), never a parallel
funnel. All UI is dark behind `SHARED_DRIVES_ENABLED = false` in `featureFlags.ts`.

**Tech Stack:** Rust (src-tauri), hcfs-client/hcfs-shared pin bump, Next.js FE, vitest,
cargo test. Worktree: `.worktrees/feat-shared-drives` (branch
`feat/shared-drives-desktop`, based on `203f0d1d` / origin/staging).

**Blocking dependency:** hcfs PR #348 must merge first; Task 1 pins to its MERGE
commit. Until then Tasks 2 and 6-lite (FE-only scaffolding) are the only startable work.

**Scope cuts for v1 (deliberate, documented in code where they bite):**
- Member drives skip the relative-path backfill, folder-entries backfill, and the
  per-cycle folder-entity sync — empty folders from the owner do not materialize on
  member devices in v1 (files sync fully; the engine needs none of the three).
- Migration, share-link creation, and selective-sync exclusions UI are untouched for
  member drives (server rejects member share creation anyway).
- Membership fetch is FE-on-demand via IPC, NOT wired into `restore_session` — the
  login path stays hang-proof (its `initSync` timeout discipline,
  `wallet-auth-context.tsx:206-224`, is not risked for a listing).

**The three land mines (from recon 2026-08-20 — each is a data-loss bug if missed):**
1. `ensure_derived_mnemonic` (`sync/shared/mnemonic.rs:62-124`, called unconditionally
   from `prepare_config_dir`, `lifecycle.rs:854`) compares the folder seal against
   `derive(local master, label)` and on mismatch REWRITES the seal, drops
   `.needs_rekey`, and wipes sync state. The owner's folder mnemonic never matches the
   member's derivation → it must be inert for member drives.
2. The `user_id` equality assert (`lifecycle.rs:1236-1243`) hard-fails unless
   `user_id == "{account_id}_{fhash}"` — must assert the OWNER composite for members.
3. `folder_hash(local_label)` is used as the wire hash at ~12 sites (remote.rs,
   folders.rs, recent_uploads.rs, reconcile/backfills, migration.rs). A member's local
   label CANNOT derive the wire hash — every drive-scoped site must go through the
   resolver (Task 2). `folders.rs:200-208` builds a config by hand, bypassing
   `build_hcfs_config` — do not miss it.

**Cross-client contract (Phase 3 console must mirror; pin with a KAT):**
Grant-blob sealing = `hcfs_client::mnemonic_blob::seal_mnemonic` (Argon2id +
XChaCha20-Poly1305), AAD = MEMBER ss58, passphrase =
`hex(HKDF-SHA256(bip39_seed(member_master)[..64], salt = member_ss58 bytes,
info = "hippius-drive-grant-v1"))` — the `crypto/store.rs::derive_key` shape with a
new `INFO_DRIVE_GRANT` constant. Payload = the OWNER's folder-mnemonic ENTROPY
(32 bytes), not the phrase. `grant_blob` on the wire is the SealedBlob JSON as bytes,
base64 PADDED standard. Invite-link fragment = `#k=<base64url no-pad entropy>`.

---

## Task 1: hcfs pin bump + wire pins

**Files:** `src-tauri/Cargo.toml:143,148` (both revs move together — comment block
rule at `:132-147`); `src-tauri/tests/hcfs_contract.rs`;
`src-tauri/src/sync/projection/events.rs`; `src-tauri/src/sync/shared/region.rs:66`
(stale rev comment).

**Steps:**
1. After PR #348 merges: set both revs to the merge commit; `cargo update -p
   hcfs-client -p hcfs-shared` equivalents via `cargo build`; append the changelog
   comment line ("shared drives: for_shared_drive, SHARED_DRIVE_REVOKED_MARKER,
   invite/membership DTOs").
2. `SHARED_DRIVE_REVOKED_MARKER`: re-export in `events.rs` beside `CANCELLED_MARKER`
   (`events.rs:126-139`) — import `hcfs_client::engine::SHARED_DRIVE_REVOKED_MARKER`,
   never re-type the string; add the drift-guard test mirroring `events.rs:146-149`.
3. Wire pins in `tests/hcfs_contract.rs` (its literal-JSON convention, e.g. `:187`):
   serialize/deserialize round-trips for the invite/membership DTOs the desktop
   consumes (`hcfs_shared::network`: create-invite req/resp, meta resp, accept
   req/resp with `already_owner` ABSENT when false, memberships resp with
   `grant_blob` + `display_label`). Plus a KAT for `Mnemonic::from_entropy`
   round-trip of the fragment encoding (entropy → base64url no-pad → phrase).
4. Full gates: `cd src-tauri && SQLX_OFFLINE=true cargo build && cargo test`,
   `cargo clippy --all-targets --all-features -- -D warnings`, `cargo fmt --all
   --check`. Commit: `chore: bump hcfs pin to shared-drives rev + wire pins`.

## Task 2: schema + DriveIdentity resolver

**Files:** `src-tauri/src/utils/schema.rs` (`ensure_sync_paths` :164-235, constraint
copy :274-301); `src-tauri/src/sync/drive/paths.rs` (+ BOTH test DDL mirrors at
`paths.rs:443` and `:676`); new `src-tauri/src/sync/drive/identity.rs`.

**Steps:**
1. ALTERs (mirror the `relative_paths_backfilled_at` pattern, `schema.rs:209-214`):
   `owner_ss58 TEXT` (NULL = own drive), `wire_folder_hash TEXT` (NULL = derive from
   label). Update the constraint-rebuild column list and both test DDLs.
2. `identity.rs`: `pub struct DriveIdentity { pub wire_ss58: String, pub
   wire_folder_hash: String, pub is_member: bool }` and `pub async fn
   resolve_drive_identity(pool, account_id, label) -> Result<DriveIdentity, AppError>`
   — reads the row; NULL columns → `(account_id, folder_hash(label), false)`
   (byte-identical to today); both set → member. One column set without the other →
   `AppError::Db` (corrupt row, fail closed). Unit tests: own-drive passthrough,
   member mapping, half-set corruption.
3. `set_sync_path_internal` (`paths.rs:100-240`) gains optional member fields on
   `LabelMode::Allocate` inserts (own-drive callers pass None — zero behavior change;
   pinned by existing tests).
4. Commit: `feat(sync): drive identity resolver + member columns on sync_paths`.

## Task 3: member-aware init funnel

**Files:** `src-tauri/src/sync/drive/lifecycle.rs`, `src-tauri/src/sync/drive/config.rs`,
`src-tauri/src/sync/shared/mnemonic.rs`; wiring pin in a new
`src-tauri/tests/shared_drive_wiring.rs` (the `folder_share_wiring.rs` source-text
convention).

**Steps (each guarded by `identity.is_member`, resolver called once at the top of
`initialize_sync_inner` right after `load_sync_config`):**
1. `build_hcfs_config` (`config.rs:260-273`): new param carrying the resolved
   identity — sets `ss58_address = wire_ss58`, `folder_hash = wire_folder_hash`,
   `shared_drive_member = is_member`. ALL call sites thread the resolver
   (`lifecycle.rs:1207,:901,:1048`; `remote.rs:104`; backfills; `shares/client.rs:27`
   stays account-scoped/own; the hand-built config at `folders.rs:200-208` is
   converted to `build_hcfs_config`).
2. Skips for member drives, each with an intent comment: credits pre-gate
   (`lifecycle.rs:1134-1157` — owner pays; server 402 is authoritative),
   `ensure_derived_mnemonic` (land mine 1 — the folder seal holds the OWNER's
   mnemonic by design), `spawn_folder_registration` (`lifecycle.rs:1288` — server
   rejects member registration; engine's post-upload path is already guarded
   upstream), `spawn_default_recovery_binding` (`lifecycle.rs:1382`), both backfills
   (`lifecycle.rs:1368,1376`) and the per-cycle folder-entity sync trigger for that
   label (v1 scope cut).
3. `user_id` assert (`lifecycle.rs:1236-1243`): expect
   `format!("{wire_ss58}_{wire_folder_hash}")`.
4. Wiring pin test: `initialize_sync_inner` body references
   `resolve_drive_identity` and the member skips (count the guard sites — the
   scan-throttle pin precedent), so a refactor can't silently drop a skip.
5. Unit/integration: a member-shaped `sync_paths` row initializes against a wiremock
   hcfs (reuse whatever server-mock infra exists in `tests/`), asserts the config
   carries owner identity + `shared_drive_member`, `ensure_derived_mnemonic`
   untouched (the sealed file's bytes unchanged), no `/register_folder` hit.
6. Commit(s): `feat(sync): member drives run the owner's identity through init`.

## Task 4: grant blob + membership IPCs (Rust)

**Files:** new `src-tauri/src/shared_drives/` module (mod.rs, `grant.rs`,
`commands.rs`); `src-tauri/src/crypto/store.rs` (`INFO_DRIVE_GRANT`);
`src-tauri/src/main.rs:264` handler registration.

**Steps:**
1. `grant.rs`: the cross-client contract above — `grant_passphrase(master_mnemonic,
   member_ss58)` (HKDF via `derive_key` shape, new info constant; KAT-pinned with a
   fixed test mnemonic so Phase 3 console can copy the vector), `seal_grant(master,
   member_ss58, owner_folder_mnemonic_entropy)` / `open_grant(master, member_ss58,
   blob)` via `hcfs_client::mnemonic_blob`, Argon2id offloaded through the
   `recovery.rs::run_kdf` pattern (never block the runtime ~1.5s).
2. HTTP layer: reuse `shares/client.rs::build_account_client` (account-scoped,
   `folder_hash=""`) for `/v1/drive-invites` + `/v1/drive-memberships` +
   `/v1/drives/{fh}/members`. All calls bounded (30s, `recent_uploads.rs:52`
   precedent). Feature-off server → the routes 404: map to a typed
   `NotReady(SharedDrivesUnavailable)` so the FE can hide the surface, not error.
3. IPC commands (registered in `main.rs`): `create_drive_invite(label,
   expires_in_secs?, max_uses?) -> { inviteUrl }` — mints via POST, then builds the
   URL IN RUST: `{console_base_url()}/invite/{token}#k={base64url(entropy)}` where
   entropy comes from `derive_folder_mnemonic(master, label)` — the entropy NEVER
   crosses IPC except inside the final URL string (the modal only copies it);
   `list_drive_members(label)`; `remove_drive_member(label, member_ss58)` (owner
   path); `revoke_drive_invite(token_or_id)`; `list_my_drive_memberships() ->
   [{ownerSs58, folderHash, displayLabel, role, createdAt}]` (opens each grant blob
   lazily? No — blobs open only in `add_shared_drive`); `leave_shared_drive(label)`
   — self-leave, ALWAYS passing `?owner=` (memory pin) — then local removal via the
   existing `remove_drive` path; `add_shared_drive(owner_ss58, folder_hash,
   local_path, display_label)` — fetches + opens the grant blob, `LabelMode::Allocate`
   insert with the member columns, seals the owner folder mnemonic into the new
   config dir's `enc_mnemonic.json` under the member's drive password
   (`save_encrypted_mnemonic`, the `lifecycle.rs:985` call), asset-scope allow, then
   `initialize_sync_inner`. Mnemonic access ONLY via
   `sync::mnemonic::get_mnemonic_for_account` (`mnemonic.rs:136`), serialized against
   rotation with `AppState::recovery_lock` (`recovery.rs:746` pattern).
4. Tests: grant seal/open round-trip + KAT; wrong-ss58 AAD fails; `add_shared_drive`
   against a mock (row shape, sealed file present, no local-eligibility gate — owner
   pays); URL assembly (fragment format, no token/entropy logged — grep-style test on
   the module like the server's).
5. Commit(s): `feat(shared-drives): grant-blob crypto + invite/membership IPCs`.

## Task 5: revocation surfacing

**Files:** `src-tauri/src/sync/projection/tauri_bridge.rs:332-387`,
`src-tauri/src/sync/drive/drive_status.rs`, `src-tauri/src/sync/projection/status.rs`;
FE: `MultiFolderSyncManager.tsx:64-67`, `DriveOnboarding.tsx:73-75` + row rendering.

**Steps:**
1. `handle_sync_error`: new branch right after the cancel drop (`tauri_bridge.rs:340`)
   — `payload.error == SHARED_DRIVE_REVOKED_MARKER` → pause-equivalent teardown of
   that label (reuse `pause_drive`'s in-memory removal WITHOUT setting `is_paused` —
   the drive isn't paused, it's dead) + `emit_drive_status(label,
   DriveStatus::Error { message: "Access to this shared drive was removed" })` + ONE
   persisted notification (bypass the 3-strike `error_notify` gate — revocation is
   definitive, not flaky; `FailureNotify::Always` precedent).
2. FE: the two `kind === "active" ? "syncing" : "paused"` collapses gain a third
   state; a revoked row renders the error message + a "Remove" affordance (calls the
   existing remove path). Component tests beside the existing ones.
3. Pin: extend `tests/sync_cancel_notifications.rs`-style assertions — the marker
   branch exists in `handle_sync_error`'s source (wiring pin), and the marker equals
   the upstream constant (drift guard from Task 1).
4. Commit: `feat(sync): revoked shared drives surface as a terminal error state`.

## Task 6: UI — owner mint/manage + member browse/add

**Files:** `app/lib/featureFlags.ts` (`SHARED_DRIVES_ENABLED = false`, doc-comment
naming every surface); `LocalFoldersSection.tsx:326-376` + `:395-455` (menu item both
in `TableActionMenu` and the context menu); new
`app/components/page-sections/drive/ShareDriveModal.tsx` + atom in
`app/lib/global-atoms/sharesAtoms.ts`; mount at `app/(pages)/layout.tsx:34`;
new `SharedWithMeSection` in both `MultiFolderSyncManager` and `DriveOnboarding`;
`app/lib/tauri/sharedDrives.ts` IPC wrappers.

**Steps:**
1. "Share drive…" menu item (own drives only — hidden for member rows) → singleton
   atom → `ShareDriveModal`: mirrors `ShareFileModal`'s `choosing | running | done |
   error` machine (`ShareFileModal.tsx:64-75`) with an added **Members** tab (list +
   remove + active invites + revoke; SharesPageClient-style table). Done state
   auto-copies the invite URL (`:248-262` pattern).
2. Member surface: "Shared with me" list fed by `list_my_drive_memberships`
   (feature-flag + `SharedDrivesUnavailable`-tolerant), each row: owner badge
   (truncated ss58 + identicon, the `boring-avatars` pattern), display label, "Sync
   locally" → folder picker (last-browse-dir helpers, `userPreferencesDb.ts`) →
   `add_shared_drive`; synced member rows appear in the normal drive lists with the
   owner badge and WITHOUT owner-only menu items (Share drive, Delete from Server,
   Exclusions); "Leave" replaces "Remove from Sync" wording (calls
   `leave_shared_drive`).
3. No tray work (recon: the per-drive tray submenu no longer exists,
   `useTraySync.ts:112-116`).
4. Vitest: menu-item gating (own vs member rows), the modal state machine, the
   memberships list states (loading/empty/unavailable), flag-off renders nothing.
   Follow the pure-resolver-in-a-file convention (`sidebarSearchState.ts` precedent).
5. Commit(s): `feat(ui): share-drive modal + shared-with-me surfaces` (behind flag).

## Task 7: two-account live e2e + docs

**Files:** new `src-tauri/tests/shared_drives_real_backend.rs` (`#[ignore]` live-lane,
`folder_entries_real_backend.rs` conventions: `HCFS_DESKTOP_E2E_SERVER_URL` +
per-account bearers); CLAUDE.md.

**Steps:**
1. E2e (two in-process drive instances, real server with the feature env ON): owner
   mints → member accepts (direct HTTP accept with a sealed grant) → member
   `add_shared_drive` → file round-trips BOTH directions → owner removes member →
   member's next cycle surfaces the revoked marker → local files intact.
2. CLAUDE.md: a "Shared drives" key-pattern section (resolver, the three land mines,
   the grant-blob contract pointer, the v1 scope cuts) — the repo rule is that
   behavior changes update CLAUDE.md.
3. Commit: `test(shared-drives): two-account live-lane e2e + docs`.

## Task 8: full verification + PR

1. `pnpm lint`, `pnpm test`, `cd src-tauri && SQLX_OFFLINE=true cargo build`,
   `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test`,
   `cargo fmt --all --check`.
2. Re-read the diff against the three land mines + the cross-client contract.
3. PR to `staging` (repo flow), title `feat: shared drives — desktop (phase 2)`,
   description disclosing: flag off by default, v1 scope cuts (no folder-entity
   materialization on member drives, no member migration/shares), the grant-blob
   contract Phase 3 must mirror, self-leave always sends `?owner=`.
4. Adversarial review pass before requesting merge (house rule).
