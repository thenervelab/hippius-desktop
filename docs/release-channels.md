# Release channels

Hippius Desktop ships from **one repository** — `thenervelab/hippius-desktop` —
on two lanes:

| Lane | Branch | Workflow | Produces | Marked latest |
| --- | --- | --- | --- | --- |
| Preview | `staging` | `tauri-staging.yml` | `v<version>-staging` prerelease, macOS + Linux + Windows | No |
| Production | `main` | `tauri-build.yml` | `v<version>` release, macOS + Linux + Windows | Yes |

Both lanes publish on **push**. There is no "build without releasing" mode: a
push to `main` cuts a production release, which is why `staging` is the
validation gate and `main` is only ever merged into deliberately.

The one exception is a push that cannot change the artifact. Both workflows
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
are gone — see "Why there is no longer a per-branch pubkey" below.

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

## Cutting a production build

Open `staging` → `main` as a PR and **squash-merge** it. The `main` ruleset
requires linear history, so a merge commit is rejected.

The push to `main` then:

1. builds a **draft** `v<version>` release across the three platforms;
2. on macOS runs `macos/finalize-macos-release.sh` — build the universal
   `.appex`, embed + inside-out re-sign, notarize, staple, rebuild the DMG and
   the updater tarball;
3. runs `publish-release`, which merges the `darwin-aarch64` / `darwin-x86_64`
   entries into `latest.json` (tauri-action omits them because macOS is built
   `--bundles app`) and only then flips `--draft=false --latest`.

Before announcing, confirm an already-installed copy is actually offered the
update. That is the one check that would catch a signing-key mistake.

## Why there is no longer a per-branch pubkey

The two lanes sign updates with **different minisign keys**:

| Channel | Private key secret | Public key |
| --- | --- | --- |
| Production | `TAURI_SIGNING_PRIVATE_KEY` | `E411FB37072F234F` — committed in `tauri.conf.json` |
| Staging | `TAURI_SIGNING_PRIVATE_KEY_STAGING` | `764AD1FE0D96ABE7` — `TAURI_UPDATER_PUBKEY_STAGING` secret |

The staging keypair was regenerated on 2026-08-27 during the move to this
repository. The previous staging key (`2FCA9B90D579C26E`) lived only inside the
old private repo's `TAURI_SIGNING_PRIVATE_KEY` secret, and GitHub does not let a
secret be read back, so it could not be carried across. The consequence is
limited to the staging channel: a tester still running a build signed with the
old key cannot auto-update and installs the next DMG once. Production was never
involved.

While the lanes lived in separate repositories, the staging branch simply
carried the staging pubkey in `tauri.conf.json`. In one repository that would be
a merge hazard with a silent, delayed failure: a `staging` → `main` merge
carrying the staging key would ship a production release whose update signature
fails against every installed copy, and nothing would report it — users would
just quietly stop receiving updates.

So the tree carries the **production** pubkey on every branch, and
`scripts/use-staging-updater-key.sh` patches the staging key in at build time,
in the staging workflow only. It fails closed if
`TAURI_UPDATER_PUBKEY_STAGING` is unset, because an empty pubkey would produce a
build that accepts unverifiable updates.

**Do not reintroduce a branch-specific pubkey.** If a third channel is ever
needed, give it its own key and its own build-time patch step.

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

Shared by both: `HCFS_DEPLOY_KEY_B64` (read access to the private `thenervelab/hcfs`),
`TAURI_ENV_FILE` (full contents of `src-tauri/.env`, and it **must** carry
`INDEXER_API_KEY` — `scripts/write-tauri-env.sh` fails the build otherwise,
because a missing key makes every indexer-backed screen render a confident zero
instead of an error), and the six `APPLE_*` secrets for signing + notarization.

Production only: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Staging only: `TAURI_SIGNING_PRIVATE_KEY_STAGING`,
`TAURI_SIGNING_PRIVATE_KEY_STAGING_PASSWORD`, `TAURI_UPDATER_PUBKEY_STAGING`.

A staging build with no App Store Connect key still succeeds, but it embeds
**no Finder extension** and is unsigned. That is deliberate — staging is also
used to test everything unrelated to Finder — and it is announced loudly: a
`::error::` annotation, ` - NO FINDER EXTENSION` appended to the release name,
and a warning block in the release body. Do not use such a build to test
"Share with Hippius".
