---
paths:
  - "src-tauri/tests/**"
  - "e2e/**"
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/__tests__/**"
  - ".github/workflows/*.yml"
  - "docs/testing-policy.md"
---

# Testing

**Which layer a new test belongs in** is [`docs/testing-policy.md`](../../docs/testing-policy.md): lowest layer that can fail for the same reason a user would notice. This file is the inventory of suites, live-lane env, replay harnesses, and wire-pin tables.

## Test files in `src-tauri/tests/`

`auth_commands.rs`, `auth_tokens.rs`, `blockchain_commands.rs`, `crypto_migration.rs`, `file_commands.rs`, `local_db_commands.rs`, `migration_server_mock.rs`.

- `hippius_folder_entries_backfill.rs` — folder-entity backfill: pins the spawn wiring + cache/flag behavior, hermetic.
- `folder_entries_real_backend.rs` — `#[ignore]` live lane: drives the REAL desktop backfill AND materialize paths against a REAL `hcfs-server` — an empty folder round-trips to `/browse`, materializes across two devices (`empty_folder_materializes_across_two_devices`), and a locally-deleted empty folder is not resurrected (`locally_deleted_empty_folder_not_resurrected`). Needs `HCFS_DESKTOP_E2E_SERVER_URL` + `HCFS_DESKTOP_E2E_ADMIN_BEARER`. The hermetic plan/apply/guard coverage for materialize lives in `src/sync/migrate/folder_entries_materialize.rs`'s unit tests + proptests.
- Shared drives: `shared_drive_server_mock.rs` (mock-axum: HTTP layer shapes, feature-off discriminator, `?owner=` pass-through, `install_member_drive` row+seal effects incl. idempotency/repair), `shared_drive_wiring.rs` (source pins: resolver funnel, member init skips, no-secret-log), and `shared_drives_real_backend.rs` (`#[ignore]` live lane: TWO bearer identities against a real `HCFS_FEATURE_SHARED_DRIVES=1` server — invite mint → sealed-grant accept → member install → file round-trips in BOTH directions → both revocation shapes with local files intact; needs `HCFS_DESKTOP_E2E_SERVER_URL` + per-account `_BEARER_OWNER`/`_BEARER_MEMBER`/`_OWNER_SS58`/`_MEMBER_SS58`; the file's module docs carry the full local server recipe, incl. hcfs's `scripts/e2e-auth-stub.py`).
- Folder shares: `shares_server_mock.rs` / `folder_share_wiring.rs` (hermetic) and `folder_shares_real_backend.rs` (`#[ignore]` live lane: mint → live browse → the fragment key decrypting REAL engine ciphertext over the anonymous blob route → revoke; needs `HCFS_DESKTOP_E2E_SERVER_URL` + `HCFS_DESKTOP_E2E_BEARER` + `HCFS_DESKTOP_E2E_SS58`, and the bearer must be a **user** bearer — the admin-bypass token maps to a literal `"admin"` owner and the mint 404s).

## The live lane (`.github/workflows/e2e-live.yml`)

The `*_real_backend.rs` suites are `#[ignore]`d and skip QUIETLY when their env is unset, so a plain `cargo test` stays hermetic — which also means they run only when a human remembers, and they can go stale across an hcfs pin bump.

`e2e-live` is a **manual** (`workflow_dispatch`) workflow that runs them for real: pick `suite` = `shared_drives` | `folder_shares` | `folder_entries` | `both` | `all` (`gh workflow run e2e-live.yml -f suite=both`, or the Actions tab). `both` and `all` run every live file. Note `workflow_dispatch` resolves the workflow file BY PATH ON THE DEFAULT BRANCH, so `--ref <branch>` chooses which code runs but the dispatch itself fails with "workflow does not exist" until `e2e-live.yml` is merged to `main`.

It sets **`HCFS_DESKTOP_E2E_REQUIRE=1`** (matched EXACTLY against `1` — `=true`/`=yes` disable it), which every live suite's `live_env()` honours by PANICKING instead of skipping — without it a mistyped or unprovisioned secret would produce a green job that asserted nothing, the entire failure mode the lane exists to prevent. A preflight step names any missing secret before the compile, and each suite step asserts a NON-ZERO executed-test count afterwards, because REQUIRE panics from inside a test body and so cannot catch "no test body ran" (drop `-- --ignored` and cargo exits 0 with `0 passed; N ignored`).

The lane is deliberately non-blocking and **must never become a required check** (it depends on a live external service), and it deliberately has no cron: **the standing rule is to run it on every `hcfs` pin bump** — the moment that matters — before merging the bump PR.

`folder_entries_real_backend.rs` is a third step on the same workflow. It reads **`HCFS_DESKTOP_E2E_ADMIN_BEARER`** from repository secrets (never a value in this public repo), renamed away from the plain `HCFS_DESKTOP_E2E_BEARER` that `folder_shares_real_backend.rs` reads — that one must be a USER bearer, so the two suites want opposite credentials and must not share a variable name. `tests/live_lane_wiring.rs` fails if a new `*_real_backend.rs` is not a `cargo test --test` line in the workflow, and if a live-lane credential is committed as a literal.

## Sync widget replay harness

The widget's recurring defects are stateful, cross-frame data-projection bugs — a smoother that sticks at a high-water mark, a header byte source that diverges from the ring, a stale seed clobbering a newer live frame. Single hand-built-snapshot tests (`app/(pages)/__tests__/SyncStatusDialog.test.tsx`) structurally cannot reach them: the author who misread the data also builds the one frame that fails to trip it.

`app/(pages)/__tests__/syncWidgetReplay.test.tsx` instead mounts the REAL chain the app runs — `useSyncSnapshotListener()` (the `sp_get_snapshot` seed + `sync_progress_snapshot` writer) → `SyncStatusHandler` → `SyncStatusDialog` — and replays an ordered *stream* of snapshot frames through the mocked Tauri event boundary, asserting per-frame invariants after EVERY frame. The pure invariants/readers/scenarios live in `syncWidgetReplay.invariants.ts` (`checkFrameInvariants`: `BYTE_SOURCE` pins the header transferred/total to `selectLiveTransferBytes` — the SAME pair the ring is weighted on; `RING_RANGE`; `COMPLETE_AT_100`).

The sibling **uploads-feed** bugs (appear-then-vanish, leading-slash dedup, per-file progress bleed) get the same integration treatment in `app/lib/upload-feed/__tests__/uploadFeedReplay.test.tsx`: it drives the REAL `useUploadFeed` chain (snapshot atom → the stateful `useRetainedCompletedUploads` ref cache → `mergeUploadFeed`) and `useFileLiveProgress` through a frame STREAM with a mocked `useRecentUploads` server list and a deterministic `Date.now`, asserting a finished upload stays visible (with a STABLE timestamp) across the snapshot-gone→server-refetch gap, that a macOS leading-slash path dedups against the trimmed server path, and that same-basename files in different folders each bind to their OWN live progress. This closes what the pure `mergeUploadFeed.test.ts` couldn't: it faked retention with a static `retainedCompleted` array, so the stateful capture-once/evict-on-confirm hook was untested.

Both harnesses were mutation-checked once when written — a point-in-time manual check, **NOT** a continuously-enforced guardrail (there is no `cargo-mutants`/stryker job in CI).

To feed the harness a REAL stream, arm the dev-only recorder (`app/lib/sync/syncEventRecorder.ts`, mounted self-gated in `SyncEventLogger`): set `localStorage["hippius:record-sync"] = "1"` in a dev build, reproduce a sync, then `window.__hippiusSyncRecorder.download()` — the dumped JSON is exactly the `ReplaySession` shape the harness consumes. The recorder is a no-op in production and unless armed.

## On-device E2E (`e2e/`)

WebdriverIO via `tauri-plugin-webdriver`, which embeds an in-process WebDriver server so it works on macOS where the official `tauri-driver` does not. Gated behind the **off-by-default** Cargo feature `e2e-webdriver` (registered under `#[cfg(feature = "e2e-webdriver")]` in `main.rs`) so the unauthenticated automation server can never reach a release build (`cargo tree -i tauri-plugin-webdriver` finds nothing in the default graph).

`app/e2e/sync-widget/page.tsx` (gated on `NEXT_PUBLIC_E2E=1`) mounts the real widget with a backend-free `window.__e2ePushSyncFrame` bridge, and `e2e/specs/syncWidget.e2e.ts` asserts the real WKWebView render. `wdio.conf.ts` serves the harness over **HTTP** (`127.0.0.1:3101`) rather than the app's `tauri://` protocol: a raw `cargo build` debug binary doesn't serve the embedded frontend assets, and the harness needs no Tauri IPC anyway.

Run with `pnpm e2e:build && pnpm e2e` on a Mac (see `e2e/README.md`). The replay harness remains the cheaper layer that targets these specific bugs on every `pnpm test`; the E2E layer adds production-renderer confidence.

## HCFS bump guards

The FE (TypeScript) is decoupled from Rust types — there is no tauri-specta/ts-rs codegen — so the ONLY way a `hcfs-client`/`hcfs-shared` git-rev bump reaches the FE is through the Tauri IPC boundary (`#[tauri::command]` return values + `app.emit()` payloads). The `ci.yml` Rust job re-runs a set of **wire-contract pin tests** on every bump PR so a shape change fails CI instead of shipping.

Every foreign hcfs type that crosses the boundary is pinned next to where it crosses:

| Type | Pinned in |
|---|---|
| `SyncSnapshot` | `sync/tauri_bridge.rs` |
| `FileAction` / `StagedChanges` / desktop event payloads | `sync/events.rs` |
| `RemoteFileInfo` | `sync/remote.rs` |
| `SyncEngineHealth` / `ConnectivityStatus` | `sync/status.rs` (a variant rename would HIDE an outage) |
| `ShareProgress` / `SharePhase` | `shares/commands.rs` |

Desktop-owned FE-facing types are pinned next to where they live in the `sync/files/` split (`UserFileEntry` camelCase incl. the `type`/`fileId` keys in `user_files.rs`; the `GroupedListing` camelCase / `FileEntry` snake_case mixed split in `listing.rs`).

Shape tests can't catch a behavioral change, so `tests/hcfs_contract.rs` holds known-answer tests for the key/identity derivation (`folder_hash`, `derive_folder_mnemonic`, `derive_encryption_key`) AND an at-rest XChaCha20-Poly1305 decrypt KAT (a ciphertext frozen at the pinned rev that must still decrypt — the data-loss guard for already-uploaded files).

**When adding a new IPC command/event that carries an hcfs type, add a matching pin.** The weekly auto-bump workflow + its activation steps are in `.github/hcfs-bump-gate-activation.md`.
