# STAGING BUILD MARKER — DO NOT MERGE TO PUBLIC `hippius-desktop` AS-IS

This file exists **only on the `staging` branch** of the internal repository
(`thenervelab/hippius-desktop-internal`). It marks the divergences from the
public `hippius-desktop` repo that must be reverted before any merge back to
the public repo.

> Renamed from `redesign-preview` / `PREVIEW_BUILD.md` on 2026-08-07. `staging`
> is now the single branch that builds the dev/tester version: pushing to it
> runs `.github/workflows/tauri-staging.yml` (`publish-staging`), which
> publishes a prerelease tagged `v<version>-staging` for macOS, Linux and
> Windows.

## Divergences from the public repo

1. **`src-tauri/tauri.conf.json` → `plugins.updater.pubkey`** is the
   staging-build minisign public key, not the production one.

   - Production pubkey (restore this before merging to the public repo):
     ```
     dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEU0MTFGQjM3MDcyRjIzNEYKUldSUEl5OEhOL3NSNUdYMmxpUG1WUWtiTWd1TDRjMkt6aXBveFdmYmx3TjJTd01UUW1IMmJGZUgK
     ```
   - The matching production private key lives in the public repo's
     `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret. Do not touch that one.

2. **The staging console URL.** `tauri-staging.yml` appends
   `HIPPIUS_CONSOLE_BASE_URL=https://console.hippicode.com` to `src-tauri/.env`
   in all three build jobs, so share links from a staging build point at the
   staging console. This must never be ported to `redesign` or `main` — which
   is why the workflow file exists on this branch only.

3. **GitHub Actions secrets in the internal repo** are a separate keyset from
   the public repo. The four secrets `publish-staging` expects:
   - `HCFS_DEPLOY_KEY_B64` — base64 of an SSH deploy key with read access to
     `thenervelab/hcfs`.
   - `TAURI_ENV_FILE` — full contents of `src-tauri/.env`.
   - `TAURI_SIGNING_PRIVATE_KEY` — the **staging** minisign private key whose
     public counterpart is the value in `tauri.conf.json` above.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — password for that key (empty
     string if generated without one).

## Cutting a staging build

1. Merge `redesign` into `staging` — never the other way. `staging` carries
   work that does not exist on `redesign` (the Linux and Windows shell-share
   integration), and this workflow is staging-only.
2. Bump `version` in **`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`**.
   `package.json` is deliberately left alone.
3. Push. That triggers `publish-staging`, and all three platform jobs upsert
   the same `v<version>-staging` release.

If the version is not bumped, the jobs upload into the previous release instead
of creating a new one.

## Before merging `staging` back to the public repo

Run this from the merge-target branch:

```sh
grep -RIn "REPLACE_WITH_PREVIEW_PUBKEY_BEFORE_PUSHING\|STAGING BUILD MARKER" . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target --exclude-dir=out
```

If anything comes back:

1. Restore `src-tauri/tauri.conf.json` `pubkey` to the production value above.
2. Delete this file (`STAGING_BUILD.md`).
3. Decide whether `.github/workflows/tauri-staging.yml` should also be dropped
   (the public repo has its own `tauri-build.yml` and `tauri-dev.yml`; the
   staging workflow is internal-only).
