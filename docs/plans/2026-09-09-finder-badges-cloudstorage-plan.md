# Finder integration, option A: badges, CloudStorage limits, election settle

**Date:** 2026-09-09
**Status:** In progress
**Scope:** Make the shipped Finder Sync extension behave like its peers (MEGA,
ownCloud, Nextcloud) without moving to File Provider. File Provider is a
separate project (see the assessment in this plan's parent conversation: it
needs stable item ids and a change cursor from hcfs-server first).

## Why

A beta user (2026-09-09) reported: the enablement nudge came back after they
pressed Enable and relaunched; Finder shows no badges; files they moved stayed
"Pending". Reading the code against that report:

1. **No badges at all.** `FinderBridge::set_badge` has no caller outside its
   own unit test. The Swift side registers `synced` / `syncing` / `shared`
   badge images and honours `STATUS` lines, but the sync engine never emits
   them.
2. **A drive added after login is invisible to Finder until the next launch.**
   `register_drive_roots` runs only at the end of auto-init; `register_drive`
   (the per-drive path `add_local_sync_folder` takes) never registers the root,
   and `remove_drive_inmemory` never unregisters one.
3. **Their drives live under `~/Library/CloudStorage/GoogleDrive-…`.** Apple
   confirmed (forum 718381) Finder Sync never renders menus or badges on File
   Provider paths, so no enablement fix can help there. The app says nothing.
4. **The launch election reads the switch once, immediately after
   `pluginkit -e use`.** PlugInKit reports asynchronously; a `false` there
   leaves the fingerprint unadopted, so every later launch runs `Reelect`
   (which switches the extension OFF for a second) and the FE, told the check
   has settled, can read `Disabled` and nudge. Matches "closed the app and it
   showed up again".

## Design

### Badges: pull for the steady state, push for transitions

Finder asks the extension for a badge per visible item
(`requestBadgeIdentifier(for:)`). A full push of every synced path is not
viable (168k entries through a 256-slot broadcast that drops on lag), so:

- **Pull.** The extension answers from its cache, and on a miss sends
  `BADGE_QUERY:<path>` (new `ClientMessage::BadgeQuery`). The app resolves the
  path against `SyncRunner::label_roots`, consults the in-memory session (in
  flight / failed), the `share_origin` sidecar (shared), and the synced-paths
  cache (synced), and answers with the existing `STATUS` line. Resolution is a
  pure function (`badges::resolve_badge`), unit-tested.
- **Push.** Transitions the user is watching: plan ready → `syncing` for each
  planned upload/download (capped at `MAX_PLAN_BADGE_PUSHES`, beyond which the
  pull path covers it); file synced → `synced` (or `clear` on delete); file
  failed → `error` (new `BadgeState::Error`); share minted / revoked →
  `shared` / `synced`.
- **Cache hygiene.** The extension drops its badge cache when the socket drops,
  so an app restart never serves stale states.
- **Roots.** `register_drive` registers the root with the bridge;
  `remove_drive_for_account` unregisters it.

Priority when facts conflict: in flight > failed > shared > synced. A folder
inside a drive reads `syncing` when any in-flight file is under it, `error`
when any failed file is, else `synced`. Anything outside a drive is `clear`.

### CloudStorage: say so, do not refuse

`sync::drive::root_host::root_host(path, home)` classifies a root under
`~/Library/CloudStorage/<Provider-…>` or `~/Library/Mobile Documents` and
names the provider. `SyncFolderInfo` gains `hostedBy`, the folder row shows a
one-line hint, and the add-folder dialog shows the same hint as soon as a
folder is picked (`sync_root_host` command). Existing drives keep working —
refusing would strand the reporting user's two drives.

### Election settle

`settle_after_election` polls `read_state` for up to `ELECTION_SETTLE` after
`elect()` and returns the first `Enabled` (or the last state). Both the launch
check and the Enable button use it, pinned by source-text tests like the rest
of `enablement.rs`.

## Out of scope

- The sync engine not resuming until restart, and files moved on disk staying
  Pending. Separate bug; the drives in the report are Google Drive placeholder
  trees, which is its own hazard.
- File Provider. Needs hcfs-server stable ids + change cursor first.

## Tasks

1. `protocol.rs`: `BadgeState::Error`, `ClientMessage::BadgeQuery`, tests.
2. `finder_bridge/badges.rs`: `resolve_badge` (pure), `answer_badge_query`,
   push helpers with the plan cap (pure `plan_badge_paths`).
3. `shares/origin.rs::is_shared`.
4. `dispatch.rs`: route `BadgeQuery`.
5. `callbacks.rs`: plan-ready / file-synced / file-failed pushes.
6. `lifecycle.rs`: register root on `register_drive`, unregister on remove.
7. `shares/commands.rs`: badge on mint/revoke.
8. Swift: `WireProtocol.badgeQueryLine`, query on cache miss, cache clear on
   disconnect, `error` badge image.
9. `tests/finder_socket_pins.rs`: Swift carries every Rust badge token and the
   query verb.
10. `root_host` + `hostedBy` + `sync_root_host` + FE hint + tests.
11. `settle_after_election` + pins; `LAUNCH_CHECK_CAP` raised to cover it.
12. CHANGELOG, `.claude/rules/macos-packaging.md`.
