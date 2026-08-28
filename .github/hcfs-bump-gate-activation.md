# HCFS bump-gate — activation runbook

The dependency-bump safety net (`.github/workflows/ci.yml` + `.github/workflows/hcfs-bump.yml`)
is **built but not yet deployed**. This file is the prep/runbook for turning it on; it
deliberately changes nothing on the remote (the maintainer flips it when ready).

## What the gate is

- **`hcfs-bump.yml`** — weekly (Mon 06:00 UTC) + manual workflow. Resolves `thenervelab/hcfs`
  `main` HEAD over SSH, and when it differs from the pinned rev, `sed`-updates both
  `hcfs-client` + `hcfs-shared` revs in `src-tauri/Cargo.toml`, `cargo update`s the lock, and
  opens a PR.
- **`ci.yml`** — runs on every PR + pushes to `main`/`redesign`. `rust` job (macOS): `clippy
  -D warnings` + `cargo test` (blocking). `frontend` job (ubuntu): `pnpm lint` + `pnpm test`
  (blocking). The Rust job is what executes the wire-contract guards below, so a breaking bump
  fails the PR instead of shipping.

## What the guards cover (as of this branch)

The Rust suite the gate runs now pins every foreign hcfs type that crosses the Tauri IPC
boundary to the frontend, plus the at-rest crypto format:

| Guard | Location | Catches |
|-------|----------|---------|
| `snapshot_wire_pins_full_json_key_set` (+ `fixture_snapshot` literal) | `sync/tauri_bridge.rs` | `SyncSnapshot` 32-key flatten drift |
| `synced_file_detail_pins_file_action_wire_strings` | `sync/events.rs` | `FileAction` wire strings |
| `conflicts_pending_pins_staged_changes_wire_keys` | `sync/events.rs` | `StagedChanges` keys |
| `desktop_event_payload_key_sets_are_pinned`, `drive_status_pins_tagged_wire_shape`, `file_failure_kind_payload_pins_tagged_wire_shape` | `sync/events.rs` | desktop event payloads |
| `remote_file_info_pins_wire_shape` | `sync/remote.rs` | `RemoteFileInfo` (RemoteFolderBrowser) |
| `sync_engine_health_pins_wire_shape`, `connectivity_status_pins_wire_strings` | `sync/status.rs` | `SyncEngineHealth` / `ConnectivityStatus` (connection indicator — a rename would HIDE an outage) |
| `share_progress_pins_wire_shape`, `share_phase_pins_wire_strings` | `shares/commands.rs` | `ShareProgress` / `SharePhase` (share progress bar) |
| `user_file_entry_pins_camel_case_wire` | `sync/files.rs` | `UserFileEntry` (file listings; `type`/`fileId` keys) |
| `grouped_listing_pins_mixed_case_wire` | `sync/files.rs` | `GroupedListing`/`FileEntry` mixed-case split (nested folder view) |
| `folder_hash_is_pinned`, `derive_folder_mnemonic_is_pinned`, `derive_encryption_key_is_pinned` (+ format/determinism proptests) | `tests/hcfs_contract.rs` | key/identity derivation drift |
| `at_rest_decrypt_frozen_ciphertext_is_pinned`, `at_rest_round_trips_any_plaintext` | `tests/hcfs_contract.rs` | XChaCha20-Poly1305 at-rest format change → existing user files undecryptable |

## What the guards do NOT cover — run the live lane on every bump

The table above is all hermetic: it pins wire shapes and known-answer derivations, so it
catches a *type* or *format* change. It cannot catch a **behavioral** change in
`hcfs-client` against a real server — a status code that moved, an error string the desktop
classifies on, an arbiter that stopped confirming. That class is only caught by the
`*_real_backend.rs` suites, and exactly that happened once already: the shared-drives
revocation marker had no live producer at pin `3ff8e9f` (every hermetic test green), and
the pin bump to `ab4b5cd` that fixed it was verified only by re-running the live suite.

So: **on every `hcfs` pin bump PR, run `.github/workflows/e2e-live.yml` against the bumped
branch before merging.**

```bash
gh workflow run e2e-live.yml --ref automated/hcfs-bump -f suite=both
```

It is a manual workflow (no cron, not a required check) and it needs the live-account
secrets listed in its header. It sets `HCFS_DESKTOP_E2E_REQUIRE=1`, so a missing secret
fails the run instead of skipping the tests green.

Same default-branch prerequisite as step 1 below: `workflow_dispatch` resolves
`e2e-live.yml` **by path on the default branch**, so `--ref automated/hcfs-bump` runs the
bump branch's *code* but only once the workflow file itself exists on `main`. Until then
the dispatch fails with "workflow does not exist".

## Activation steps (run when ready — none done yet)

1. **Push the gate to `main`.** `ci.yml` must exist on `main` because `hcfs-bump.yml` opens its
   PR against the default branch (`base: main`); the PR's CI run uses the workflow as it exists
   on the base. Until then the gate runs nowhere (`gh run list` shows it has never executed).

2. **Add the `HCFS_BUMP_TOKEN` PAT.** A PR opened with the default `GITHUB_TOKEN` does **not**
   trigger other workflows (GitHub's documented anti-recursion rule), so the bump PR would open
   green with CI never running. Create a fine-grained PAT scoped to this repo with
   `contents: write` + `pull-requests: write`, then:
   ```bash
   gh secret set HCFS_BUMP_TOKEN --body '<pat>'
   ```
   `hcfs-bump.yml` already reads `${{ secrets.HCFS_BUMP_TOKEN || github.token }}`.

3. **Make the `rust` job a required status check.** Branch-protect `main` so the `rust` check
   must pass before merge. Without this, an *un-triggered* check reads as green-by-omission and
   a bump PR could be merged with no Rust run at all.

4. **Smoke-test the loop once.** Trigger `hcfs-bump.yml` via `workflow_dispatch` and confirm the
   `automated/hcfs-bump` PR shows the `rust` check **running and visible** before trusting the
   Monday cron. (When pinned == `main` HEAD the workflow correctly no-ops and opens no PR.)

## Notes

- `ci.yml` `push` branches are `[main, redesign]`; the `automated/hcfs-bump` branch relies on the
  `pull_request` trigger (step 2), not push, so the PAT is the load-bearing fix.
- The frontend `pnpm test` job is **not** part of the hcfs-bump defense — the bump reaches the FE
  only through Rust serde shapes, which Vitest never exercises. The `rust` job is the sole line of
  defense for wire-shape drift.
