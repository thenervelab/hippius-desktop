# Release channels

Hippius Desktop ships from **one repository** — `thenervelab/hippius-desktop` —
on three lanes, promoted by squash at each hop:

```
staging (internal) -> beta (public opt-in) -> main (production)
```

| Lane | Branch | Workflow | Version | Produces | Marked latest |
| --- | --- | --- | --- | --- | --- |
| Preview | `staging` | `tauri-staging.yml` | `0.5.0-dev.N` | `v<version>-staging` prerelease | No |
| Beta | `beta` | `tauri-beta.yml` | `0.5.0-beta.N` | `v<version>` prerelease | No |
| Production | `main` | `tauri-build.yml` | `0.4.0` | `v<version>` release | Yes |

Versions carry a prerelease suffix per lane so semver orders them without help:
`0.4.0 < 0.5.0-beta.1 < 0.5.0`. Switching between channels is therefore a
genuine upgrade in both directions of travel, and a version string names the
lane that produced it. Only `staging` adds a tag suffix; a beta version already
carries one.

All three lanes publish on **push**. There is no "build without releasing" mode:
a push to `main` cuts a production release, which is why `staging` is the
validation gate and `main` is only ever merged into deliberately.

Users opt into beta from **Explore Beta** in the app's address menu, which
installs this lane's build and restarts. Staging is internal only — nothing
switches into it, so it publishes no update manifest at all.

The one exception is a push that cannot change the artifact. All three workflows
carry a `paths-ignore` denylist — markdown anywhere, `docs/`, `.claude/`,
`.vscode/`, `.gitignore`, `.git-blame-ignore-revs` — so a docs-only commit cuts
no release. Everything else builds, `.github/**` included, so a workflow edit is
always exercised on the branch it ships from. It is a **denylist on purpose**: a
path nobody thought to list still ships, because the cost of a missing entry
should be one wasted build rather than a release that silently never happens.

`workflow_dispatch` ignores path filters, so running either workflow by hand is
the escape hatch when a skipped push does need a release cut.

This replaces `STAGING_BUILD.md`, which existed while preview builds were cut
from a separate private repository (`hippius-desktop-internal`) and listed the
divergences that had to be reverted by hand before every sync. Those divergences
are gone — see "One updater key for every lane" below.

## Cutting a preview build

1. Merge your work into `staging` (PR, as normal).
2. Bump `version` in **all three** files — they must agree:
   - `src-tauri/tauri.conf.json` — the canonical one; every workflow reads it
     with `jq -r .version`, and tauri-action expands `v__VERSION__` from it
   - `src-tauri/Cargo.toml` (and let `Cargo.lock` follow)
   - `package.json`
3. Push. `publish-staging` runs three independent jobs (macOS, Linux, Windows)
   that all upsert the same `v<version>-staging` prerelease.

If the version is not bumped, the jobs upload into the **previous** release
instead of creating a new one.

`src-tauri/Info.plist` is deliberately excluded from the bump: it carries no
`CFBundleShortVersionString` (Tauri generates that from `tauri.conf.json`), and
its `CFBundleVersion` stays pinned at `1` because macOS orders that key
component-wise and `0.4.0` would sort *below* the `1` every shipped build
carries. `tests/bundle_metadata_pin.rs` enforces both halves.

## Promotion order is enforced

Code reaches users in one direction, and `promotion-order.yml` fails any PR into
`beta` or `main` whose head does not already contain the previous lane:

```
staging (internal) -> beta (public opt-in) -> main (production)
```

It catches three things nothing else would, because all three produce a PR that
looks ordinary and a release that builds and publishes:

1. **Skipping a lane** — a branch merged straight into `main` reaches every user
   without ever having been a beta build.
2. **Promoting a subset** — a promotion opened from a topic branch instead of
   from the previous lane carries only that branch's work and silently leaves
   the rest of the lane behind.
3. **Squashing a `staging` → `beta` promotion** — see below.

A deliberate hotfix straight to `main` is possible: label the PR
`skip-promotion-order` and say why in its description. The label is the audit
trail, which a bypassed branch rule would not be.

### `staging` → `beta` is a MERGE. `beta` → `main` is a SQUASH.

The asymmetry is load-bearing, not an inconsistency.

`main` requires linear history, so the last hop has to be squashed — and nothing
is promoted past `main`, so the squash costs nothing.

`beta` must NOT be squashed into. A squash commit is not a descendant of
`staging`'s history, so the merge base between the two branches never advances.
Every later promotion then replays the same commits as conflicts, and the set
grows with each one. Merge `staging` into `beta` instead and the merge base
tracks along as it should.

Expect **one conflict on every promotion**: the three version files. That is
working as intended — it is where you choose the new `-beta.N`, rather than
letting `staging`'s `-dev.N` flow into a lane that publishes to users.

## Cutting a beta build

1. Open `staging` → `beta` as a PR and **merge** it (not squash — see above).
2. Bump the version to the next `-beta.N` in the same three files. Reusing a
   version means the jobs upload into the previous release instead of creating
   a new one, and beta users are never offered the build.
3. Push. `publish-beta` runs the three platform jobs, then **assemble → verify
   → publish**: `assemble-release` corrects `latest.json` for macOS and names
   the downloads, `verify-release` downloads the draft's own assets and opens
   them, and `publish-release` flips the versioned release out of draft and
   republishes the manifest to the fixed `beta-channel` tag.

Nothing reaches a beta user until all three succeed. The versioned release
stays a **draft** throughout, mirroring the production lane: macOS is built
`--bundles app`, so until the finalize step runs the release carries no DMG at
all and a published one would be indistinguishable from a good build.
`assemble-release` also fails rather than publish a manifest with no macOS
signature, which would offer beta users an update they cannot verify, and
`verify-release` fails rather than publish artifacts it could not confirm are
signed, notarized, stapled and carrying the Finder extension.

## Cutting a production build

Open **`beta`** → `main` as a PR and **squash-merge** it. The `main` ruleset
requires linear history, so a merge commit is rejected.

It is `beta` → `main`, not `staging` → `main`: production is the lane after
beta, and `promotion-order.yml` fails a PR into `main` that does not contain
`beta`. Bump the version out of its `-beta.N` prerelease to the plain release
number in the same PR — `0.5.0-beta.4` becomes `0.5.0`, which semver already
orders above every beta that preceded it.

The push to `main` then:

1. builds a **draft** `v<version>` release across the three platforms;
2. on macOS runs `macos/finalize-macos-release.sh` — build the universal
   `.appex`, embed + inside-out re-sign, notarize, staple, rebuild the DMG and
   the updater tarball;
3. runs `assemble-release`, which merges the `darwin-aarch64` /
   `darwin-x86_64` entries into `latest.json` (tauri-action omits them because
   macOS is built `--bundles app`) and names the per-platform downloads;
4. runs `verify-release`, which downloads the draft's own assets and opens
   them — Finder extension embedded, notarized, stapled, universal, version
   matching the tag, updater signature verifying against the committed pubkey,
   and `latest.json` naming assets the release actually carries;
5. only then runs `publish-release`, which flips `--draft=false --latest`.

Before announcing, confirm an already-installed copy is actually offered the
update. That is the one check that would catch a signing-key mistake.

## One updater key for every lane

Every lane signs with `TAURI_SIGNING_PRIVATE_KEY`, and `tauri.conf.json` carries
the one matching pubkey on every branch. No workflow patches it.

That is what lets a build verify **another** channel's manifest, which the
in-app channel switch depends on: a production install has to accept a beta
update and vice versa. It also removes, rather than works around, the hazard the
previous design managed. A per-branch pubkey was safe only while the lanes lived
in separate repositories; in one repository a `staging` → `main` merge carrying
the staging key would ship a production release whose update signature fails
against every installed copy, with nothing reporting it — users would simply
stop receiving updates.

Staging previously had its own keypair and `scripts/use-staging-updater-key.sh`
patched it in at build time. Both are gone. `tests/release_lane_pins.rs` fails
if any workflow reintroduces `TAURI_SIGNING_PRIVATE_KEY_STAGING` or
`TAURI_UPDATER_PUBKEY_STAGING`, and separately pins the committed pubkey value
itself. Both halves are needed: the key that shipped wrong was edited straight
into `tauri.conf.json`, not patched by a workflow. A wrong key is unrecoverable
rather than merely broken — it is compiled into the binary, so no later release
can reach an install that already has it, and a manual reinstall is the only
way back.

**Migration cost, once:** a tester on a build signed with the retired staging
key cannot auto-update onto the new one and installs the next DMG by hand. That
is the same one-time cost the move to this repository already imposed, and it
lands on staging only — a lane whose testers install DMGs by hand anyway.

## How each lane's updater is wired

`ReleaseChannel::manifest_url()` in `src-tauri/src/release_channel.rs` is the
single source of these URLs.

| Channel | Manifest |
| --- | --- |
| Production | `releases/latest/download/latest.json` |
| Beta | `releases/download/beta-channel/latest.json` |
| Staging | none — `manifest_url()` returns `None` |

The beta manifest needs a **fixed** tag because every beta release carries its
own version tag and GitHub's `releases/latest` resolves only to a
non-prerelease, so neither addresses "the newest beta". `tauri-beta.yml`'s
`publish-release` job overwrites one asset — `latest.json` — on a permanent
prerelease tagged **`beta-channel`**, which holds no build assets of its own;
the manifest's `url` fields address the real versioned release.

The tag is `beta-channel` and **not** `beta`: a tag sharing the branch name
makes `git push origin beta` fail with `src refspec beta matches more than one`
for every developer and `git checkout beta` ambiguous — breaking the very
promotion flow the lane exists for. `tests/release_lane_pins.rs` derives the tag
from `manifest_url()` and asserts the workflow writes to that same tag, because
a drift there leaves `publish-release` succeeding while beta builds check a URL
nobody publishes to.

The check itself runs in **Rust** (`src-tauri/src/updates.rs`), not through
`@tauri-apps/plugin-updater`'s JS `check()`. That one reads the single
`plugins.updater.endpoints` list compiled into `tauri.conf.json`, and
`CheckOptions` cannot override it — so a beta build would ask the production
lane. With one shared signing key that manifest verifies and installs, which is
a silent wrong-lane install rather than a missing feature.

Staging returns `None` deliberately, and that closes a live bug rather than
merely declining a feature. Staging used to be handed its own updater pubkey
while keeping the **production** endpoint, so every check fetched the production
manifest and failed signature verification — which the updater reports as "no
update available", not as a misconfiguration. Staging builds could therefore
never auto-update, and nothing said so.

`tauri-beta.yml` also **fails the build** without App Store Connect credentials,
where `tauri-staging.yml` only annotates. Staging tolerates a DMG with no Finder
extension because it is used to test much else and its testers can be told; a
beta user cannot be told, would meet an unsigned build at Gatekeeper and a
missing "Share with Hippius", and would report both as product bugs.

## Every channel mints share links at the production console

`console.hippius.com`, on every lane. Staging used to default to
`console.hippicode.com`, and that made the console the ONLY behaviour differing
between lanes — every backend the app talks to is identical on all of them
(`api.hippius.com` in `api/client.rs`, `auth/service.rs` and `auth/oauth.rs`;
the HCFS server const). The staging console was therefore a different front end
onto the same data, and the split bought nothing except a link a recipient could
not open from a production session.

`tauri-staging.yml` still sets `HIPPIUS_RELEASE_CHANNEL: staging` on the build
step. That **compile-time** `option_env!` now lives in
`src-tauri/src/release_channel.rs` — it moved out of `shares/commands.rs` once it
had consumers beyond the console — and it decides one thing here: whether the
build honors a runtime `HIPPIUS_CONSOLE_BASE_URL` override.

| Build | Honors the override |
|---|---|
| local dev (`pnpm tauri:dev`) | yes |
| staging | yes |
| beta | no |
| production | no |

Beta sits with production rather than with staging on purpose: it is a public
lane shipped to real users, so a link it mints has to go where the user expects.

Compile-time is deliberate: an `.env` line is a file that can be copied between
lanes, whereas a build-step env var cannot leave the workflow that sets it.

Corollary for local work: point a dev build at another console by putting
`HIPPIUS_CONSOLE_BASE_URL=…` in your own `src-tauri/.env`.

## Secrets each lane needs

Shared by all three: `HCFS_DEPLOY_KEY_B64` (read access to the private `thenervelab/hcfs`),
`TAURI_ENV_FILE` (full contents of `src-tauri/.env`, and it **must** carry
`INDEXER_API_KEY` — `scripts/write-tauri-env.sh` fails the build otherwise,
because a missing key makes every indexer-backed screen render a confident zero
instead of an error), and the six `APPLE_*` secrets for signing + notarization.

Also shared by all three: `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. There are no per-lane signing secrets —
`TAURI_SIGNING_PRIVATE_KEY_STAGING`, `TAURI_SIGNING_PRIVATE_KEY_STAGING_PASSWORD`
and `TAURI_UPDATER_PUBKEY_STAGING` are retired and can be deleted from the
repository.

A **staging** build with no App Store Connect key still succeeds, but it embeds
**no Finder extension** and is unsigned. That is deliberate — staging is also
used to test everything unrelated to Finder — and it is announced loudly: a
`::error::` annotation, ` - NO FINDER EXTENSION` appended to the release name,
and a warning block in the release body. Do not use such a build to test
"Share with Hippius".

A **beta** build in the same situation fails the job instead. See the last
paragraph of "How each lane's updater is wired" for why the trade differs.
