# Sharing a Folder Outside a Drive — Design

**Status:** approved design, not yet implemented.
**Repos:** hcfs (server + client), hippius-console, hippius-desktop.

## Problem

Finder's "Share with Hippius" on a folder outside every synced drive (e.g.
`~/Downloads/T2-KD`) is refused with "Only folders inside a synced Hippius drive
can be shared as a link." The refusal dates from the browsable folder-share work
(`5db9d70f`, 2026-08-24): live folder links read a drive's server-side file
records, and an outside folder has none. The zip upload that used to cover the
case was deleted with it.

## Goal

An outside folder shares exactly like an in-drive folder link — same recipient
page (browse, search, filters, thumbnails, Download folder), public or password
link, expiry presets, revoke, change expiry, one row in Shared links, works from
the owner's other devices — while its contents are uploaded the way an outside
*file* share is: under the link's own key, never into a drive, never visible in
the user's drive, and deleted when the link expires or is revoked.

## Non-goals

- Live updates. The link is a copy taken at share time; changes to the local
  folder do not reach the recipient. Re-sharing makes a new link.
- Resuming an interrupted upload. A failed share is redone from the start.
- An "update this link" action.

## Core idea

A new *source* for a live folder link instead of a new kind of file share, so
everything already built on folder links keeps working.

- `folder_shares.source`: `drive` (today) or `upload` (new).
- `folder_share_files`: an `upload` link's own entries — owning token hash
  (cascade delete), relative path, size, uploaded_at, storage location / chunk
  list, and a kind (`file` | `dir`, so empty sub-folders survive).
- Recipient routes `/v1/folder-shares/{token}/meta|browse|blob` keep their
  paths and wire shapes; when `source = upload` they read `folder_share_files`
  instead of the drive's `file_records`. Search and filters run over the same
  columns.
- Encryption: a fresh random 32-byte key per link in `#k=`; every file is
  encrypted with it in the drive framing the recipient page already decrypts.
  The `#p=` password wrap is unchanged.
- Link shape stays `/share/folder/{token}`.

Names inside the shared folder are stored readable on the server, as they are
for drive-backed folder links today; contents are encrypted.

## Upload flow (desktop)

1. **Scan** the folder with the drive-upload skip rules (dot-names, symlinks);
   keep empty sub-folders; total bytes and file count. Refuse an empty folder
   and a folder over **50,000 files**.
2. **Gate** with `require_eligible(Sharing, total_bytes)` → `/can_upload`;
   refusal is the existing `NotReady(StorageLimitReached)` → plans dialog.
3. **Open** `POST /v1/folder-shares/uploads` with display name, file count,
   total bytes, and the empty sub-folders. The row is `uploading`: recipients
   get 404 and it is absent from the owner listing.
4. **Upload** each file encrypted under the link key through per-file
   init/chunk/complete routes scoped to the link, reusing the file-share chunk
   machinery (8 MiB chunks, 5 GiB per file, quota hold). Four files in flight.
   A file whose size changes or that disappears mid-upload fails the share,
   naming the file.
5. **Seal** `POST …/complete`: the server checks every declared file arrived,
   marks the link live, and sets `expires_at = now + ttl` — the expiry is
   anchored at seal, not at open, so a slow upload does not shorten the link.
   The desktop then pushes the `owner_wrap` and returns the link.

**Progress:** the existing Finder share modal and `ShareProgress` channel;
bytes summed across files into Encrypting/Uploading, then Finalizing at seal.
The chooser shows the folder's total size (null for folders today).

**Cancel / failure:** cancel aborts with `DELETE` on the uploading link. A
crash or network loss is collected by the reaper once the link has seen no
activity for 60 minutes (`last_activity_at`, bumped per chunk) — the
file-share rule of 60 minutes from init would kill a large folder mid-upload.

## Lifecycle, owner side, billing

- Listing, `PATCH` expiry, revoke (including by-hash routes) and cross-device
  copy work unchanged on `folder_shares` rows. Rows carry `source` so the
  desktop and console label them "Uploaded copy".
- **Revoke:** recipients cut off immediately; the reaper deletes the files on
  its next sweep (≤ ~5 min).
- **Expiry:** the reaper deletes the row and every file.
- **Never-expiring:** files stay until revoked, as with a never-expiring file
  share.
- **Billing:** uploaded bytes count against the Drive quota rail while the link
  lives and are released when the reaper removes them.
- **Server invariants:** files can only be added to a link that is `uploading`
  and owned by the caller; never after seal; the reaper only deletes files of
  the dead link.

## Changes per repo (rollout order)

### 1. hcfs — server and client, behind capability `upload_folder_shares`

- Migration: `folder_shares.source` (default `drive`), `upload_state`,
  `last_activity_at`; `folder_hash` / `path_prefix` nullable only when
  `source = upload` (CHECK); new `folder_share_files`.
- Routes: open, per-file init/chunk/complete, seal, abort. `meta`/`browse`/
  `blob` dispatch on `source`.
- Reaper: claim dead and idle-uploading `upload` links; delete their storage;
  release billing.
- Client: `create_upload_folder_share(entries, options, keystore, progress)`
  reusing the folder-share URL builders and `CreatedFolderShare`.
- Tests: uploading → 404; seal refuses missing files; no add after seal;
  owner-only; reaper deletes storage on revoke, expiry and abandonment and
  releases usage; browse/search/blob over `upload`; client↔server e2e.

### 2. hippius-console

- Recipient page: expected unchanged. Prove it with an e2e over an `upload`
  link (browse, search, thumbnails, Download folder, password link).
- Shares page: "Uploaded copy" label from `source`.

### 3. hippius-desktop — staging → beta → main

- Bump the hcfs pin; run the live e2e lane before merging the bump.
- `finder_bridge/dispatch.rs`: an outside folder routes to a new Rust
  `share_outside_folder` (scan, gate, upload with summed progress, cancel,
  seal, owner wrap). Without the capability, keep a refusal worded "isn't
  available yet".
- Frontend: shared-link rows read `source` for the label; no logic in TS.
- Tests: scan unit tests (skip rules, empty dirs, 50,000 cap, empty folder);
  progress summing; Finder routing pin; `tests/shares_server_mock.rs` cases for
  upload, seal, cancel, quota refusal; wire-contract pin for the new hcfs type;
  FE label test.
- CHANGELOG: "Share any folder from Finder as a link, even one outside your
  Hippius drives. The copy is removed when the link expires."
