---
paths:
  - "src-tauri/src/shares/**"
  - "src-tauri/src/shared_drives/**"
  - "src-tauri/src/sync/drive/identity.rs"
  # The four land mines live in sync/, not shares/ — these files must carry
  # the member-drive rules with them.
  - "src-tauri/src/sync/shared/mnemonic.rs"
  - "src-tauri/src/sync/drive/lifecycle.rs"
  - "src-tauri/src/sync/drive/config.rs"
  - "src-tauri/src/sync/fileops/remote.rs"
  - "src-tauri/src/sync/fileops/folders.rs"
  - "src-tauri/src/sync/fileops/recent_uploads.rs"
  - "src-tauri/src/sync/migrate/**"
  - "src-tauri/src/sync/projection/tauri_bridge.rs"
  - "app/lib/tauri/sharedDrives.ts"
  - "app/components/**/*hare*"
---

# File shares, folder shares, and shared drives

`shares/commands.rs` (share/unshare, link generation) emits `ShareProgress`/`SharePhase` to the FE (both pinned in `tests/hcfs_contract.rs`).

**Every channel mints share links at `console.hippius.com`.** There is no per-channel origin: staging used to default to `console.hippicode.com`, which made the console the ONLY behaviour differing between lanes while every backend the app talks to (`api.hippius.com` in `api/client.rs`, `auth/service.rs`, `auth/oauth.rs`; the HCFS server const) is identical on all of them — so the staging console was a different front end onto the same data, and the split bought only a link a recipient could not open from a production session. Pinned by `every_channel_mints_production_links_by_default`, which exists because deleting a branch is the kind of change a later reader "restores" on seeing a `channel` parameter that no longer selects anything.

The `HIPPIUS_CONSOLE_BASE_URL` runtime override is honored in dev builds and **staging** builds only — production and beta RELEASE binaries always mint prod links, so a stray line in a bundled `.env` can never repoint them. Beta sits with production, not staging: it is a public lane shipped to real users. The compile-time channel itself now lives in `src-tauri/src/release_channel.rs` (`crate::release_channel::current()`), not in this module — it gained consumers beyond the console.

## Shared drives (cross-account member drives)

An owner invites another account into ONE drive via a link; the member syncs it locally as a first-class drive that lives in the OWNER's server namespace. Server half = hcfs PR #348 (`drive_members`/`drive_invites`, all routes dark unless the server runs `HCFS_FEATURE_SHARED_DRIVES=1`); desktop plan `docs/plans/2026-08-20-shared-drives-phase2-desktop.md`; UI dark behind `SHARED_DRIVES_ENABLED = false` (`app/lib/featureFlags.ts`). Backend module `src-tauri/src/shared_drives/` (grant crypto + invite/membership IPCs), resolver `src-tauri/src/sync/drive/identity.rs`.

### DriveIdentity resolver — the local label is decoupled from the wire identity

`sync::identity::resolve_drive_identity(pool, account_id, label)` is the single label→wire funnel:

- both `sync_paths.owner_ss58`/`wire_folder_hash` NULL = own drive, resolving to `(account_id, folder_hash(label), false)` — byte-identical to what every pre-shared-drives site derived inline, so existing paths are unchanged by construction;
- both set = member drive resolving to the OWNER's pair with `is_member=true`;
- exactly one set (or malformed) fails CLOSED as `AppError::Db(Decode)` — syncing under a half-resolved identity could address the wrong namespace.

**Call discipline**: resolve ONCE at the top of an operation's funnel (`initialize_sync_inner` does, right after `load_sync_config`) and thread the value down — two resolves in one operation can observe different rows across a concurrent remove/re-add. `resolve_drive_identity_or_own` is the LENIENT variant for the remote-browse IPCs (`sync::remote`) only, whose label may legitimately name a server-only folder with no local row; funnels that require the row must use the strict form. `member_row_for_wire_identity` is the reverse lookup (wire pair → local slot, oldest row wins) backing `add_shared_drive`'s idempotency and the `syncedLocally` projection.

ALL engine configs flow through `build_hcfs_config(server_url, bearer, &DriveIdentity)` (`sync/drive/config.rs`) — it sets `ss58_address`/`folder_hash`/`shared_drive_member` from the identity. Structurally-own sites (account-scoped clients, migration pseudo-drive, jobs gated off for members) construct `DriveIdentity::own` with a comment saying why the resolver isn't needed.

### The four land mines

Each is a data-loss bug if a refactor drops its guard.

1. `ensure_derived_mnemonic` (`sync/shared/mnemonic.rs`) compares a folder seal against `derive(local master, label)` and REWRITES it on mismatch — a member's seal holds the OWNER's folder mnemonic by design, so the init funnel skips it for members, and both self-heal paths (`recover_drive`, uninitialized-dir fresh init in `lifecycle.rs`) refuse members with the visible `member_drive_unrepairable` Validation error instead of installing wrong key material.
2. The init `user_id` assert expects the OWNER composite `{wire_ss58}_{wire_folder_hash}` for members.
3. ~12 sites used `folder_hash(local_label)` as the wire hash (remote.rs, folders.rs, recent_uploads.rs, backfills, migration.rs) — a member's local label CANNOT derive the wire hash, so every drive-scoped site routes through the resolver (wiring pinned in `tests/shared_drive_wiring.rs`).
4. Password rotation (`reencrypt_all_folder_mnemonics`) rewrites OWN-drive seals only (member columns NULL in its query) — it re-derives from the local master, which for a member drive would clobber the owner's key.

KNOWN GAP: after a rotation the member seal is stranded under the OLD drive password, so the drive's next init fails unlock and surfaces the unrepairable error — recovery is remove + re-add from "Shared with me" (the grant re-seals under the current password). Rotating member seals in place is the tracked follow-up.

### Grant-blob cross-client contract

`shared_drives/grant.rs` is NORMATIVE:

- passphrase = `hex(HKDF-SHA256(bip39_seed(member_master)[..64], salt=member_ss58, info="hippius-drive-grant-v1"))`
- sealing = `hcfs_client::mnemonic_blob::seal_mnemonic` (Argon2id + XChaCha20-Poly1305) with the MEMBER's ss58 as AAD
- sealed payload = the owner folder-mnemonic PHRASE while the API surface exchanges the 32-byte ENTROPY
- wire form = SealedBlob JSON bytes base64 PADDED standard
- invite fragment = `#k=<base64url no-pad entropy>`

Phase 3 console must copy the KAT vectors verbatim (`grant_passphrase_is_pinned`, `open_grant_frozen_blob_is_pinned` — the frozen blob is the cross-rev data-loss guard). Argon2id is ~1.5s: callers on the runtime MUST `spawn_blocking` seal/open (the `recovery.rs::run_kdf` pattern).

The invite URL is assembled IN RUST (`create_drive_invite`): token + entropy exist nowhere else — not in logs (no-secret-log pin in `tests/shared_drive_wiring.rs`), not in another IPC. Invite policy defaults (7d / 50 uses) live in Rust (`resolve_invite_policy`); `http_create_invite` takes non-Option values so no call path can send an omitted field. The FE expiry presets (`shareDriveModalState.ts::INVITE_TTL_OPTIONS`) include "Never expires", sent as the hcfs server's 100-year lifetime cap (`NEVER_EXPIRES_SECS` = 100\*365\*24\*3600 — it must equal the server's `MAX_EXPIRES_SECS` exactly, or the preset 400s at mint time); an OMITTED lifetime still resolves to the finite 7-day default.

There is NO invite listing/revoke surface in v1 (server stores only token hashes; the desktop never persists minted tokens) — owners revoke access by removing members. `leave_shared_drive` ALWAYS sends `?owner=` (the bare server fallback deletes ALL same-hash memberships) and proceeds to local removal on a domain 404 (owner removed us first). Feature-off servers answer a bare 404 on these routes, mapped by `classify_error_status` to `NotReady(SharedDrivesUnavailable)` so the FE hides the surface instead of erroring.

### Member init skips

All inside `initialize_sync_inner`, gated on `identity.is_member`, each with an intent comment: the credits pre-gate (the OWNER pays; the server 402 stays the backstop — `add_shared_drive` has no eligibility gate for the same reason), `ensure_derived_mnemonic` (land mine 1), `spawn_folder_registration` (server rejects a member registering the owner's folder), `spawn_default_recovery_binding`, and both backfills — which STAMP their flags rather than merely skipping, so the per-cycle folder-entity sync (gated on the backfill flag) needs its OWN member gate; that gate is load-bearing, not belt-and-suspenders. Pinned by `tests/shared_drive_wiring.rs` (guard-site counts) and the mock-server suite `tests/shared_drive_server_mock.rs`.

### Revocation

hcfs-client substitutes `SHARED_DRIVE_REVOKED_MARKER` (re-exported in `sync/projection/events.rs` with a wording drift guard) into the `SyncError` event when a member drive is confirmed gone from a successfully fetched listing.

Desktop routing: `classify_sync_error` (`tauri_bridge.rs`) checks the marker BEFORE the `error_notify` gating → `handle_shared_drive_revoked` → the `revoked_notify` latch (threshold 1 — revocation is definitive, not flaky; the latch exists because the engine re-emits the error every retry cycle) fires ONE persisted "Sync Failed" notification + `teardown_revoked_drive`, which suspends via the SAME `suspend_drive_inmemory` funnel as `pause_drive` but writes NO `is_paused` (the drive is dead, not paused) and emits `DriveStatus::Error { "Access to this shared drive was removed" }`. FE: the third `DriveStatus` state renders through the shared `driveRowStatus.ts` resolver — an error row with a Remove affordance. The latch is in-memory, so ONE re-notify per launch is deliberate, and a brief Active→Error flap on relaunch is expected, not a bug: init succeeds from the local seal, then the first cycle re-detects the revocation.

**The marker fires on both real revocation shapes** (hcfs PR #349, pin `ab4b5cd`): hcfs-client's `check_and_recover_remote_folder` runs a **two-stage arbiter** for member drives — stage 1, the owner-scoped `/list_folders/{owner}`, catches drive DELETION (the dangling membership row still authorizes the listing, which 200s WITHOUT the folder) and multi-membership removal; stage 2, consulted only when the listing itself comes back forbidden-shaped, fetches `GET /v1/drive-memberships` with the MEMBER's own bearer (never 403s a live account) and confirms revocation on a 200 without the `(owner_ss58, folder_hash)` row — the single-membership removal topology, where the listing gate answers the same uniform 403 and cannot arbitrate. Fail-closed both ways: a 403 alone never confirms (a membership-DB outage yields the same 403), and any stage-2 fetch failure stays transient with the ORIGINAL error. The live e2e's two assertions REQUIRE marker equality, so an arbiter regression fails the live lane. Either way the member's local files are never touched.

### UI

`SHARED_DRIVES_ENABLED` gates only the ADDITIVE surfaces — the "Share drive" menu item + `ShareDriveModal` (invite mint + members tab), the "Shared with me" sections, the owner badge.

**Member-row menu gating is deliberately NOT flag-keyed**: `resolveFolderMenuPlan` keys on the row's `ownerSs58` data alone, so a post-release flag rollback can never restore "Delete from Server" (wrong wire identity) or a plain Remove (leaves a live membership) on an existing member row; `leave_shared_drive` stays wired unconditionally. IPC wrappers in `app/lib/tauri/sharedDrives.ts`.

### v1 scope cuts

Deliberate, documented where they bite: no folder-entity materialization on member drives (empty folders from the owner don't appear on member devices; files sync fully), no member migration/share-links/selective-sync-exclusions surfaces (server rejects member share creation anyway), membership fetch is FE-on-demand — never wired into `restore_session` (the login path's hang-proof timeout discipline is not risked for a listing) — and the files-page stats join leaves member rows blank.

**Caution**: `recent_uploads.rs`'s `hash_to_drive` map still keys drives by the label-derived hash — safe ONLY because member drives are excluded from the search surfaces in v1. If member drives ever reach search/recent-uploads, that map must move to the identity columns or member hits will mis-join.

## Folder share via link (live browsable)

A folder inside a synced drive is shared as a LIVE link, not an artifact. One metadata POST against the server's `/v1/folder-shares` mints a token scoped to `(folder_hash, path_prefix)`, and the recipient browses the folder's CURRENT contents — and downloads files — through the console's `/share/folder/{token}` page: the drive's existing ciphertext streams to them, nothing is packed or uploaded, so minting is instant regardless of folder size and later changes DO appear in the link. The URL fragment carries the drive's DERIVED file key (`#k=`, or `#p=` password-wrapped), so the server still never sees plaintext. This replaced the zip-snapshot pipeline (`zip_dir.rs`, preflight, settled-folder guard — all deleted); `FolderSettlement` survives only for folder RENAME.

### Mint funnel

`shares/commands.rs::create_folder_share_inner`. EVERY gate lives in the inner funnel, not the IPC — the macOS Finder right-click (`finder_bridge/dispatch.rs`) calls it directly, the same lesson the zip pipeline learned.

Gates: `require_folder_shares_supported` (the IPC's own authority, independent of the FE gate), owner-only (a member drive is refused with a modal-ready message — the server is owner-mint-only in v1, and a member's derived key would be wrong anyway), and `folder_share_path_prefix` (mirrors `resolve_inside_sync_root`'s component rules WITHOUT touching disk — the mint is metadata-only, so a cloud-only folder is shareable; `""` shares the whole drive).

Two zip-era guards are deliberately ABSENT: no settlement check (the recipient browses the SERVER's state, so a half-synced local copy cannot corrupt the share) and no billing-eligibility gate (nothing is uploaded).

The file key comes from the canonical `sync::remote::encryption_key_for_label` chain, and the client must be DRIVE-scoped (`sync::remote::build_client`) — the share flow's account-scoped label-less client is refused with `MissingFolderHash` because `create_folder_share` sends the folder hash from the client CONFIG. An OUTSIDE-drive folder from Finder is refused ("Only folders inside a synced Hippius drive…"). The create-path 404 `folder_not_found` slug maps to a "let it finish a sync" `Validation`, discriminated from a bare 404 (feature-off server).

### Capability gate

`ServerCapabilities.folder_shares` (`shares/capabilities.rs`; struct-level `#[serde(default)]`, so a pre-folder-shares server that omits the field reads as `false`, never a parse error). The FE mirror is `folderShareFeatureEnabledAtom` — unlike file shares this is NOT hard-coded on: `canShareFolder` (`folderShareGating.ts`) renders the folder "Share via link" items disabled-with-tooltip until the capability is confirmed, and both folder-listing queries are `enabled:`-gated on it so an old server sees no traffic.

### Owner ops

`hcfs_list_folder_shares` / `hcfs_revoke_folder_share` / `hcfs_update_folder_share_expiry`, account-scoped client. The listing returns `token_hash` (blake3 hex) per row — a folder-share token is never echoed after create. Rows are resolved against the PERSISTENT SQLite keystore (`SqliteShareKeystore::all_entries` scanned through `folder_share_token_hash`): a row minted on THIS machine comes back `resolvable` with the plaintext token (the handle revoke/expiry take) and the URL rebuilt by `build_folder_share_url_for`, which dispatches on the stored `ShareSecret` — a password share can never rebuild a password-free `#k=` link. Rows minted elsewhere are view-only.

Unlike the file listing, revoked and expired rows ARE present until the server's reaper sweeps them; the FE renders the dead state from the row (`shareRowDisplay.ts::folderShareRowPlan` — Copy suppressed on dead rows even when locally resolvable, expiry presets withheld on EXPIRED rows because the server's PATCH 404s them while Revoke stays offered, revoke/expiry disabled with honest tooltips on foreign rows).

Revoke maps the server's bodiless 404 to `Ok(())` plus a local keystore forget — but the forget is gated behind a `require_folder_shares_supported` probe first: a server ROLLBACK to a build without `/v1/folder-shares` 404s the route itself, and forgetting on that would delete the only plaintext copy of a token that still guards a live share once the server rolls forward (wiring-pinned in `tests/folder_share_wiring.rs`). With the probe passing, double-tap is idempotent and a token revoked from another device stops resolving here. A foreign row's `isPrivate` is `null` (protection unknown on this device — never a fabricated "public"), and the badge tooltip drops the public/private wording for it.

### Badges key on the LISTING, never `share_origin`

The folder mint deliberately records NO `share_origin` row — the file-share prune in `hcfs_list_shares` would evict it on the next refresh. The per-folder "Shared" badge instead derives the share's server-side identity itself: `useFolderShareBadge` (`app/lib/hooks/useFolderShares.ts`) indexes the listing by `(folderHash, pathPrefix)` — revoked rows dropped at index build, expired rows at lookup time (expiry is clock-dependent, the index is cached) — and the folder row computes the same pair via `driveFolderHash(label)` (WebCrypto SHA-256 first 16 hex chars, pinned byte-for-byte to `hcfs_client::drive::keys::folder_hash`) plus the SAME `folderShareRelativePath` resolution the mint uses, so nested rows badge correctly. A whole-drive share does not badge subfolders. Legacy zip-era folder links were FILE shares of an archive with an origin row, so `SharedLinkBadge.tsx` still consults the file index too until those age out.

### No `shared_link_history` for folder shares

`history::diff_active_lists` detects death by DISAPPEARANCE between consecutive active lists, and the folder listing retains dead rows until reap — a row would only "disappear" at reap time, recording a bogus end moment. The dead state lives on the listing row instead, and the `/shares` history card says so.

### Log redaction

The share commands log `share_token = %…` tracing fields, and `\btoken\b` can never fire inside `share_token` (`_` is a word character) — `utils/logs.rs` carries a dedicated `share[_-]?token` alternative for exactly that field. `token_hash` stays deliberately loggable: it is the server's own correlation handle, never the capability.

### Frontend

The mint has NO progress channel — `createFolderShare` is one POST, and `ShareFileModal` shows `MintingBody` (a plain spinner) rather than a progress bar that would imply work that isn't happening; the modal's notice states the link is live. The `/shares` page merges file and folder rows newest-first (`mergeActiveShareRows`), folder rows showing "Folder" in the size column (a live share has no fixed size).

Path resolution is unchanged from the zip era: the share atom carries `ShareModalTarget {file, relativePath}` resolved by the surface that OPENS the modal, never derived inside it — a nested folder row's `actualFileName` is only the BASENAME (the containing path lives in `parentRelativePath`, or in the table's `currentSubfolderPath`), so deriving it in the modal would mint a link for a different folder of the same name at the drive root. `folderShareGating.ts` owns the rule: `shareTargetFor` plus `canShareFolder`/`FOLDER_SHARE_DISABLED_TOOLTIP`; FOUR surfaces open the modal — the files-table 3-dot menu, card view, the right-click `FileContextMenu`, and `FileViewerLayout` — and all four must pass their own base path.
