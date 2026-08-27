# Beta channel and the in-app channel switch

Design for a third release lane and a user-facing switch onto it, plus removing
the per-channel console split.

Two user-facing outcomes:

1. A **beta** channel that willing users can opt into from inside the app, which
   downloads the beta build and restarts into it. Opting back out works the same
   way.
2. **One console for every channel.** Staging builds stop minting share and
   invite links at `console.hippicode.com`.

## What made this feasible

`tauri-plugin-updater` 2.10.1 exposes the whole updater configuration at
runtime, not only through `tauri.conf.json`: `UpdaterBuilder::endpoints`
(`updater.rs:197`), `::pubkey` (`:253`), and `::version_comparator` (`:184`).
A Rust command can therefore point a check at a different channel's manifest.

The JavaScript API cannot. `CheckOptions` in
`@tauri-apps/plugin-updater` carries `headers`, `timeout`, `proxy`, `target`,
and `allowDowngrades` — there is no `endpoints`. So the switch has to be a Rust
command. That agrees with the repo's standing rule, but it is worth recording
that it is also the only option: `app/components/updater/checkForUpdates.ts`
opens with a comment claiming the JS `check()`/`downloadAndInstall()` have "no
Rust equivalent", which is no longer true and should be corrected when that file
is next touched.

## Two bugs this fixes on the way

**A staging build cannot auto-update, and fails silently.**
`scripts/use-staging-updater-key.sh` patches the staging *pubkey* into
`tauri.conf.json` but leaves the *endpoint* alone. That endpoint is
`releases/latest/download/latest.json`, and GitHub resolves `latest` only to
non-prereleases — so a staging build fetches the **production** manifest and
tries to verify it with the **staging** key. The check fails on a signature
mismatch, which reads as "no update" rather than as a misconfiguration.

**`tauri-staging.yml` never regenerates `latest.json`.** `tauri-build.yml`
gained a "Fix latest.json (macOS) and publish" job; staging did not. Its
manifest is whatever tauri-action produced before the Finder extension was
embedded and the app re-signed.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Audience | Public opt-in, behind an explainer modal | Willing testers get early access; the general public is not pointed at internal work |
| Switch target | Beta, never staging | Staging stays the internal gate it is today |
| Return path | Symmetric, guarded on a state epoch | See "The guard" — a version-based guard would be a one-way door |
| Signing | One key for all three channels | Removes the merge hazard entirely instead of working around it |
| Versioning | Prerelease semver per channel | Semver already orders the channels correctly, and a version string names its lane |
| Console | One console; keep the runtime override | Staging's separate console was the only channel-dependent behaviour in the app |

## 1. Release topology

Three lanes, promoted by squash at each hop. `main` keeps requiring linear
history, so beta to main stays a squash, exactly as staging to main is today.

```
staging  (internal)  ->  beta  (public opt-in)  ->  main  (production)
```

| Branch | Audience | Version | Tag | Release |
|---|---|---|---|---|
| `staging` | internal only | `0.5.0-dev.N` | `v<version>-staging` | prerelease |
| `beta` | public opt-in | `0.5.0-beta.N` | `v<version>` | prerelease |
| `main` | production | `0.4.0` | `v<version>` | latest |

Semver orders these correctly without help: `0.4.0 < 0.5.0-beta.1 < 0.5.0`. A
production user switching to beta sees a genuine upgrade, and when beta is
promoted as `0.5.0` it supersedes every `0.5.0-beta.N` the fleet is running.
A build also reports a version that says which lane produced it, which is what
makes a bug report answerable.

### The beta manifest needs a fixed URL

Production's endpoint works because GitHub resolves `releases/latest` to the
newest non-prerelease. Beta releases are prereleases and each carries its own
tag (`v0.5.0-beta.3`), so there is no stable URL to point an updater at.

One permanent prerelease tagged `beta` holds a single asset, `latest.json`,
overwritten by every beta build. The endpoint is
`releases/download/beta/latest.json`; the manifest's `url` fields point at the
real versioned release assets. Production's endpoint is unchanged.

### Workflow changes

- **New** `tauri-beta.yml`: `tauri-staging.yml` with the signing-key patch step
  removed, the beta tag scheme, the `latest.json` fix job that production
  already has, and one step to republish the rolling `beta` manifest.
- **`tauri-staging.yml`**: drop the `use-staging-updater-key.sh` step; add the
  `latest.json` fix job.
- **Delete** `scripts/use-staging-updater-key.sh`.
- **Retire secrets** `TAURI_SIGNING_PRIVATE_KEY_STAGING`,
  `TAURI_SIGNING_PRIVATE_KEY_STAGING_PASSWORD`, `TAURI_UPDATER_PUBKEY_STAGING`.
  Every lane signs with `TAURI_SIGNING_PRIVATE_KEY`.
- `tauri.conf.json` carries one pubkey on every branch, with no build-time
  patch. This supersedes the "do not reintroduce a branch-specific pubkey" rule
  in `docs/release-channels.md` by removing the thing the rule guarded.

Migration cost: a tester on a build signed with the old staging key cannot
auto-update onto the new key and installs one DMG by hand. The same thing
happened when the lanes moved repositories.

## 2. Channel identity and the switch

New backend module `src-tauri/src/release_channel.rs`.

`shares/commands.rs` loses `ReleaseChannel`, `STAGING_CONSOLE_BASE_URL`
(`:42`), and the channel arm of `resolve_console_base_url` (`:96`). It keeps one
console constant and `honors_console_override`, which still needs to tell a dev
build from a production release binary.

The new module reads `option_env!("HIPPIUS_RELEASE_CHANNEL")` — unset to
Production, `beta` to Beta, `staging` to Staging — parsing fail-safe to
Production, as the existing code already does. Each channel carries its
endpoint.

### There is no persisted channel preference

After a switch installs, the running binary **is** the target channel, compiled
in. A beta build checks the beta endpoint because that is what it was built as.
Nothing can drift out of sync, and nothing in a bundled `.env` can lie about it
— the same property that made the compile-time console channel trustworthy.

### Two commands

```rust
switch_release_channel(app, target: Channel) -> Result<()>
release_channel_status(app) -> Result<ChannelStatus>
```

`switch_release_channel` refuses `Staging` outright, builds an updater with
`.endpoints(vec![target.manifest_url()])`, downloads, installs, and relaunches
through `tauri-plugin-process` (already a dependency, `Cargo.toml:113`).

`version_comparator` is needed for one direction only. Production trails beta by
design, so beta `0.5.0-beta.3` to production `0.4.0` is a downgrade the default
comparator rejects. The permissive comparator applies **only** to an explicit
user-initiated switch; routine checks within a channel keep the strict default,
so a beta build never silently walks backwards.

`release_channel_status` reports the running channel and the target's published
version, so the UI can name what it is about to install.

## 3. User interface

The address menu is `ProfileCard.tsx` (sidebar footer): Copy address, View on
Hipstats, Update App, Settings, Log out. Settings routes to
`/settings?section=<id>`, with the section list in `SettingsSidebar.tsx`.

Two surfaces:

- **`Explore Beta` in the address menu**, beside Update App, opening the
  explainer modal directly. On a beta build the item reads **`Leave Beta`**, so
  the label never describes the wrong action.
- **An `updates` settings section**, added through `filterSettingsNavItems`
  rather than hard-coded, showing the running channel and version and offering
  the way back.

The section is built to match `AppearanceSettings.tsx`, the closest precedent: a
`SettingsCard` wrapping the shared `SegmentedControl`, with a sonner toast on
change and styling inherited from `ThemedToaster` rather than per-call
`classNames`. Theme comes from `useAppTheme()`; raw CSS keys off `.dark`, never
`prefers-color-scheme`.

The existing **Update App** item and its `UpdateDialog` stay as they are. That
dialog installs the current channel's latest build; the new surfaces choose
which channel you are on. Keeping them separate keeps each one's message simple.

## 4. The modal, the guard, and failures

### The modal

Opened by `Explore Beta`. It says the beta channel follows the development work:
you get the newest features first, and those features are not fully stabilized.
It names the exact version it will install (from `release_channel_status`),
states that the app will restart, and starts no download until confirmed. Built
from the app's existing dialog primitives so it matches every other modal.

`Leave Beta` gets its own, shorter modal. Returning to the stable channel needs
a restart notice, not a warning.

### The guard

The obvious guard — refuse the return if local state was written by a newer
build than the target — does not work here. Under this versioning production
*always* trails beta, so a guard comparing app versions would refuse every
return, permanently.

What needs guarding is a **breaking state change**, not a version difference.
So: a `STATE_EPOCH` constant in Rust, bumped by hand only when a change lands
that an older build cannot read. Each build stamps it into `user_preferences` at
launch, and the beta workflow writes it into the channel manifest beside the
version. `release_channel_status` already fetches that manifest for the version,
so comparing epochs costs nothing extra.

- Equal epochs: switch freely.
- Target epoch below the local stamp: refuse, name the reason, and tell the user
  to wait for the production release.

The SQLite database is copied aside before either switch, so a build that cannot
read its state has a recovery path.

### Failures

Every failure degrades to "nothing happened". A manifest that will not fetch, a
signature that will not verify, a download that fails, or a refusal from the
guard all leave the running build untouched and surface a typed `AppError` the
settings section renders in place.

## 5. Testing

Pure decisions split from I/O and unit-tested on every platform, following the
convention `hosting` and `path_is_translocated` already set.

**Rust**

- `parse_release_channel` — unset, empty, and typo all resolve to Production;
  the new `beta` arm resolves to Beta.
- `manifest_url` per channel, so a mistyped endpoint fails a test.
- `downgrade_is_safe(local_epoch, target_epoch)` — including the case that
  motivated the epoch design: beta `0.5.0-beta.3` to production `0.4.0` with
  equal epochs **must be allowed**. A guard that refuses every return is the
  failure being tested against.
- `switch_release_channel` refuses `Staging`.
- A wire-shape pin for `release_channel_status`. Every IPC type crossing the
  boundary gets one, because there is no codegen to catch drift.

**The console change gets its own regression test**: a staging-channel build
resolves to `console.hippius.com`. Deleting a branch is the kind of change that
silently comes back. The existing `resolve_console_base_url_is_idempotent`
proptest stays; the staging arm's tests go with the arm.

**Frontend**

- `ProfileCard` — the item reads `Explore Beta` on production and `Leave Beta`
  on beta, opens the modal, and fires **no IPC until confirm**.
- A content pin on the modal copy asserting it names the instability, the way
  `FinderExtensionGuard.test.tsx` pins "File Providers". Without it a copy edit
  can quietly turn a warning into marketing.
- A source-wiring pin that the settings section is registered in
  `SettingsSidebar`, matching the existing "is mounted in AppShell" idiom.

**Release plumbing**

- `actionlint` and `zizmor` cover `tauri-beta.yml` through the existing CI job.
- A pin that the version in `tauri.conf.json`, `Cargo.toml`, and `package.json`
  agree. `CLAUDE.md` requires it and nothing enforces it today.

**What no test covers** is the cross-channel install itself: signature
verification against a real manifest, and the relaunch. That is a manual pass on
a real beta release and belongs in `docs/release-checklist.md` rather than being
assumed.

## Documentation to update

- `docs/release-channels.md` — three lanes, the one-key model, the retired
  secrets, and the beta manifest tag.
- `docs/release-checklist.md` — the manual cross-channel install pass.
- `CLAUDE.md` — the release-channels section names two branches and the staging
  pubkey patch; both change.
- `.claude/rules/shares-and-shared-drives.md` — the compile-time console channel
  paragraph.

## Open items

- Whether `staging` keeps its rolling `v<version>-staging` tag or moves to a tag
  per build. Nothing switches into staging, so its updater does not have to
  work; the rolling tag is cheaper and is assumed here.
- The first `STATE_EPOCH` value and where it is stamped. Assumed 1, stamped at
  launch beside the other `user_preferences` writes.
