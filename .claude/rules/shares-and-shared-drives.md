---
paths:
  - "src-tauri/src/shares/**"
  - "src-tauri/src/shared_drives/**"
  # Routes Finder shares into both folder funnels (in-drive link, uploaded copy).
  - "src-tauri/src/finder_bridge/dispatch.rs"
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

**One-click "Copy link" (`shares/quick_link.rs::copy_file_share_link`, the tray popover's rows)** reuses the newest link this device minted for the same `(label, relative_path)` (`share_origin`) that the server still lists, is public (a password link is useless without its never-stored password), has over an hour left and can be rebuilt from the keystore; otherwise it mints public, until revoked, through `share_synced_file` or `create_remote_share_inner` (cloud-only, by `file_id`), so the storage gate, origin row and owner wrap apply. Rust writes the clipboard and words every failure (`QuickLinkOutcome::Failed`, via the capture card's `link_failure_copy`). Pinned by the module's unit tests and `tray_popover_wiring.rs`.

## Shared drives (cross-account member drives)

An owner invites another account into ONE drive via a link; the member syncs it locally as a first-class drive that lives in the OWNER's server namespace. Server half = hcfs PR #348 (`drive_members`/`drive_invites`, all routes dark unless the server runs `HCFS_FEATURE_SHARED_DRIVES=1`); desktop plan `docs/plans/2026-08-20-shared-drives-phase2-desktop.md`; UI gated on `SHARED_DRIVES_ENABLED` (`app/lib/featureFlags.ts`), which is `true` on **every lane, production included**, as is `FOLDER_ROLES_ENABLED`. Keep them literals, never `enabledFrom(...)`: the feature ships to everyone, and creating shares is held back by the plan gate below, not by the lane. The console splits create vs use (`SHARED_DRIVES` on in production for joining, `SHARED_DRIVES_CREATE` a separate console launch switch); the desktop has one flag for both. A SECOND gate sits in front of it: the plan (see "Sharing needs Plus, Max or Scale" below). Backend module `src-tauri/src/shared_drives/` (grant crypto + invite/membership IPCs), resolver `src-tauri/src/sync/drive/identity.rs`.

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

### Three drive roles, and the owner or a Manager manages

A whole drive is shared as Viewer (`reader`), Editor (`writer`) or Manager (`manager`):
`WIRE_ROLES` in `shared_drives/commands.rs` and `DRIVE_ROLES` in
`app/lib/shared-drives/roles.ts`. A FOLDER is Viewer or Editor only (`FOLDER_ROLES`,
`FOLDER_INVITE_ROLES`): the server refuses `manager` on a folder invite and a grant, and
`grant_role` reads it as `reader`. An emailed invitation to a whole drive may be Manager
(hcfs #521): the server makes it single use, 400s a lifetime over one day, and does not
extend it on the first key request, so the recipient has 24 hours to claim and accept.
`resolve_email_invite` clamps it to `MANAGER_INVITE_MAX_SECS` (the omitted 7-day default
would be a 400) and refuses Manager on a folder (`resolve_folder_role`, keyed on the
request's `path_prefix`); the By email tab offers Manager only on a drive
(`emailInviteRolesFor`) and says "Works once and expires within 24 hours, so they need to
join by then" (`emailInviteNote`). A server from before #521 answers a 400
"manager invites must be sent as a link, not by email; ..." and sends nothing;
`classify_email_invite_error` matches that full message exactly (`MANAGER_EMAIL_UNSUPPORTED`)
and words it as "send a Manager link instead" (no capability flag exists to ask first).
`drive_role_from_wire` keeps the three roles and reads anything else as
`reader` in every listing (members, memberships, invites, `fold_share_access`,
`fold_access_panel`, `member_access_for`); `parseDriveRole` does the same on the FE.

What the server lets a Manager do (hcfs `hcfs-server/src/drives/routes.rs`,
`resolve_drive_manager` with `ManagementRequirement::ManagesMembers`, and
`docs/public/api/shared-drives.md`): mint whole-drive links of any role, Manager included
(capped at 1 use and 24 hours, over-cap is a 400, `MANAGER_USES_CAP` /
`MANAGER_EXPIRES_CAP_SECS`), mint folder invites, email invitations of any whole-drive role
(Manager under the same caps), change
anyone's role but their own (to Manager too, and another Manager's), remove members and
folder holders, change a holder's folders, list and revoke invites by id, and seal an
emailed invitation's key (any Manager). Always by naming the owner: `owner_ss58` in a mint
body, `?owner=` on every other route. Not theirs: sealed links and recipient addresses of
invites someone else minted (owner and minter only), their own role, and the owner (no
member row). The mint's plan gate reads the OWNER's plan.

This client follows that. The rule "may this account manage" lives in ONE Rust function,
`manages_drive(is_member, role)` (owner always, a member only as `manager`), asked by
`fold_access_panel` (`can_manage`), `fold_share_access` (`can_manage`, which the Share dialog
reads to show rows read only) and `auto_seal::seal_targets`; the FE mirror is
`canManageDrive`. Every access change resolves through `resolve_managed_target` and names the
owner with `member_owner` (mint, email, approve, revoke, remove, change role, change folders,
list invites); the server decides the role (its refusal is the uniform 404). Reads go
through `resolve_access_target`. `refuse_targeting_the_owner` keeps the owner from being
removed or re-roled. `apply_manager_invite_caps` clamps a Manager link to 1 use and 24 hours
before the request; the Share dialog's By link tab offers only "24 hours" for Manager and says
"Works once and expires within 24 hours. Managers can invite and remove people."
`list_access_panel` asks for invites on a member drive only when the member listing says this
account is a Manager. The sharing marks (`list_owned_drive_sharing`,
`list_owned_folder_sharing`) stay owner-only (`resolve_own_drive`).

Entry points for a Manager match the owner's: the drive list row and "Shared with me" row
show "Manage access" (and a "Manage access" item in the Shared with me row menu, passed only
to a Manager), the drive header shows the role chip, "Shared with N" from the membership's
`member_count` (hidden below `sm`), and "Manage access"; "Share drive…" and folder "Share"
follow `canManageDrive` / `manageableMemberDriveLabels`. A Viewer or Editor gets the role,
"Who has access" (the read-only panel) and Leave; the Share dialog shows them People with
access alone. Plan gate: `sharingGate` asks this account's plan only on an own drive
(`owner` is `ownerIsYou`, never `canManage`); on a managed drive the owner's plan decides and
only the server's 403 `shared_drives_not_entitled` shows the upgrade card. Pinned by
`management_commands_route_through_the_manager_gate`,
`the_owner_or_manager_rule_lives_in_one_place`,
`manager_invites_stay_within_the_server_caps` (`tests/shared_drive_wiring.rs`),
`a_manager_names_the_owner_on_every_management_call` (mock server), the `commands.rs`,
`access_panel.rs` and `auto_seal.rs` unit tests, and `ShareDialog.test.tsx`,
`ShareDrivePanel.test.tsx`, `DriveSharingHeaderMark.test.tsx`,
`SharedWithMeSection.test.tsx`.

The invite URL is assembled IN RUST (`create_drive_invite`): token + entropy exist nowhere else — not in logs (no-secret-log pin in `tests/shared_drive_wiring.rs`), not in another IPC. Invite policy defaults (7d / 50 uses) live in Rust (`resolve_invite_policy`); `http_create_invite` takes non-Option values so no call path can send an omitted field. The FE expiry presets (`shareDriveModalState.ts::INVITE_TTL_OPTIONS`) include "Never expires", sent as the hcfs server's 100-year lifetime cap (`NEVER_EXPIRES_SECS` = 100\*365\*24\*3600 — it must equal the server's `MAX_EXPIRES_SECS` exactly, or the preset 400s at mint time); an OMITTED lifetime still resolves to the finite 7-day default.

Invites are listed and revoked by id (`list_drive_invites` / `revoke_drive_invite`; the panel reads them through `list_access_panel`); the desktop never persists a minted token, and revoking a link is distinct from removing a member (the link still circulating vs. someone already in). **The drive list's badge comes from ONE IPC, `list_owned_drive_sharing`**, which fans out members + invites per own drive and folds them in Rust (`fold_drive_sharing`: a drive is omitted only when BOTH listings fail; unknown is not private). **The drive mark is whole-drive only**: `fold_drive_sharing` counts only invites with no `path_prefix`, and the server's `member_count` already excludes folder holders, so a drive where only a folder was shared carries no drive mark (it used to read "Invite sent"). **A folder shared on its own carries its own mark** from `list_owned_folder_sharing(label)` (owner-only via `resolve_own_drive`, asked ONLY for the drive being browsed, never fanned out over the drive list): `fold_folder_sharing` returns `{path, holderCount, hasInvite}` per folder with a grant on exactly that path (distinct holders) or a folder invite that is still open (`access_panel::invite_is_open`: an emailed invitation not yet accepted, or an `Active` link, the same rows Manage access lists as open). A spent invite never counts, because the email invitation a removed person had accepted stays listed and kept their folder marked over an empty panel (`folder_is_not_shared_once_its_last_person_is_removed`); keys are trimmed + NFC on both sides (`folderSharingKey`). A nested grant marks its own row only (`Clients/ACME` marks ACME, never Clients), and whole-drive people stay on the drive mark, so nobody is counted twice. FE: `useOwnedFolderSharing` (skipped for member/browse labels and until the membership listing settles; empty while loading, so no wrong-mark flash), `FolderSharingMark` on the list row (`NameCell`) and the card (compact: icon + count), each with its own "Manage access" button beside the pill (a `role="button"` span, since both sit inside the row's `<a>`; clicks stop there; accessible name "Manage access for {folder}"; words only when the `@container` name cell is at least `22rem`, an icon below that and always on the card), `FolderSharingHeaderMark` beside the breadcrumb of an open shared folder, and a folder-row "Manage access" menu item; all open `shareDriveModalAtom` with the folder's `pathPrefix`. **Drive-level Manage access (header button, drive list row button) is for a drive shared as a whole only**: both gate on `isDriveShared` over the whole-drive counts, so a drive where only folders are shared offers "Share drive…" and no drive-level Manage access; its folders carry their own. Copy lives in `folderRowSharing.ts` ("Shared with N" / "Shared", tooltip "Shared on its own... The rest of the drive isn't."). `invalidateOwnedDriveSharing` refreshes both query keys. Pinned by `fold_counts_only_whole_drive_invites_on_the_drive`, the `folder_fold_*` tests, `shared_drive_wiring.rs`, and `FolderSharingMark.test.tsx`, `DriveSharingHeaderMark.test.tsx` and `FolderList.test.tsx`. The FE hook `useOwnedDriveSharing` is a TanStack query keyed on the sorted label set; every mint / revoke / remove / re-role calls `invalidateOwnedDriveSharing`. It was a hand-rolled effect whose deps included the labels array, so every drive-page re-render cancelled the fetch in flight and the badge never drew Do not put a per-render array in a fetch effect's deps. `leave_shared_drive` ALWAYS sends `?owner=` (the bare server fallback deletes ALL same-hash memberships) and proceeds to local removal on a domain 404 (owner removed us first). Feature-off servers answer a bare 404 on these routes, mapped by `classify_error_status` to `NotReady(SharedDrivesUnavailable)` so the FE hides the surface instead of erroring.

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

**Shared with Me on the Drive page is always there** (`SharedWithMeSection` with `onShareDrive`,
view from `sharedWithMeState.ts::getSharedWithMeView(..., { alwaysShow, grantsSettled })`):
skeleton rows until the membership AND folder-grant listings answer, then the rows with a
"Share a drive" header button, or `SharedWithMeEmptyState` (the shared `NoEntriesFound` card,
its `illustration`/`footerLink`/`titleId` props; "A place for teamwork", docs link
`https://docs.hippius.com/use/desktop/shared-drives` opened with `openUrl`). A feature-off
server still hides it; a failed fetch shows the empty state. Settings passes no `onShareDrive`
and keeps the quiet, rows-only section. "Share a drive" opens `share-drive-picker/`
(`ShareDriveFlow` + `ShareDrivePicker`): own drives only (`folderRows` without `ownerSs58`),
"Shared with N" / "Shared" / "Not shared" from `useOwnedDriveSharing` (unknown says nothing),
search above `PICKER_SEARCH_THRESHOLD` (6). The plan gate is `sharingGate({ owner: true })`,
so Free/Starter get `NotEntitledNotice` (its Upgrade plan goes to `BILLING_ROUTE`) and no
Continue. Continue CLOSES the picker, then sets `shareDialogAtom` exactly as the row's "Share
drive..." does, so there is never a dialog over a dialog. No drives: Sync a Folder (the
page's `startSyncFolder`). Pinned by `ShareDrivePicker.test.tsx`, `SharedWithMeSection.test.tsx`
and `sharedWithMeState.test.ts`.

**Added by: one rule for the column and the filter** (`lib/shared-drives/uploaderFilter.ts`:
`uploaderKind`, `matchesUploader`; Rust `uploader_search_values` in
`sync/fileops/recent_uploads.rs`). The column shows a file with no uploader recorded as
"Owner"; the server matches one exact `uploaded_by` and never matches a missing uploader to an
address. So on a drive somebody else owns, the owner option is TWO searches in
`search_files_in_drive` (the address and `_none`), each read from row 0 to `offset + limit`
(capped at `MAX_MERGED_ROWS`), merged in the server's order (`compare_search_hits`: the sort
column, `created_at` desc by default, then `path_hash`), deduped by path hash, then cut. When
the viewer is the owner the option is "You", recorded rows only, one query. The FE filters the
result with `matchesUploader` too, so a row is never listed under someone the column would not
name. Accounts are compared by decoded public key, never text: `same_account` (subxt
`AccountId32`) in Rust, `lib/utils/ss58.ts::sameAccount` in TypeScript. Options come from
`buildUploaderOptions`: You, "name (owner)" (owner name from the membership or folder grant),
members by name, a middle-shortened address only without a name, then "Not recorded (shown as
Owner)". Pinned by `uploader_merge_tests`, `uploaderFilter.test.ts`, `ss58.test.ts`,
`addedByOptions.test.ts`.

**A folder grant row shows the folder's own size** (`folder_grant_stats` in
`sync/fileops/remote.rs`, `useFolderGrantStats`): a holder may browse at and below the grant,
and each subfolder row of `/browse` carries its subtree totals, so the folder's totals are its
subfolders' totals plus its own files, paged at most `MAX_STATS_PAGES` (then `truncated`,
shown as "at least"). Never the drive's totals. Skeleton while loading, dash on failure. No
member count on a grant row: the server does not expose how many people reach a folder.

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
setting `shareDialogAtom`). Top to bottom: one box with two tabs, By email | By link
(`ShareTabs.tsx`, the accessible mode of `components/ui/tabs/TabList` over `TabPanel`s),
then People with access, then Done. The dialog opens on the tab used last this session
(`shareDialogTabAtom`, memory only, By email by default); Manage access's "Invite" sets it
to By email and "New link" to By link before opening. Both panels stay mounted (a typed
address survives a switch) and the inactive one is hidden by attribute AND class, since a
flex panel would otherwise beat `[hidden]`. On a plan without sharing the upgrade card
replaces the whole box. A folder without folder roles keeps the By email tab with the
folder-email "coming soon" notice. By email calls only `email_drive_invite` (the address
checked as typed by `check_invite_email`; the role and Send appear once the field has
text); By link calls only `create_drive_invite` / `create_folder_invite` and describes the result
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

**An emailed invitation is pre-sealed at send** (hcfs #514, invite key directory,
`docs/plans/2026-09-28-invite-key-directory-design.md` in hcfs). Every account publishes an
X25519 invite key, `blake3::derive_key("hippius.hcfs.invite-account-key.v1", seed[..32])`:
`invite_key::account_invite_public_key` delegates to `hcfs_client::client::invite_key` (needs
the hcfs pin at or after a954460d; the frozen vector shared with the console stays pinned here
and in `hcfs_contract.rs`). The auto-seal task PUTs `/v1/account/invite-key` (body is hcfs-shared's
`PublishInviteKeyRequest`) once per account per sign-in (`InviteKeyPublishMemo`: a failed publish
is not recorded and retries next pass, sign-out clears it), only while a session mnemonic is in
memory, never prompting; `recover_mnemonic` calls `invite_auto_seal.unlocked(account)`, which
forgets the account and nudges, so a session that started locked publishes right after the unlock.
**A locked app sends no email invite**: `email_drive_invite` checks `require_session_key` last before
the mint and answers `NotReady(NoEncryptionKey)`; the Share dialog (`InvitePeopleSection` +
`useUnlockThenResume`) opens the same unlock as Manage access's locked links (`useUnlockFlow`) and
re-sends once when the recovery dialog closes; a cancelled unlock is refused again the same way, so
nothing is sent and the address stays. Refusals that need no key (bad folder, no folder invites on
the server) come back before any unlock. After the mint, `email_drive_invite` reads `recipient_key`
and seals to it through the same `invite_seal_keys` + `seal_invite_row` path Approve uses, so a
recipient with an account joins with nobody online. `recipient_key` is a real key or a server decoy,
indistinguishable by design: always seal, never branch on it. A folder key is pre-sealed only when
the mint echoed that exact folder (`preseal_row`, fails closed). Best-effort: any error, a stale row
or no key leaves the handshake below, and `EmailInviteResult.presealed` is `false`
(`preseal_landed`), which the dialog words as an info toast, "They may need approving when they open
it." A pre-seal does not change the listing: the row stays `sent` until the recipient claims, then
lands `sealed` ("Approved, not joined yet") with no `awaiting_seal` step, so the pending copy needs no
pre-seal state (and could not have one: a decoy looks the same). The envelope refuses a low-order
recipient key (`was_contributory`), whose seal would open under `HKDF(0, invite_id)`. Pinned by the
`invite_key`, `preseal_row` and pre-seal mock-server unit tests in `commands.rs`, the publish-memo
tests in `auto_seal.rs`, `an_email_invite_needs_the_key_before_it_is_sent_and_preseals_like_approve`,
`email_invite_mint_and_invite_key_publish_wire_pinned`, and `emailInviteUnlock.test.tsx`.

**Emailed invitations are approved automatically while an owner or a Manager is signed in**
(`shared_drives/auto_seal.rs`). An opened invitation (`awaiting_seal` with a
`requester_pubkey`) is sealed and PUT by a Rust background task, the same way Approve
does it: keys from `invite_seal_keys`, sealed and posted by `seal_invite_row` (derived
file key for a row with `path_prefix`, entropy otherwise), the only two helpers
`approve_email_invite` uses too. Safe without a click because the server lets only the
invited mailbox publish the key (HCFS #480). Rules: drives this account owns
(`/list_folders` in its namespace) or manages (`/v1/drive-memberships` with role
`manager`), chosen by `seal_targets` through `manages_drive`; a managed drive's invites are
listed and sealed with `?owner=` (`member_owner`), and its key comes from the owner's seal or
this account's grant through the same `invite_seal_keys` funnel;
NEVER prompts (no session mnemonic is a quiet pass, `recovery_lock` is `try_lock`ed);
plan gate `fetch_can_share_drives` for OWN drives only (same inputs and rule as
`get_storage_overview`, cached 10 min, re-read on a nudge; a managed drive follows its
owner's plan, which only the server knows); one attempt per `(invite_id, pubkey)`, forgotten on
stale or transient failure; folder rows only when the FE passes `FOLDER_ROLES_ENABLED`.
Cadence (`next_delay`, pure): 15 s while any owned or managed drive has an emailed invitation `sent`
or `awaiting_seal`, 3 min otherwise or when unavailable, errors back off 30 s doubling to
5 min. Started by `InviteAutoSealListener` (protected layout, behind
`SHARED_DRIVES_ENABLED`), stopped by `logout_full` and on unmount, ends itself when the
session account changes. `email_drive_invite` nudges it in Rust; Manage access nudges on
open. Each delivery emits `shared-drive:invite-key-delivered`; the listener toasts
"{email} can join {drive}." ("Someone" when the address is hidden), bumps
`driveInvitesVersionAtom` and `inviteKeyDeliveredVersionAtom` (the Share dialog reloads
on it) and invalidates the sharing badges. The row copy is "Opened · they join while the
app is open" (panel pill "Opened"), with Approve kept as the fallback. Pinned by the
`auto_seal` unit tests and `automatic_delivery_uses_the_approve_path_and_the_manager_gate`.

**The Manage access panel is one list, from one Rust fold** (`ShareDrivePanel.tsx` +
`drive/access-panel/`, `list_access_panel` in `shared_drives/access_panel.rs`), for a
drive or, when the target carries `pathPrefix`, one folder. People (owner, members,
folder holders tagged with their folder; a folder panel lists whole-drive members as
"Has the whole drive"), Pending invites, Links (working ones with usage, expiry and
maker; ended ones folded into one line). Link status, usage percent, never-expires
and seconds left are decided in Rust against the clock; TypeScript only words them
(`accessPanelView.ts`, words shared with the console's panel). `can_manage` is the
owner or a whole-drive Manager (`manages_drive`): everyone else gets the people read only
and Leave, and a drive they do not manage is never asked for invites. Sealed links open through `open_invite_links` (shared
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
`min-w-0 overflow-hidden` words column whose lines shorten, and a fixed 98px role slot
(`ROLE_SLOT`), so a long name cannot run under the role select. A name, address or email is
shortened in the MIDDLE by `ui/MiddleTruncate` (fit by `lib/utils/fitMiddle.ts`: an email keeps
its domain, an ss58 both ends), handed the full value, never CSS `truncate` and never a
pre-shortened string, which together drew "5DSQ…5…"; "(you)" sits outside it, `shrink-0`.
Pinned by `share-dialog/__tests__/identityLines.test.tsx`, `access_panel.rs` unit and wire
tests and `drive/__tests__/ShareDrivePanel.test.tsx`.

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
root. FE gate: `FOLDER_ROLES_ENABLED` (on in every lane) alone.

## Folder share via link (live browsable)

A folder inside a synced drive is shared as a LIVE link, not an artifact. One metadata POST against the server's `/v1/folder-shares` mints a token scoped to `(folder_hash, path_prefix)`, and the recipient browses the folder's CURRENT contents — and downloads files — through the console's `/share/folder/{token}` page: the drive's existing ciphertext streams to them, nothing is packed or uploaded, so minting is instant regardless of folder size and later changes DO appear in the link. The URL fragment carries the drive's DERIVED file key (`#k=`, or `#p=` password-wrapped), so the server still never sees plaintext. This replaced the zip-snapshot pipeline (`zip_dir.rs`, preflight, settled-folder guard — all deleted); `FolderSettlement` survives only for folder RENAME.

### Mint funnel

`shares/commands.rs::create_folder_share_inner`. EVERY gate lives in the inner funnel, not the IPC — the macOS Finder right-click (`finder_bridge/dispatch.rs`) calls it directly, the same lesson the zip pipeline learned.

Gates: `require_folder_shares_supported` (the IPC's own authority, independent of the FE gate), the member branch (below), and `folder_share_path_prefix` (mirrors `resolve_inside_sync_root`'s component rules WITHOUT touching disk: the mint is metadata-only, so a cloud-only folder is shareable; `""` shares the whole drive).

Two zip-era guards are deliberately ABSENT: no settlement check (the recipient browses the SERVER's state, so a half-synced local copy cannot corrupt the share) and no billing-eligibility gate (nothing is uploaded).

The file key comes from the canonical `sync::remote::encryption_key_for_label` chain, and the client must be DRIVE-scoped (`sync::remote::build_client`) — the share flow's account-scoped label-less client is refused with `MissingFolderHash` because `create_folder_share` sends the folder hash from the client CONFIG. An OUTSIDE-drive folder from Finder never reaches this funnel; it is uploaded as a copy (next section). The create-path 404 `folder_not_found` slug maps to a "let it finish a sync" `Validation`, discriminated from a bare 404 (feature-off server).

### Outside-drive folder from Finder: an uploaded copy

A folder outside every drive has no server-side records to browse, so `finder_bridge/dispatch.rs::share_for_path` sends it to `shares/outside_folder.rs::share_outside_folder`, which uploads a copy under the link's own key (hcfs `create_upload_folder_share`); the server deletes the copy when the link expires or is revoked.

- **Funnel order:** capability `upload_folder_shares` → `refuse_a_folder_holding_a_drive` → display name → `folder_scan` (drive-upload skip rules from `pathops::visible_children`, off the main thread via `scan_until_dropped`) → `require_eligible(Sharing, scan.total_bytes)` → `create_upload_folder_share` → owner wrap. An older server refuses before the disk is walked, and the quota gate needs the scan's real bytes, so an over-quota account uploads nothing. Pinned by `the_funnel_gates_before_it_uploads`.
- **A folder that holds a drive root is refused, in the funnel and in the chooser** (`dispatch::drive_holding_refusal`): the walk would re-upload that drive's files, billed again, without its `.hippius/exclude` rules, and a shared drive's files into a link that outlives the membership. Drive roots are matched in their stored AND canonical spelling (`sync::paths::with_canonical_roots`), since Finder sends canonical paths and a root stored through a symlink would otherwise send an in-drive folder down the copy path. Pinned by `a_folder_holding_a_drive_is_refused_before_any_request`, `the_chooser_refuses_a_folder_that_holds_a_drive` and `the_chooser_matches_a_drive_stored_through_a_symlink`.
- **Privacy:** file contents are encrypted on device, but the folder's name (the link's title), every file's relative path and every empty folder's path reach the server in plaintext and are stored, as for drive files. The scan refuses the shared folder's own name when the path validator would, so a bidi or control character never becomes the recipient page's title.
- **Cancel is cooperative on this path only.** The modal's token goes INTO the upload so the client can `DELETE` the half-built link; a dropped future sends nothing and leaves the link and its quota hold until the server's ~1 h idle reaper. Steps before the open are abandoned by `before_open` (nothing exists server-side yet). Every other Finder mint is one request and stays dropped by `dispatch::until_cancelled`. Pinned by `the_funnel_hands_the_cancel_token_to_the_upload`, `the_finder_outside_folder_branch_uploads_a_copy_with_cooperative_cancel`, `the_finder_confirm_hands_the_cancel_token_to_the_mint` and `a_finder_cancel_mid_upload_aborts_the_half_built_link`.
- **The owner wrap is the desktop's job and is sealed like a drive folder link's:** `owner_wrap::push_folder_for_account` with the master mnemonic, the signed-in account (login) address and the row's `token_hash`, because the console opens folder wraps with its session address and the client pushes no wrap. A missing keystore secret is logged, not fatal: the link already exists. Pinned by `an_uploaded_copy_is_wrapped_exactly_like_a_drive_folder_link`.
- **The chooser opens at once; an outside folder is sized after.** `finder:share-choosing` carries `isFolder` (any folder: folder wording) and `isFolderCopy`: `false` for an in-drive folder or any file, `true` for a folder outside every drive (copy notice, progress bar), and `null` when the drive roots could not be read (`Placement::Unknown`), in which case the chooser shows neither notice because either promise could be false; the confirm resolves the target again. An in-drive Finder folder is worded exactly like an in-app folder link, live-link notice and spinner included. Pinned by `finder_share_choosing_wire_shape`, `finder_share_choosing_carries_nulls_when_stat_is_unavailable`, `the_chooser_treats_an_in_drive_folder_as_a_live_link`, `the_chooser_promises_nothing_when_the_drive_roots_are_unreadable` and `ShareFileModal.test.tsx` ("promises neither a live link nor a copy when the placement is unknown").
- **A folder copy's size or refusal follows in `finder:share-facts {id, sizeBytes, refusal: {kind, message} | null}`**, from the same `folder_scan` the share runs, so the number shown is the number billed and the refusal is the one the confirm would give. Emitted only while `id` is still the latest click. On a refusal the chooser shows the message verbatim, disables Confirm, and says the user can choose Share with Hippius again once the folder is fixed (this chooser never re-measures). Pinned by `finder_share_facts_wire_shape`, `an_outside_folder_is_sized_by_the_share_scan`, `a_folder_the_share_would_refuse_carries_the_refusal`, `folder_facts_are_dropped_once_a_later_click_replaces_the_chooser`, `FinderShareListener.test.tsx` and `ShareFileModal.test.tsx` ("shows the share's refusal before confirming, and blocks the confirm", "says the folder can be shared again once the refusal is fixed").
- **The chooser's scan is bounded at 30 s (`FOLDER_FACTS_BUDGET`) and stoppable.** Each `PendingFinderShare` carries a `scan_stop` token, fired when a newer click supersedes it (`store_finder_share`), when the confirm takes it (`take_finder_share`; the share scans again) and when the chooser closes (`cancel_finder_share`). The scan is selected against it, and dropping the scan future raises the walk's `StopOnDrop` flag, so no walk runs on for a chooser nobody sees. A superseded request is also dropped from `pending_finder_shares` (nothing can confirm it any more), and one directory listing stops at the caps' sum (`visible_children`'s `limit`), so a million-entry folder is not stat'ed before the cap refuses it. If a new chooser replaces a share that is still uploading, the modal cancels it and says so in a toast. Pinned by `a_superseded_finder_request_is_dropped_and_its_scan_stopped`, `a_flat_folder_past_the_caps_is_refused_from_a_cut_listing`, `ShareFileModal.test.tsx` ("tells the user, by name, that the replaced share stopped") and `a_stopped_request_drops_its_folder_scan_at_once` and `a_newer_click_a_confirm_or_a_cancel_stops_the_chooser_scan`.
- **A cancel that lands after the link was finished revokes it.** hcfs-client tears down a link cancelled during the seal; one cancelled during the owner wrap is revoked by `revoke_cancelled`, and the key is forgotten either way. A failed revoke reports `CANCELLED_BUT_LINK_LIVE` ("Revoke it from Shared Links"), never the plain `SHARE_CANCELLED`, because the link is still live. The modal has closed on Cancel, so that error reaches no one: Rust also saves a Files notification ("Link Still Active", naming the folder, opening `/shares`) for the sharing account, honouring its Files toggle (`create_cancelled_share_link_live_notification`), and emits `hcfs_cancelled_share_link_live_notify` so `useFilesNotification` refreshes the bell. Pinned by `a_cancel_during_the_seal_revokes_the_sealed_link`, `a_cancel_during_the_owner_wrap_revokes_the_finished_link`, `a_late_cancel_whose_revoke_fails_says_the_link_is_still_live` and `a_late_cancel_that_revokes_its_link_saves_no_notification`.
- **Quitting mid-share cancels running mints and waits briefly, by quit path.** `ExitRequested` (window close, tray Quit, `app.exit`) goes through `AppState::on_exit_requested`, a three-state grace (`Idle` → `Holding` → `Released`) under the same lock as the running mints: the first request with mints running cancels them and holds the exit while `finish_exit_grace` waits ≤3 s and then ALWAYS releases; every request while `Holding` is held (Linux and Windows send two per window close). macOS Cmd+Q, Dock Quit and logout raise no `ExitRequested` (tao's `applicationWillTerminate` ends the loop), so `RunEvent::Exit` calls `on_final_exit` and blocks ≤1 s unless a grace already ran. A restart is never held. Any pass or release leaves `Released`, and a share confirmed after that starts cancelled. Pinned by `every_exit_request_during_the_grace_is_held`, `the_grace_releases_the_exit_even_when_a_mint_never_finishes`, `the_final_exit_cancels_running_mints_and_waits_only_once` and the other grace tests in `app_state.rs`.

### Member mint (hcfs #458)

A folder in somebody else's drive goes through `create_member_folder_share`: `capabilities.member_folder_shares` first, then this account's access from `/v1/drive-memberships` (`member_access_for`: the whole-drive membership, else a folder grant that COVERS the path), refused locally unless Editor or Manager and not frozen (`member_folder_share_refusal`; the server answers a Viewer with the same 404 as a stranger). hcfs-client's `create_folder_share` cannot send `owner_ss58`, so the POST is a direct reqwest call with the same four metadata fields plus the owner; the keystore put, compensating revoke, origin row and owner wrap mirror the owner path. The key is still `encryption_key_for_label` (owner's seal or this account's grant), never this account's master. FE: `offersShareAction` shows the item on a member drive only with the capability and a label in `useWritableMemberDriveLabels()`; hidden, not disabled, otherwise.

### Capability gate

`ServerCapabilities.folder_shares` (`shares/capabilities.rs`; struct-level `#[serde(default)]`, so a pre-folder-shares server that omits the field reads as `false`, never a parse error). The FE mirror is `folderShareFeatureEnabledAtom` — unlike file shares this is NOT hard-coded on: `canShareFolder` (`folderShareGating.ts`) renders the folder "Share via link" items disabled-with-tooltip until the capability is confirmed, and both folder-listing queries are `enabled:`-gated on it so an old server sees no traffic.

### Owner ops

`hcfs_list_folder_shares` / `hcfs_revoke_folder_share` / `hcfs_update_folder_share_expiry`, account-scoped client. The listing returns `token_hash` (blake3 hex) per row — a folder-share token is never echoed after create. Rows are resolved against the PERSISTENT SQLite keystore (`SqliteShareKeystore::all_entries` scanned through `folder_share_token_hash`): a row minted on THIS machine comes back `resolvable` with the plaintext token (the handle revoke/expiry take) and the URL rebuilt by `build_folder_share_url_for`, which dispatches on the stored `ShareSecret` — a password share can never rebuild a password-free `#k=` link. Rows minted elsewhere are view-only.

Unlike the file listing, revoked and expired rows ARE present until the server's reaper sweeps them; the FE renders the dead state from the row (`shareRowDisplay.ts::folderShareRowPlan` — Copy suppressed on dead rows even when locally resolvable, expiry presets withheld on EXPIRED rows because the server's PATCH 404s them while Revoke stays offered, revoke/expiry disabled with honest tooltips on foreign rows).

Revoke maps the server's bodiless 404 to `Ok(())` plus a local keystore forget — but the forget is gated behind a `require_folder_shares_supported` probe first: a server ROLLBACK to a build without `/v1/folder-shares` 404s the route itself, and forgetting on that would delete the only plaintext copy of a token that still guards a live share once the server rolls forward (wiring-pinned in `tests/folder_share_wiring.rs`). With the probe passing, double-tap is idempotent and a token revoked from another device stops resolving here. A foreign row's `isPrivate` is `null` (protection unknown on this device — never a fabricated "public"), and the badge tooltip drops the public/private wording for it.

### Badges key on the LISTING, never `share_origin`

The folder mint deliberately records NO `share_origin` row — the file-share prune in `hcfs_list_shares` would evict it on the next refresh. The per-folder "Shared" badge instead derives the share's server-side identity itself: `useFolderShareBadge` (`app/lib/hooks/useFolderShares.ts`) indexes the listing by `(folderHash, pathPrefix)` — revoked rows dropped at index build, expired rows at lookup time (expiry is clock-dependent, the index is cached) — and the folder row computes the same pair via `driveFolderHash(label)` (WebCrypto SHA-256 first 16 hex chars, pinned byte-for-byte to `hcfs_client::drive::keys::folder_hash`) plus the SAME `folderShareRelativePath` resolution the mint uses, so nested rows badge correctly. A whole-drive share does not badge subfolders. Legacy zip-era folder links were FILE shares of an archive with an origin row, so `SharedLinkBadge.tsx` still consults the file index too until those age out.

**Uploaded copies never badge, and never read as "Whole drive".** Each listing row carries `source` (`FolderShareOrigin` `drive` / `uploadedCopy`, mapped in Rust from hcfs `FolderShareSource` by an exhaustive `From`, so a new upstream variant breaks the build). An uploaded copy has `folderHash` and `pathPrefix` `""`: `buildFolderShareIndex` skips every non-`drive` row and any row with an empty `folderHash`, and the outside-folder funnel records no `folder_share_origin` row, which is the Finder folder badge's source. The shares page's scope line is `folderShareScope` (console parity): "Uploaded copy" with the snapshot caveat as `title` and sr-only text, "Whole drive" only for a drive row with a folder hash and an empty prefix, "Folder link" for a drive row with no hash. Copy, expiry and revoke are source-agnostic (token, `tokenHash`, owner wrap). Pinned by `listing_rows_carry_their_source_to_the_fe`, `an_uploaded_copy_lists_as_one_and_is_managed_like_a_drive_link`, `useFolderShares.test.ts` and `FolderShareScope.test.tsx`.

### No `shared_link_history` for folder shares

`history::diff_active_lists` detects death by DISAPPEARANCE between consecutive active lists, and the folder listing retains dead rows until reap — a row would only "disappear" at reap time, recording a bogus end moment. The dead state lives on the listing row instead, and the `/shares` history card says so.

### Log redaction

The share commands log `share_token = %…` tracing fields, and `\btoken\b` can never fire inside `share_token` (`_` is a word character) — `utils/logs.rs` carries a dedicated `share[_-]?token` alternative for exactly that field. `token_hash` stays deliberately loggable: it is the server's own correlation handle, never the capability.

### Frontend

The mint has NO progress channel — `createFolderShare` is one POST, and `ShareFileModal` shows `MintingBody` (a plain spinner) rather than a progress bar that would imply work that isn't happening; the modal's notice states the link is live. The `/shares` page merges file and folder rows newest-first (`mergeActiveShareRows`), folder rows showing "Folder" in the size column (a live share has no fixed size).

Path resolution is unchanged from the zip era: the share atom carries `ShareModalTarget {file, relativePath}` resolved by the surface that OPENS the modal, never derived inside it — a nested folder row's `actualFileName` is only the BASENAME (the containing path lives in `parentRelativePath`, or in the table's `currentSubfolderPath`), so deriving it in the modal would mint a link for a different folder of the same name at the drive root. `folderShareGating.ts` owns the rule: `shareTargetFor` plus `canShareFolder`/`FOLDER_SHARE_DISABLED_TOOLTIP`; FOUR surfaces open the modal — the files-table 3-dot menu, card view, the right-click `FileContextMenu`, and `FileViewerLayout` — and all four must pass their own base path.
