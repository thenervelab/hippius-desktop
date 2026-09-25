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

An owner invites another account into ONE drive via a link; the member syncs it locally as a first-class drive that lives in the OWNER's server namespace. Server half = hcfs PR #348 (`drive_members`/`drive_invites`, all routes dark unless the server runs `HCFS_FEATURE_SHARED_DRIVES=1`); desktop plan `docs/plans/2026-08-20-shared-drives-phase2-desktop.md`; UI gated on `SHARED_DRIVES_ENABLED` (`app/lib/featureFlags.ts`), which is `enabledFrom("beta")`: **off on production, on beta and staging**. The rules file previously claimed it was `true` on every lane; that was wrong. Console splits create vs use (`SHARED_DRIVES` on prod for members/invite accept, `SHARED_DRIVES_CREATE` off prod). Desktop still has one flag covering both mint and use; matching the console split is a follow-up if straightforward; do **not** silently enable create on production. A SECOND gate sits in front of it: the plan (see "Sharing needs Plus, Max or Scale" below). Backend module `src-tauri/src/shared_drives/` (grant crypto + invite/membership IPCs), resolver `src-tauri/src/sync/drive/identity.rs`.

### Sharing needs Plus, Max or Scale

Adding people (emailed invite, drive or folder link, Approve, Change folders) is on the
`duo` (Plus), `max` and `scale` plans; `free` and `solo` (Starter) are out. The rule lives
ONCE, in `billing/sharing_entitlement.rs`, and reaches the FE as `canShareDrives` on
`get_storage_overview`; `useSharedDrivesInPlan` only reads it (there is no TypeScript copy
of the codes). Unknown is permitted, never refused: an empty code (legacy card plan), a code
this build does not know, or a subscription read that failed all read `true` and leave it to
the server's 403 `shared_drives_not_entitled` (`classify_error_status` maps it to
`NotReady(SharedDrivesNotEntitled)`), because hiding a perk somebody paid for is worse than
a click the server answers with the same prompt. `get_storage_overview` records whether each
subscription read succeeded BEFORE its soft defaults, or a failed read would look like Free.

FE (`sharingGate` in `share-dialog/shareDialogState.ts`: `loading | allowed | upgrade`): the
Share dialog and Manage access still open on Free/Starter so an owner who downgraded can see
and remove people, cancel invitations and revoke links; every add-access control gives way to
`NotEntitledNotice` ("Sharing is available on Plus, Max and Scale plans.", "Upgrade plan" to
`BILLING_ROUTE`). While the plan loads, `SharingActionsSkeleton` holds their place so neither
the controls nor the card flash. A 403 from any sharing command (sections via
`onNotEntitled`, rows via `useRowChanges`' third argument) flips the host to the card. The
gate applies to a drive this account OWNS only; another owner's drive is decided by that
owner's plan. The folder-row "Share drive" menu item is deliberately NOT plan-gated
(discoverability). Pinned by the `sharing_entitlement` unit tests, `ShareDialog.test.tsx`,
`ShareDrivePanel.test.tsx` and `useSharedDrivesInPlan.test.ts`.

### DriveIdentity resolver — the local label is decoupled from the wire identity

`sync::identity::resolve_drive_identity(pool, account_id, label)` is the single label→wire funnel:

- both `sync_paths.owner_ss58`/`wire_folder_hash` NULL = own drive, resolving to `(account_id, folder_hash(label), false)` — byte-identical to what every pre-shared-drives site derived inline, so existing paths are unchanged by construction;
- both set = member drive resolving to the OWNER's pair with `is_member=true`;
- exactly one set (or malformed) fails CLOSED as `AppError::Db(Decode)` — syncing under a half-resolved identity could address the wrong namespace.

**Call discipline**: resolve ONCE at the top of an operation's funnel (`initialize_sync_inner` does, right after `load_sync_config`) and thread the value down — two resolves in one operation can observe different rows across a concurrent remove/re-add. `resolve_drive_identity_or_own` is the LENIENT variant for labels that may legitimately name a server-only drive with no local row: the remote-browse IPCs (`sync::remote`) and, since remote drives became browsable, the folder-share mint (`create_folder_share_inner` — the mint is metadata-only and its key chain derives from the master, so a local row was never actually required; a member ROW still resolves to member identity and is refused by the owner-only gate). Every other funnel that requires the row must use the strict form. Trade-off accepted at the mint: a stale/typo'd label no longer gets the client-side "Unknown sync folder label" refusal — it reaches the server and fails as `folder_not_found`. `member_row_for_wire_identity` is the reverse lookup (wire pair → local slot, oldest row wins) backing `add_shared_drive`'s idempotency and the `syncedLocally` projection.

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

### Two roles, and only the owner manages

The client offers Viewer (`reader`) and Editor (`writer`) only: `WIRE_ROLES` in
`shared_drives/commands.rs` and `DRIVE_ROLES` in `app/lib/shared-drives/roles.ts`. The server
still knows `manager`; this client never sends it. `require_offered_role` refuses it as
Validation "Viewer or Editor only." in the link mint, the emailed invite and the role change,
before the session or the network is touched, and the HTTP helpers refuse it again. A
`manager` the server still returns is an Editor for display AND permissions:
`drive_role_from_wire` maps it to `writer` in every listing (members, memberships, invites,
`fold_share_access`, `fold_access_panel`, `member_access_for`), so the webview never sees
it; `parseDriveRole` maps it to `writer` too, because its unknown-role rule (Viewer) would
take away upload.

Only a drive's OWNER changes access. Every access change (mint, email, approve, revoke,
remove a member, change a role, change folders, list invites) resolves through
`resolve_owned_target`, which refuses a drive this account does not own (`OWNER_ONLY`)
before any key is read or request made; naming this account as the owner is an own drive.
Reads a member may make (who has access, the panel, members, folder grants) go through
`resolve_access_target` and name the owner with `member_owner` (`?owner=`); a member's
Share dialog and panel never ask for invites. No write sends `?owner=` or `owner_ss58`.
`can_manage` (panel) and `canManageDrive` (FE) are owner only, whatever the member's role,
so a former Manager sees the read-only panel ("Shared with you by … · you are an Editor"),
Leave, and "Who has access" on the header mark. Editors keep their public folder links
(`create_member_folder_share`). Pinned by `access_changes_are_owner_only` and
`a_manager_role_is_refused_before_anything_else` in `tests/shared_drive_wiring.rs`,
`a_manager_role_is_refused_before_any_request` (mock server), and the `access_panel.rs`
and `roles.test.ts` tests.

The invite URL is assembled IN RUST (`create_drive_invite`): token + entropy exist nowhere else — not in logs (no-secret-log pin in `tests/shared_drive_wiring.rs`), not in another IPC. Invite policy defaults (7d / 50 uses) live in Rust (`resolve_invite_policy`); `http_create_invite` takes non-Option values so no call path can send an omitted field. The FE expiry presets (`shareDriveModalState.ts::INVITE_TTL_OPTIONS`) include "Never expires", sent as the hcfs server's 100-year lifetime cap (`NEVER_EXPIRES_SECS` = 100\*365\*24\*3600 — it must equal the server's `MAX_EXPIRES_SECS` exactly, or the preset 400s at mint time); an OMITTED lifetime still resolves to the finite 7-day default.

Invites are listed and revoked by id (`list_drive_invites` / `revoke_drive_invite`; the panel reads them through `list_access_panel`); the desktop never persists a minted token, and revoking a link is distinct from removing a member (the link still circulating vs. someone already in). **The drive list's badge comes from ONE IPC, `list_owned_drive_sharing`**, which fans out members + invites per own drive and folds them in Rust (`fold_drive_sharing`: a drive is omitted only when BOTH listings fail; unknown is not private). **The drive mark is whole-drive only**: `fold_drive_sharing` counts only invites with no `path_prefix`, and the server's `member_count` already excludes folder holders, so a drive where only a folder was shared carries no drive mark (it used to read "Invite sent"). **A folder shared on its own carries its own mark** from `list_owned_folder_sharing(label)` (owner-only via `resolve_own_drive`, asked ONLY for the drive being browsed, never fanned out over the drive list): `fold_folder_sharing` returns `{path, holderCount, hasInvite}` per folder with a grant on exactly that path (distinct holders) or any folder invite, live or spent; keys are trimmed + NFC on both sides (`folderSharingKey`). A nested grant marks its own row only (`Clients/ACME` marks ACME, never Clients), and whole-drive people stay on the drive mark, so nobody is counted twice. FE: `useOwnedFolderSharing` (skipped for member/browse labels and until the membership listing settles; empty while loading, so no wrong-mark flash), `FolderSharingMark` on the list row (`NameCell`) and the card (compact: icon + count), each with its own "Manage access" button beside the pill (a `role="button"` span, since both sit inside the row's `<a>`; clicks stop there; accessible name "Manage access for {folder}"; words only when the `@container` name cell is at least `22rem`, an icon below that and always on the card), `FolderSharingHeaderMark` beside the breadcrumb of an open shared folder, and a folder-row "Manage access" menu item; all open `shareDriveModalAtom` with the folder's `pathPrefix`. **Drive-level Manage access (header button, drive list row button) is for a drive shared as a whole only**: both gate on `isDriveShared` over the whole-drive counts, so a drive where only folders are shared offers "Share drive…" and no drive-level Manage access; its folders carry their own. Copy lives in `folderRowSharing.ts` ("Shared with N" / "Shared", tooltip "Shared on its own... The rest of the drive isn't."). `invalidateOwnedDriveSharing` refreshes both query keys. Pinned by `fold_counts_only_whole_drive_invites_on_the_drive`, the `folder_fold_*` tests, `shared_drive_wiring.rs`, and `FolderSharingMark.test.tsx`, `DriveSharingHeaderMark.test.tsx` and `FolderList.test.tsx`. The FE hook `useOwnedDriveSharing` is a TanStack query keyed on the sorted label set; every mint / revoke / remove / re-role calls `invalidateOwnedDriveSharing`. It was a hand-rolled effect whose deps included the labels array, so every drive-page re-render cancelled the fetch in flight and the badge never drew Do not put a per-render array in a fetch effect's deps. `leave_shared_drive` ALWAYS sends `?owner=` (the bare server fallback deletes ALL same-hash memberships) and proceeds to local removal on a domain 404 (owner removed us first). Feature-off servers answer a bare 404 on these routes, mapped by `classify_error_status` to `NotReady(SharedDrivesUnavailable)` so the FE hides the surface instead of erroring.

### Who pays, and who the server is asked about

Storage on a member drive is the OWNER's. Two consequences that are invisible
from the app when they are wrong:

- **The upload pre-flight names the DRIVE, not the caller.** `check_drive_quota_for`
  sends the owner's ss58 and the drive's wire folder hash for a member drive, which is
  what routes hcfs-server to the owner's allowance; an own drive sends the empty hash,
  keeping the server's membership fallback inert. Sending the empty hash unconditionally
  asked about the caller's plan, so a member whose own plan was full could not upload to
  a drive with room. The refusal reads as "my plan is full" whoever's plan it was, which
  is why nobody reports it. The upload commands therefore resolve their drive BEFORE the
  gate; that is the only order in which the gate can name it.
- `add_shared_drive` still has no member-side credit gate at all (the init funnel's member
  skip and the server 402 are the authorities).

### The folder key: one resolver, four sources

`remote::drive_key_material_for_label` is the ONLY place that answers "where does this
drive's key live": this account's master for an own drive, the owner-sealed
`enc_mnemonic.json` for a member drive synced here, this account's own grant for
one that was never synced, and (last) a FOLDER grant on the drive, which opens to the
derived file key only. It returns `DriveKeyMaterial::{Phrase, FileKey}`; `encryption_key()`
and `signing_key()` read both from the one value, and `into_phrase()` refuses a folder
grant holder by name, so a whole-drive invite can never carry a folder holder's key.
Uploads, renames, previews and the invite mint all take it from there.

Two rules it exists to hold, both of which failed while there were copies of it:

1. **The encryption key and the manifest SIGNING key come from the same phrase.** They were
   derived separately and only the encryption path had a member branch, so a file on a
   shared drive was encrypted with the owner's key and signed with one derived from the
   uploader's master. Nothing local fails when they disagree.
2. **It reads the drive password WITH the session mnemonic.** The mint's own copy passed
   `None`, so an encrypted password could not be opened and the mint failed outright.

It is derived ONCE per upload, never per file: the grant path is Argon2id, so per-file
derivation cost seconds apiece.

### The browse label

A drive browsed without being synced here carries its wire identity IN its label,
`shared:<owner>~<hash>` (`app/lib/shared-drives/sharedDriveLabel.ts`, mirrored by
`identity::shared_drive_browse_identity`; a test reads the TypeScript's own constants).
**No slash, deliberately**: the label passes through URL parameters and path joins that
split on `/`, and the first cut used `shared://owner/hash`, which came back mangled one
folder below the drive root, un-marked the view as remote, and silently dropped uploads
into the LOCAL flow.

`resolve_drive_identity_or_own` recognises it before the row lookup, so every label-keyed
path is addressed correctly without being threaded individually. That matters because the
fallback answers with THIS account's namespace, which is a wrong answer no error reports:
the write succeeds, in the wrong drive.

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

Deliberate, documented where they bite: no folder-entity materialization on member drives (empty folders from the owner don't appear on member devices; files sync fully), no member migration/selective-sync-exclusions surfaces (member FOLDER links are allowed for Editors, see "Member mint"), membership fetch is FE-on-demand, never wired into `restore_session` (the login path's hang-proof timeout discipline is not risked for a listing), and the files-page stats join leaves member rows blank.

**Caution**: `recent_uploads.rs`'s `hash_to_drive` map still keys drives by the label-derived hash — safe ONLY because member drives are excluded from the search surfaces in v1. If member drives ever reach search/recent-uploads, that map must move to the identity columns or member hits will mis-join.

### Folder roles (HCFS #475)

`shared_drives/folder_roles.rs` holds the WHOLE contract in its module doc (capabilities
`folder_grants` / `folder_grant_writes`, Viewer or Editor folder invites, the exact refusal
messages, no holder role change, what a writer holder may do). The hcfs pin is at #475's
merge, whose sync places a download at the path that hashes to its file id (the decrypted
path, else the server `relative_path`).

Replacing a holder's folders (`replace_folder_grants`, the panel's Change folders) can ADD
folders: `role` applies only to added folders, held ones keep theirs, and the response's
`roles` (same order as `path_prefixes`) is what was stored. "writer folder grants are not
enabled" maps to `FolderEditorInvitesUnavailable` (`classify_folder_grant_refusal`). A
grant's write controls key on `MyFolderGrantInfo.canWrite`, decided in Rust
(`grant_can_write`: Editor, `folder_grant_writes` on, not frozen), because a writer grant
cannot write while the flag is off. There is no remote delete on the desktop, for grant
holders or anyone else browsing a drive without syncing it.

**A folder share can never become a whole-drive invite.** A folder mints only through
`create_folder_invite` (path REQUIRED, planned by `plan_folder_invite` before any request;
the drive command takes no folder). No folder request, link or mail, is sent to a server
whose capabilities lack the `folder_grants` KEY (`folder_grants_known`): such a server
ignores `path_prefix` and would mint or mail a whole-drive invite. A mint that does not
echo the folder is revoked and refused. FE: the Share dialog treats `pathPrefix`'s PRESENCE as
"folder" and never calls the drive command for one; the manage panel's invite is always
whole-drive. Pinned by `a_folder_invite_can_never_go_out_as_a_drive_invite` and
`tests/shared_drive_folder_roles_mock.rs`.

**The Share dialog keeps the two invite kinds apart** (`drive/share-dialog/`, opened by
setting `shareDialogAtom`). Top to bottom: Invite people, People with access, General
access, Done. "Invite people" calls only `email_drive_invite` (the address checked as typed
by `check_invite_email`; the role and Send appear once the field has text); "General
access" calls only `create_drive_invite` / `create_folder_invite` and describes the result
from the `role` / `expiresInSecs` / `maxUses` the mint returns, which are what was SENT
after Rust's defaults and caps, and revokes it by the returned `inviteId`. One mixed form
let a typed address silently turn a link into an email invite. Refusals route on the
subkind to inline notices (`shareDialogState.ts::noticeForError`), never a toast. Each
success bumps `driveInvitesVersionAtom`, which reloads an open Manage access panel.

**People with access comes from one Rust fold, `list_share_access`** (`fold_share_access`):
owner, whole-drive members for a drive, holders of a grant AT OR ABOVE the folder for a
folder (`prefix_covers`, nearest grant wins), and live emailed invitations for exactly that
drive or folder. Role change, remove, cancel and approve are PESSIMISTIC: the row says
"Saving…" / "Removing…" until the command succeeds and the listing is read again, and a
refusal leaves the row as it was with "Couldn't change access for <name>. <reason>". A
demotion is confirmed first (the server revokes links as part of it). Six rows at most,
then "+ N more · Manage access" to the panel. Pinned by
`share-dialog/__tests__/ShareDialog.test.tsx` and the `fold_share_access` unit tests.

**Never a second dialog over the Share dialog or the panel** (the panel is itself a Radix
dialog below the desktop breakpoint). Remove, a demotion, Cancel invite, Revoke and Leave
ask IN THE ROW (`share-dialog/RowConfirm.tsx`; Leave in the panel footer): the row keeps
its avatar and name, swaps its subline for a short question ("Remove <name>'s access to
this drive?" / "...to this folder?", plus "They also lose any other folders on this drive
shared with them." only when they hold more than one) and its right side for the
destructive button and Cancel. The confirm button takes focus; Escape (caught on the window
in the capture phase, ahead of Radix's document listener, so it never closes the dialog)
or Cancel puts the row back and focus returns to the `ROW_TRIGGER` control. One
`RowConfirmProvider` per list (the panel has one for the rows and the footer), so only one
row asks at a time. Change folders (`access-panel/ChangeFoldersView.tsx`) is a view in
place of the panel's list, with Back, like a group's full view. The People column ends
flush right: `ROLE_SLOT` is `justify-end`, `ROLE_TEXT` right-aligned, the quiet role select
pulled right by its own padding (`FLUSH_SELECT`), and a folder holder's Remove (red text,
`DANGER_TEXT_BUTTON`) comes after the role, last.

**The Manage access panel is one list, from one Rust fold** (`ShareDrivePanel.tsx` +
`drive/access-panel/`, `list_access_panel` in `shared_drives/access_panel.rs`), for a
drive or, when the target carries `pathPrefix`, one folder. People (owner, members,
folder holders tagged with their folder; a folder panel lists whole-drive members as
"Has the whole drive"), Pending invites, Links (working ones with usage, expiry and
maker; ended ones folded into one line). Link status, usage percent, never-expires
and seconds left are decided in Rust against the clock; TypeScript only words them
(`accessPanelView.ts`, words shared with the console's panel). `can_manage` is the
OWNER only: everyone else gets the people read only and Leave, and somebody else's
drive is never asked for invites. Sealed links open through `open_invite_links` (shared
with `list_drive_invites`), which also reports a missing drive key; the panel then shows
"Links are locked…" and routes Unlock through `useUnlockFlow` (the sync banner's flow),
reading the list again once the recovery dialog closes. Rows reuse the Share dialog's
`MemberRow` / `PendingRow` / `useRowChanges`, so changes are pessimistic in both. Each
group comes newest first from Rust (you, then most recently joined; invitations and links most recently created) and the main view draws its first
`PANEL_PREVIEW` rows (6 people, 3 pending invites, 10 links; ten or fewer links draw with no
"Show all"), a jump bar (owner: when more than one group has rows; a member sees "People N" only past
`MEMBER_JUMP_BAR_MIN_PEOPLE` (5) people, the console's rule) and "Show all N …", which opens that
group's full view in place of the list. Main-view links are the full view's `LinkRow` (one row
shape in both views): title and meta line, a usage bar, then the link field (key hidden, Copy; or
blurred with Unlock while locked), beside the Revoke menu. The ended-links fold lists
`ENDED_LINKS_PREVIEW` (6) before its own "Show all". The full view is
search, filter chips and a windowed list (`useWindowedRows`; no virtualization dependency), with the
same pessimistic actions because busy and refusal state live above both views. Searching and
filtering there is presentation over rows Rust already sent. Every person row is avatar, a
`min-w-0 overflow-hidden` words column whose lines truncate, and a fixed 98px role slot
(`ROLE_SLOT`), so a long name cannot run under the role select. Pinned by `access_panel.rs` unit
and wire tests and `drive/__tests__/ShareDrivePanel.test.tsx`.

**Refusals are "coming soon", mapped in Rust.** The server words them as `400 bad_request`
plus a message, so `classify_folder_invite_refusal` / `classify_folder_email_refusal`
match the message EXACTLY and return `NotReady(FolderInvitesUnavailable |
FolderEditorInvitesUnavailable | FolderEmailInvitesUnavailable)`; `503` mail-off is
`EmailInvitesUnavailable`. The FE dispatches on the subkind only.

Manager is not a folder role: `grant_role` reads it (and anything unknown) as `reader`, so a
holder is never manageable. `in_scope` only narrows `list_drive_folder_grants` when read
from inside a granted folder. Listings are normalised before parsing
(`default_missing_grant_roles`).

A granted folder is browsed under `grant:<owner>~<hash>~<hex(path)>` (mirrored by
`sharedDriveLabel.ts::makeFolderGrantLabel`). It resolves to the owner's identity like a
`shared:` label, and `identity::rooted_path(label, rel)` puts the grant in front of every
view-relative path: browse, upload, new folder, rename, share by link, folder invites.
That join lives in ONE function so no IPC addresses a same-named folder at the drive
root. FE gate: `FOLDER_ROLES_ENABLED` (staging only) alone.

## Folder share via link (live browsable)

A folder inside a synced drive is shared as a LIVE link, not an artifact. One metadata POST against the server's `/v1/folder-shares` mints a token scoped to `(folder_hash, path_prefix)`, and the recipient browses the folder's CURRENT contents — and downloads files — through the console's `/share/folder/{token}` page: the drive's existing ciphertext streams to them, nothing is packed or uploaded, so minting is instant regardless of folder size and later changes DO appear in the link. The URL fragment carries the drive's DERIVED file key (`#k=`, or `#p=` password-wrapped), so the server still never sees plaintext. This replaced the zip-snapshot pipeline (`zip_dir.rs`, preflight, settled-folder guard — all deleted); `FolderSettlement` survives only for folder RENAME.

### Mint funnel

`shares/commands.rs::create_folder_share_inner`. EVERY gate lives in the inner funnel, not the IPC — the macOS Finder right-click (`finder_bridge/dispatch.rs`) calls it directly, the same lesson the zip pipeline learned.

Gates: `require_folder_shares_supported` (the IPC's own authority, independent of the FE gate), the member branch (below), and `folder_share_path_prefix` (mirrors `resolve_inside_sync_root`'s component rules WITHOUT touching disk: the mint is metadata-only, so a cloud-only folder is shareable; `""` shares the whole drive).

Two zip-era guards are deliberately ABSENT: no settlement check (the recipient browses the SERVER's state, so a half-synced local copy cannot corrupt the share) and no billing-eligibility gate (nothing is uploaded).

The file key comes from the canonical `sync::remote::encryption_key_for_label` chain, and the client must be DRIVE-scoped (`sync::remote::build_client`) — the share flow's account-scoped label-less client is refused with `MissingFolderHash` because `create_folder_share` sends the folder hash from the client CONFIG. An OUTSIDE-drive folder from Finder is refused ("Only folders inside a synced Hippius drive…"). The create-path 404 `folder_not_found` slug maps to a "let it finish a sync" `Validation`, discriminated from a bare 404 (feature-off server).

### Member mint (hcfs #458)

A folder in somebody else's drive goes through `create_member_folder_share`: `capabilities.member_folder_shares` first, then this account's access from `/v1/drive-memberships` (`member_access_for`: the whole-drive membership, else a folder grant that COVERS the path), refused locally unless Editor and not frozen (`member_folder_share_refusal`; a wire `manager` reads as `writer` in `member_access_for`, and the gate still accepts `manager` as a write role; the server answers a Viewer with the same 404 as a stranger). hcfs-client's `create_folder_share` cannot send `owner_ss58`, so the POST is a direct reqwest call with the same four metadata fields plus the owner; the keystore put, compensating revoke, origin row and owner wrap mirror the owner path. The key is still `encryption_key_for_label` (owner's seal or this account's grant), never this account's master. FE: `offersShareAction` shows the item on a member drive only with the capability and a label in `useWritableMemberDriveLabels()`; hidden, not disabled, otherwise.

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
