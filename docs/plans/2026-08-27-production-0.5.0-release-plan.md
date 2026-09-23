# Production 0.5.0 — promoting beta with shared drives held back

Production sits on `0.2.3`. The `beta` lane carries 313 commits it does not have,
and the next production release takes all of them except one feature: shared
drives stays hidden.

## Why this is a flag flip, not a cherry-pick

`main` and `beta` differ by 626 files and roughly 87,000 lines. The features are
interleaved — the upload speedup, the startup speedup and the idle-work
reduction all land in the same sync engine — so there is no subset of commits
that yields "everything except shared drives".

There does not need to be. Shared drives was built behind
`SHARED_DRIVES_ENABLED` in `app/lib/featureFlags.ts`, the same mechanism already
holding back Wallet, Virtual Machines, VPN and Referrals. Flipping it to `false`
hides every shared-drive surface: the "Share drive…" item in both folder menus,
`ShareDriveModal`, the "Shared with me" sections in settings and
`DriveOnboarding`, and the owner badge on member rows.

The Rust IPCs (`create_drive_invite`, `list_drive_members`, `remove_drive_member`,
`list_my_drive_memberships`, `leave_shared_drive`, `add_shared_drive`) stay
registered. Nothing in the UI reaches them, and leaving them in place is what
makes the flag a one-line change in both directions.

### What the flag deliberately does not gate

`folderMenuGating.ts` keys the member-row protections on the row's `ownerSs58`
data rather than on the flag. That is the reason turning the flag off is safe:
it cannot hand an existing member row "Delete from Server" (the backend would key
the delete by the wrong identity) or a plain Remove that strands a live
server-side membership. Any manual check of the flag-off build must confirm this
still holds — it is the only path by which this release could damage existing
state.

## Version: 0.5.0

The `beta.N` builds are prereleases of `0.5.0`, so production takes `0.5.0`.
Semver orders `0.2.3 < 0.5.0-beta.3 < 0.5.0`, which makes the release an upgrade
for both existing production users and beta testers returning to stable.

This forces a follow-up: `beta` must move to `0.6.0-beta.1` once production is
on `0.5.0`, or the next beta build (`0.5.0-beta.4`) sorts below production and
the beta lane stops advancing. `staging` moves to `0.6.0-dev.1` with it.

## Phase 0 — land #368 on beta

PR #368 promotes `staging` to `0.5.0-beta.3`, bringing the Finder LaunchServices
fix (#367). Production cannot be cut before it lands, because production takes
`beta` wholesale.

It merges as a **merge commit**, not a squash. Only `beta` → `main` is squashed;
squashing into `beta` leaves the merge base behind and makes every later
promotion replay the same commits as conflicts.

The PR argues for letting the in-flight `0.5.0-beta.2` build finish first, so a
published beta DMG exists to test **Explore Beta** end to end. That is worth
doing: the channel switch ships to production users in this release, and no CI
job can exercise an install-and-relaunch.

## Phase 1 — `release/0.5.0`, branched off `beta`

Three changes, nothing else.

**1. Turn the flag off.** `app/lib/featureFlags.ts`:

```
export const SHARED_DRIVES_ENABLED = false;
```

The doc comment above it currently reads "`true` since the 2026-08 rollout" and
explains why the server and console are live. Rewrite that paragraph to state
why production holds the feature back while beta keeps testing it, so the next
person reading the flag is not told the opposite of what it says.

**2. Bump the version to `0.5.0`** in exactly three files:

- `src-tauri/tauri.conf.json` — canonical; every workflow reads it with `jq -r .version`
- `src-tauri/Cargo.toml` and `Cargo.lock`
- `package.json`

Not `Info.plist`: `bundle_metadata_pin.rs` asserts that file carries no version.
`release_lane_pins.rs::the_three_version_files_agree` fails if the three drift.

**3. Restructure the CHANGELOG.** `CHANGELOG.md` does not exist on `main` — this
release ships it for the first time, and its single `[Unreleased]` block
currently covers everything since `0.2.1`, including work users already have.

Split it:

- `## [0.2.2]` and `## [0.2.3]` — retrospective sections for what already
  shipped: Finder and Linux "Share with Hippius", share-link expiry and
  passwords, empty folders, the home storage and plan cards, the offline banner,
  keep-awake during transfers.
- `## [0.5.0] - 2026-08-27` — what is new to production users in this release.
- A fresh empty `[Unreleased]` above both.

Three features present in the beta code have no changelog entry at all and need
one written:

- Downloading a folder as a zip from Drive (`app/lib/utils/downloadFolder.ts`)
- Live folder share links — a folder link shows the folder's current contents
  rather than a zip snapshot, minting is instant, and later changes appear in
  the link
- Restoring a forgotten unlock password from the seed phrase
  (`app/components/recovery/AccountRecoveryDialog.tsx`)

No shared-drives entry: it is not shipping.

## Phase 2 — verification

Automated:

```bash
pnpm test
cd src-tauri
cargo fmt --all --check
cargo clippy --all -- -D warnings
cargo test
```

The flag flip does not break the frontend suite. Every shared-drives test mocks
`@/app/lib/featureFlags` through a hoisted getter and drives both flag states
itself, rather than reading the real constant.

Manual, on a flag-off build — CI cannot cover any of these:

- No "Share drive…" in the row's `TableActionMenu` or the right-click
  `FolderCardContextMenu`
- No "Shared with me" section in settings or `DriveOnboarding`
- No owner badge on folder rows
- On an account that is a member of someone else's drive: the row still offers
  "Leave shared drive" and still does **not** offer "Delete from Server" or a
  plain Remove
- Explore Beta switches to the beta build and back to stable

## Phase 3 — PR into `main`

`release/0.5.0` → `main`, **squash** merged. `main` requires linear history, and
nothing is promoted past it.

`check-promotion-order` passes because the head contains `beta`. The push
triggers `tauri-build.yml`, which cuts `v0.5.0` and marks it latest.

## Phase 4 — after the release

- Bump `beta` to `0.6.0-beta.1` and `staging` to `0.6.0-dev.1`
- Confirm a real `0.2.3` install takes the update. The updater pubkey in
  `tauri.conf.json` is identical on `main` and `beta`, and no workflow patches
  it, so the signature verifies — but this is the failure that is invisible
  until a user hits it, so check it against an actual installed copy
- Confirm the production `latest.json` published and resolves through
  `releases/latest`

## Known consequences

**macOS 10.13–10.15 are dropped.** #368 raises `minimumSystemVersion` to `11.0`
to match the Finder appex. Tauri's updater compares versions, not OS floors, so
installs on those systems are offered an update they cannot run. Accepted: those
releases are unsupported.

**The flag flip recurs on every promotion.** `beta` holds `true` and `main` will
hold `false`, so every future `beta` → `main` PR shows the flag as a diff, and
one unreviewed promotion ships shared drives to production. This belongs in
`docs/release-checklist.md`. It cannot be pinned in `release_lane_pins.rs`,
which runs on all three lanes and would then fail on `beta`.

**Console invites dead-end on production desktop.** The hcfs fleet runs with
`HCFS_FEATURE_SHARED_DRIVES=1` and the console's `/invite/{token}` accept page is
live. Someone can accept a drive invite in the console and their production
desktop will never surface the drive, with no explanation. Whoever owns the
console flag needs to know production desktop is flag-off.
