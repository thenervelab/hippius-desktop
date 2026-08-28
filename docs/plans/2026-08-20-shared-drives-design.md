# Shared Drives — cross-account team drives (design)

Date: 2026-08-20
Status: validated design, not yet scheduled
Repos touched: hcfs (server + client), hippius-desktop, hippius-console

## Summary

A drive owned by account A can be joined by co-workers on other accounts via an
invite link. Members get full read-write access and sync the drive locally with
the normal engine, exactly like a second device of the owner. Content stays
end-to-end encrypted; the server never sees a usable key. Storage bills to the
owner. Removal is server-side denial (no key rotation).

## Product decisions (locked)

1. **Access model**: full read-write team drive (any member adds/edits/deletes).
2. **Invite model**: invite link, instant join on open (Slack-invite style).
3. **Revocation**: server-side denial only. The removed member technically still
   holds the old key but can no longer fetch anything with it. No re-encryption.
4. **Billing**: the owner's credits pay for everything, including member uploads.
5. **Member UX**: full local sync from v1 — the drive is a real folder on the
   member's machine, driven by hcfs-client.
6. **Key persistence**: fragment key in the invite link + wrap-to-self grant
   (Option A below). Owner-wrapped, address-directed grants are the v2 upgrade.

## Research findings that make this cheap

Three read-only research passes (hcfs-server, hcfs-client, hippius-console)
established the following. File references are as of 2026-08-20.

### hcfs-client: the engine is already identity-agnostic

- `Drive` has no concept of "my account". Identity is three independent
  caller-supplied inputs — `ss58_address`, `folder_hash` (both plain strings on
  `HcfsClientConfig`, `client/config.rs:37,40`), and whatever mnemonic sits in
  `enc_mnemonic.json` — plus a separately-settable bearer token. Nothing
  cross-checks them. `init(password, Some(mnemonic))` seals ANY valid BIP-39
  phrase (`drive/init.rs:110-175`).
- A member drive is therefore: **owner's ss58 + owner's folder_hash + owner's
  folder mnemonic + the member's bearer token.** No engine change needed to run
  one.
- Multi-writer already works: it is exactly the existing multi-device flow
  (mutation_seq probe → `fetch_remote_state` → three-tree `SyncPlan` diff → OCC
  with `base_revision_id`, 409 → conflict resolver). Nothing records or verifies
  who wrote a file; the Ed25519 request signatures verify against a key carried
  in the same request (ToS attestations, not ownership proofs).
- The signing/encryption keys derive from the FOLDER mnemonic (`drive/init.rs:
  74-99`), never from the master, so handing a member the folder mnemonic
  reveals nothing about the owner's other drives or master key.

### hcfs-server: one string comparison is the entire blocker

- Every sync-relevant endpoint already takes `(owner_ss58, folder_hash)`
  explicitly in the path or body, then asserts equality with the token identity
  (`auth.rs:287` in `validate_and_authorize`, plus siblings). Relaxing that
  assertion through a membership lookup is the whole authorization change.
- Precedent exists: `recovery_bindings` (account-level cross-account READ
  grants, fail-closed, feature-gated) is the accepted pattern to mirror.
- Billing needs zero changes: writes are stamped with the owner's composite key
  (`{owner_ss58}_{folder_hash}` = `file_records.user_id`), so member uploads
  automatically bill and chain-report to the owner (`handlers/helpers.rs:
  115-200`; chain-reporter `identify.rs:41-58` folds composites to the owner).
- Storage, chunk addressing, and path hashing carry no user component.

### hippius-console: mechanical changes, no crypto blocker

- OAuth users are NOT keyless in the browser: both OAuth and mnemonic users
  unlock the same server-custodied sealed mnemonic blob (`ConsoleUnlockModal`,
  `open_mnemonic_blob`), after which the master mnemonic lives in a
  never-persisted jotai atom. The WASM (`@hippius/hcfs-client-wasm`) accepts an
  arbitrary 32-byte key via `SecretBytes`, so an externally-delivered drive key
  drives the whole existing browse/upload/download pipeline.
- ~a dozen call sites pass `oauthSession.substrateAddress` and must switch to
  the drive OWNER's ss58 (`useHcfsBrowse`, `useSearchFiles`, `decrypt-file.ts`,
  `hcfs-upload.ts`, delete/create hooks).
- Pre-existing latent bug this feature makes live: the per-drive file-key cache
  (`file-keys.ts`) is keyed by LABEL, not folder_hash — a label collision
  between an owned and a shared drive would silently reuse the wrong key.
  Must be re-keyed to folder_hash.

## Cross-repo invariants (each is a data-corrupting bug if violated)

1. **`salted_hash` is `blake3(ss58 || plaintext)` and the salt must be the
   OWNER's ss58 for every writer** (`hcfs-client/src/crypto.rs:439-460`;
   console `hcfs-upload.ts` mirrors it). A member salting with their own
   address makes every file mismatch on download (`HashMismatch`) and read as
   content-divergent in the sync plan. Desktop and console must agree
   byte-for-byte. Pin this in tests in both clients.
2. **The member's `/list_folders` view must include the shared drive** or the
   engine's cheap probe (`engine/round_listing.rs`) degrades every member drive
   to a full cycle each round — while NOT leaking the owner's other drives.
3. **An empty `folder_hash` membership row must be impossible**:
   `composite_key("", ss58)` collapses to the bare account namespace, which
   would grant the S3-gateway routes for the whole account. CHECK constraint +
   handler validation.
4. **The engine's folder-recovery path must be inert for member drives**
   (`engine/runner.rs:2876-2934`): on a listing miss it calls `register_folder`
   as the owner and deletes local sync state. For members it must become a
   read-only "drive gone / access revoked" signal.
5. **Stable identity forever**: `apply_identity` wipes all sync state if the
   stored `(ss58, folder_hash)` for a drive changes (`drive/sync_flow.rs:
   1473-1504`). Member drives must be configured with the owner pair from day
   one and never flipped to the local account.

## Design

### 1. Server data model

Three additions, following the `recovery_bindings` precedent, behind an
`HCFS_FEATURE_SHARED_DRIVES` env gate.

```sql
CREATE TABLE drive_members (
    owner_ss58   TEXT NOT NULL,
    folder_hash  TEXT NOT NULL CHECK (folder_hash <> ''),
    member_ss58  TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'writer',  -- v1 uses 'writer' only
    grant_blob   BYTEA,          -- drive key sealed under the MEMBER's master key
    invite_id    UUID,           -- provenance
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_ss58, folder_hash, member_ss58)
);
CREATE INDEX drive_members_member_idx ON drive_members (member_ss58);

CREATE TABLE drive_invites (
    invite_token_hash TEXT PRIMARY KEY,   -- hash only; a DB leak cannot rebuild links
    owner_ss58        TEXT NOT NULL,
    folder_hash       TEXT NOT NULL CHECK (folder_hash <> ''),
    expires_at        TIMESTAMPTZ NOT NULL,
    max_uses          INT NOT NULL,
    use_count         INT NOT NULL DEFAULT 0,
    revoked_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`grant_blob` lives on the membership row because it shares its lifecycle:
created at accept, deleted at removal. It is opaque ciphertext to the server —
the drive key sealed by the member's client under a key derived from the
member's own master mnemonic (reusing the Argon2id + XChaCha20-Poly1305
`mnemonic_blob` sealing, member ss58 as AAD).

New endpoints:
- `GET  /v1/drive-invites/{token}/meta` — anonymous peek (drive name, owner,
  validity). Same anonymous-proxy treatment as share meta.
- `POST /v1/drive-invites/{token}/accept` — bearer = joiner. Atomically checks
  expiry/uses/revocation, inserts membership, stores the grant blob. Idempotent
  for an existing member.
- Owner CRUD: create/revoke invites, list/remove members.
- `GET  /v1/drive-memberships` — member lists joined drives + grant blobs.

### 2. Server authorization

Two drive-aware functions replace the current pair at their ~19 call sites:

- `authorize_drive_write(headers, owner_ss58, folder_hash, store)` replaces
  `validate_and_authorize` at its 11 write sites. Owner fast path with no DB
  query; else `drive_members` lookup; fail-closed on any DB error (copy the
  `recovery_binding_grants_read` contract and tests).
- `authorize_drive_read(...)` extends `authorize_read_with_recovery` at its 8
  read sites, keeping the recovery-binding fallback.

Membership lookups get a TTL cache like `TOKEN_CACHE`; revocation latency is
bounded by the TTL (~60 s), consistent with server-side revoke.

Fiddly sites:
- The four upload-session endpoints authorize off the stored session row; the
  two SQL predicates (`split_part(user_id,'_',1) = caller`,
  `database.rs:2581,2618`) become `owner == caller OR EXISTS(drive_members …)`.
- `authorize_claimed_ss58` (multipart upload) becomes async with store access.
- Leak prevention: `list_folders/{owner}` filters to the member's drives;
  `search_files` REQUIRES `folder_hash` for non-owner callers;
  `get_file_type_summary` / `get_source_summary` gain drive scoping;
  `get_user_summary` (billing aggregate) stays owner-only.
- Kept owner-only in v1: `unregister_folder` (drive delete), migration
  endpoints, and share-link creation from a shared drive (explicitly rejected
  for members so a member-minted share billed to the member cannot happen by
  accident).

### 3. Key flow

**Mint (owner)**: desktop derives the folder mnemonic it already has
(`derive_folder_mnemonic(master, label)`), generates a random invite token,
registers the invite (token hash, expiry, max uses), and builds:

```
https://console.hippius.com/invite/<token>#k=<folder-mnemonic entropy, base64url>
```

The fragment never reaches a server. We ship the 32-byte entropy, not the
phrase; both sides reconstruct via `Mnemonic::from_entropy`.

**Accept (member)**: signed-in member opens the link → meta peek → Join:
1. read the fragment into memory and scrub it (`history.replaceState`) BEFORE
   any client-side navigation;
2. wrap the drive key under the member's own master-derived key (mnemonic_blob
   sealing, member ss58 AAD);
3. `POST .../accept` with the grant blob.

**Rehydration (any member device, any session)**: at login,
`GET /v1/drive-memberships` returns drives + grant blobs. After the member's
normal unlock, the client unwraps each blob. Desktop offers "sync locally";
console browses immediately. A member's new desktop install auto-discovers
shared drives with no link.

**Revocation**: delete the membership row → auth fails within cache TTL, grant
blob gone, no new device can rehydrate. The member's held key is inert without
server access.

### 4. hcfs-client changes

- `Drive::for_shared_drive(sync_path, cfg_dir, ForeignDriveIdentity {
  owner_ss58, folder_hash, folder_mnemonic, bearer_token })` — internally
  `init` + `set_config` + `unlock`, making the invariants explicit. Note
  `unlock` only defaults the bearer token when config left it empty
  (`init.rs:86-91`), so the member token survives.
- Folder-recovery guard (invariant 4) + an exposed "drive gone/revoked" signal.
- Each shared drive gets its OWN config dir (state files are config-dir scoped,
  not account scoped — no collision as long as dirs differ).

### 5. Desktop changes

- `sync_paths` gains `owner_ss58` and `origin` columns (NULL owner = own
  drive). Shared drives flow through the existing lifecycle
  (`initialize_sync_inner`, pause/resume, `DriveStatus`) with config built from
  the membership: `ss58_address` = OWNER's always (pin test), bearer = mine,
  folder mnemonic from the unwrapped grant blob sealed into the drive's own
  `enc_mnemonic.json`.
- Owner UI: "Share this drive…" in the per-drive 3-dot menus → invite-link
  modal (share-modal lifecycle reuse) + members list with remove/revoke.
- Member UI: memberships fetched at login; joined drives render with an owner
  badge, no owner-only actions (share creation, drive delete); "Sync locally"
  picks a folder and creates the drive. Local label collisions resolved via the
  existing `LabelMode::Allocate`.
- Credit gating: `require_eligible` checks MY balance — wrong for member
  uploads (owner pays). Member-drive uploads skip the local gate and rely on
  server `can_upload` (gains `folder_hash`) + the 402 path, surfaced as
  "the drive owner's credits are exhausted", scoped per-label so the member's
  own drives are untouched.

### 6. Console changes

- `/invite/[token]` cloned from `/share/[token]`. MANDATORY: extend
  `SHARE_ROUTE_RE` in `middleware.ts` so the route inherits the strict CSP +
  `Referrer-Policy: no-referrer`; scrub the fragment before navigation; extend
  the anonymous-proxy allow-list for the two invite endpoints only.
- Members page at `/dashboard/storage/drive/[folderHash]/members`, cloned from
  the Shares page.
- Files UI: `useHcfsFolders` merges owned + memberships; `FormattedHcfsFolder`
  gains `{ownerSs58, role, isShared}`; the ~dozen call sites switch to the
  owner's ss58 (query keys already include the ss58, so cache separation is
  free).
- Key handling: re-key the file-key cache on folder_hash (standalone bugfix,
  can land first); new `drive-keys.ts` for externally-supplied keys with the
  same borrow/deferred-free discipline; purge on lock/account-swap (file-key
  policy, NOT the share-key survives-lock policy).
- Check every new HTTP verb against the Next proxy's exported methods (only
  GET/DELETE/POST/PUT/PATCH exist; anything else 405s console-side only).

### 7. Edge cases

- **Revoked mid-sync**: 403s map to a terminal "access revoked" drive state
  (drive paused, local files kept — they are the user's copies), not the
  generic retry loop.
- **Owner deletes the drive**: probe sees it gone → same terminal state (the
  recovery-path guard prevents the wipe + phantom re-register).
- **Owner out of credits**: member gets 402 with owner-balance wording; the
  per-label `credits_exhausted` scoping keeps the member's own drives healthy.
- **Conflicts**: unchanged OCC + Review Changes flow. The server records no
  writer identity, so v1 cannot attribute "modified by X" — accepted.
- **Invite hygiene**: default expiry 7 days, finite max-uses (e.g. 50); accept
  is idempotent; revoked/expired/exhausted links land on a clean error page.
- **Self-invite**: no-op, route to the drive.
- **Removal cleanup**: removing a member deletes their active upload sessions
  against that drive.

### 8. Testing

- Server: fail-closed auth unit tests (recovery-binding contract copied);
  invite lifecycle integration (mint → accept → use → revoke → 403); the leak
  set (filtered list_folders, folder_hash-required search, owner-only
  summary); empty-folder_hash rejection; session SQL predicates.
- Client: two-`Drive` bidirectional sync test (different bearers, same folder
  mnemonic, owner's ss58); recovery-path-inert pin for member drives.
- Desktop: wire-contract pins for new IPC shapes (HCFS-bump-guard pattern);
  a pin that member configs always carry the owner's ss58; a live-lane
  `#[ignore]` two-account e2e (folder_entries_real_backend.rs style) with a
  mid-session revoke.
- Console: fragment parse/scrub units; folder_hash-keyed cache units; CSP
  assertions on the invite route.

### 9. Rollout sequencing (server first, strictly)

1. hcfs: schema + auth + invite endpoints behind `HCFS_FEATURE_SHARED_DRIVES`;
   client constructor + recovery guard (same or sibling PR).
2. Desktop: pin bump, membership fetch, owner/member UI, lifecycle wiring —
   behind a `featureFlags.ts` boolean.
3. Console: invite page, members page, ss58 swaps, key-cache re-key (the
   re-key can ship earlier as a standalone bugfix) — behind its own flag.
4. Flip gates.

## Deferred (explicitly out of v1)

- **Web-only newcomer join**: an invitee with no desktop setup has no sealed
  mnemonic blob and cannot unlock in the console; v1 shows "install the desktop
  app to finish joining". Closing it needs console-side first-run blob creation
  (`PUT /v1/mnemonic-blob`, which does not exist today). v1.1 candidate.
- **Address-directed invites** (owner wraps the key to a member's sr25519
  public key; no key in any link): the natural v2 on top of the same
  `drive_members` model.
- **Roles beyond writer** (reader/admin): the column exists; enforcement in
  data, not structurally — deliberately avoiding the recovery-binding shortcut
  where `scope` is stored but ignored.
- **Member-created share links from shared drives**: rejected in v1; needs an
  explicit billing decision first.
- **Cryptographic revocation / key rotation**: out of scope by product
  decision; would require per-file key generations.
