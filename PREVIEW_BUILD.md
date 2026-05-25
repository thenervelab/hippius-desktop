# PREVIEW BUILD MARKER — DO NOT MERGE TO PUBLIC `hippius-desktop` AS-IS

This file exists **only on the `redesign-preview` branch** of the internal
repository (`thenervelab/hippius-desktop-internal`). It marks two divergences
from the public `hippius-desktop` repo that must be reverted before any merge
back to the public repo:

1. **`src-tauri/tauri.conf.json` → `plugins.updater.pubkey`** is the
   preview-build minisign public key, not the production one.

   - Production pubkey (restore this before merging to public repo):
     ```
     dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEU0MTFGQjM3MDcyRjIzNEYKUldSUEl5OEhOL3NSNUdYMmxpUG1WUWtiTWd1TDRjMkt6aXBveFdmYmx3TjJTd01UUW1IMmJGZUgK
     ```
   - The matching production private key lives in the public repo's
     `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret. Do not touch that one.

2. **GitHub Actions secrets in the internal repo** are a separate keyset from
   the public repo. The four secrets the `publish-preview` workflow expects:
   - `HCFS_DEPLOY_KEY_B64` — base64 of an SSH deploy key with read access to
     `thenervelab/hcfs`.
   - `TAURI_ENV_FILE` — full contents of `src-tauri/.env`.
   - `TAURI_SIGNING_PRIVATE_KEY` — the **preview** minisign private key whose
     public counterpart is the value in `tauri.conf.json` above.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — password for that key (empty
     string if generated without one).

## Before merging `redesign-preview` back to the public repo

Run this from the merge-target branch:

```sh
grep -RIn "REPLACE_WITH_PREVIEW_PUBKEY_BEFORE_PUSHING\|PREVIEW BUILD MARKER" . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target --exclude-dir=out
```

If anything comes back:

1. Restore `src-tauri/tauri.conf.json` `pubkey` to the production value above.
2. Delete this file (`PREVIEW_BUILD.md`).
3. Decide whether `.github/workflows/tauri-preview.yml` should also be dropped
   (the public repo has its own `tauri-build.yml` and `tauri-dev.yml`; the
   preview workflow is internal-only).
