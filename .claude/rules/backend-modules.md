---
paths:
  - "src-tauri/src/**"
---

# Backend module map

Deeper detail for individual subsystems lives in the sibling rules files: `sync-engine.md`, `auth-recovery.md`, `shares-and-shared-drives.md`, `tray.md`, `macos-packaging.md`.

- **`main.rs`** — Entry point. Registers all IPC commands, initializes plugins, sets up single-instance and deep-link handling. `lib.rs` re-exports all modules for integration tests. CLI-only modes (`--finder-share`, `--version` / `-V`) return from `main` *before* `load_env` / `init_logging` / `cpu_pool::configure` / `Builder::default()` so they never boot the UI. `--finder-share` still wins if both flags appear. Version handling lives in `cli.rs` (writeln + flush, not `println!` / not `process::exit` — a piped `--version` would otherwise lose the line). Pinned by `tests/cli_version_wiring.rs`.
- **`error.rs`** — `AppError` enum with `thiserror`. A custom `Serialize` produces `{ "kind": "...", "message": "..." }` for frontend error matching. `NotReadyKind` gives machine-readable variants for auth/sync readiness errors.
- **`app_state.rs`** — Centralized `AppState` with sub-states: `AuthInfo`, `BlockchainState`, `BlockSubscriptionState`, `OAuthState`, `MigrationState`, and `SyncRunner` (Arc). Also holds a shared `reqwest::Client` and a `tokio::sync::Notify` for drive-removal wakeups.
- **`auth/`** — Authentication and account management. See `auth-recovery.md`.
- **`sync/`** — Core sync engine (~32 submodules, the largest backend area), organized into six private sub-domain group directories — `drive/`, `projection/`, `fileops/`, `migrate/`, `failure/`, `shared/` — each re-exported at `crate::sync::<module>` from `mod.rs`, so the grouping is a file-tree layer that leaves every `crate::sync::<module>::<item>` path unchanged. See `sync-engine.md`.
- **`blockchain/`** — Substrate/Polkadot integration: `client.rs` (RPC client with double-check lock pattern), `queries.rs` (balance, staking info with snapshot-consistent reads), `staking.rs`, `transfers.rs`, `subscription.rs` (block subscription), `convert.rs`, `helpers.rs` (signer extraction), `state.rs`, `types.rs`, `runtime.rs`. `blockchain/bridge/` (~13 files) backs the bridge UI's cross-chain transfers.
- **`billing/`** — `charts.rs` (chart data formatting plus shared helpers — `parse_timestamp_to_date`/`parse_timestamp_to_datetime`, `planck_str_to_credits`, `format_balance`/`format_bytes`, `range_start`; plan-card `storage_display` rounds TB labels so 3/150/450 credits read as 1/50/150 TB — `storage_gb` stays the binary-search result and is what `storage_overview` prices capacity from), `credit_balance.rs`, `drive_credits.rs` (cumulative drive credit *spend*), `drive_storage.rs`, `credits.rs`, `queries.rs`, `subscriptions.rs`, `storage_overview.rs`, `eligibility.rs`, `account_cache.rs`.
- **`api/`** — HTTP clients: `client.rs` (generic Hippius API client), `indexer.rs`.
- **`crypto/`** — Encryption at rest: `store.rs` (HKDF-SHA256 key derivation, ChaCha20-Poly1305 AEAD, `migrate_if_needed` for transparent plaintext→encrypted migration of sub-account seed phrases).
- **`wallet/`** — Local (non-login) wallet management: CRUD, import/export of encrypted backups, at-rest crypto (`commands.rs`, `crypto.rs`, `repo.rs`). This is where the typed-error taxonomy lives — `AppError::{Validation, NotFound, Crypto, Zip}` rather than stringly `Other`.
- **`shares/`**, **`shared_drives/`** — Encrypted share links and cross-account member drives. See `shares-and-shared-drives.md`.
- **`recovery.rs`**, **`recovery_proof.rs`**, **`recovery_binding.rs`** — See `auth-recovery.md`.
- **`console_access.rs`** — Web-console access/session bridging (typed `?` error propagation, no `Other(String)`).
- **`media_preview.rs`** — The two commands that feed the in-app file viewer, sharing one gate. `prepare_motion_photo_preview` splits a Hippius Live image into the plaintext preview cache; `read_preview_bytes` returns a document's plaintext bytes under a byte cap (raw, via `tauri::ipc::Response` — the JSON path would encode 25 MiB as ~75 MiB of digits). Both run the caller-supplied path through the private `validate_preview_source`, which canonicalises and requires it to sit under a registered `sync_paths` row for the active account or under `~/.hippius/preview-cache` — **without that gate either command is an arbitrary filesystem reader for a compromised renderer.** The renderer's `max_bytes` is a request, not an authority: `preview_read_limit` clamps it to `MAX_PREVIEW_READ_BYTES` and rejects (never truncates — half a DOCX is a corrupt DOCX) with the `PREVIEW_TOO_LARGE` copy Rust owns. Unit-tested in-module.
- **`splash.rs`** — Splash-window lifecycle during boot.
- **`updates.rs`** — In-app updater aimed at this build's own channel. Installs in-place on AppImage / macOS / Windows. **Deb and RPM do not:** plugin-updater's `dpkg -i` behind pkexec returned `Permission denied (os error 13)` in QA, so `refuse_if_privileged_package` returns the download instruction before the plugin writes, and the dialog's CTA is Download rather than Install. **Rust owns every sentence the update dialog shows** — the plugin's `Display` is diagnostics and must never reach the user. `install_failure` labels Deb/Rpm plugin failures (`DebInstallFailed` / `PackageInstallFailed`) as an unsupported package; Io PermissionDenied stays the generic install-failed copy (macOS returns that kind when the admin prompt is declined). The manual-install wording is keyed on `bundle_type()`, with the OS breaking the tie only where that marker is absent. **tauri-bundler does not patch the marker into the `.deb`** (the shipped binary still carries `__TAURI_BUNDLE_TYPE_VAR_UNK`), so `bundle_type()` is `None` on the released Linux build: an unknown bundle must refuse in-place install on Linux, and the bare `linux-x86_64` manifest key must NOT be deleted — it is the only key Linux resolves, so dropping it turns every Linux update check into `TargetsNotFound`. Pinned by `tests/updater_install_paths.rs` and `no_lane_deletes_the_bare_linux_updater_key`.
- **`notifications/`** — Notification management commands. Sync-complete list titles are derived in Rust (`list_title`) from the `release_notes` JSON (one file → `Synced {basename}`; several → `Synced n files`; delete-only → `Deleted {basename}` / `Deleted n files`); the bell and the notifications page render `title_text` and nothing else, so the title is the whole of what a user reads about a finished cycle. Two rules keep it from lying: **a delete is never phrased as Synced** (`Synced report.pdf` for a file the cycle DELETED reads as a successful upload of a file that is gone; a delete-only cycle is titled as a delete instead of the generic "Sync Complete" — H-158), and **the count comes from the `fileCount` IPC arg, never from the list length** — the list is capped at `MAX_NOTIFICATION_FILES` and again by the hook's own buffer, so counting it titles a 5 000-file sync `Synced 200 files`. The single-name arm additionally requires the count and the list to agree on exactly one file. Error / restored titles stay fixed.
- **`infra/`** — VM provisioning and support ticket commands.
- **`tray/`** — System-tray popover window. See `tray.md`.
- **`vpn/`** — App-scoped NetBird VPN for **VM connections only** (opt-in; never routes the app's regular traffic). See below.
- **`utils/`** — Schema management (`schema.rs` with `ensure_table_schema()`), bookmarks, preferences, platform info, macOS App Translocation detection (`app_location.rs`), tray menu data (`tray_menu.rs`: `get_tray_menu_data` — credits/address/login for the popover), support helpers, support-log scrubbing (`logs.rs`), and file-manager reveal (`reveal.rs`: Linux `xdg-open`s the directory because the opener plugin's FileManager1 path is a silent no-op on Thunar — H-085; the IPC canonicalises and requires the path under this account's `sync_paths`). See below.

## Global state

Centralized in `AppState` (`app_state.rs`), registered via `app.manage(AppState::new())` at startup. Command handlers access it via `tauri::State<'_, AppState>`, background tasks via `app.state::<AppState>()`. The DB pool uses `OnceLock` within AppState. **No module-level `static` variables remain.**

## SQLite

Database pool lives in `AppState` as a `OnceLock<SqlitePool>`. Schema is maintained via `ensure_table_schema()` in `utils/schema.rs` (not migration files). Access pattern: `state.pool()?` (from command handlers) or `app.state::<AppState>().pool()?` (from background tasks).

## Logging

All Rust code uses `tracing` macros (`info!`, `debug!`, `warn!`, `error!`) — **never `println!`/`eprintln!`**. The subscriber is initialized in `main.rs` with module-path targets. Set `RUST_LOG=debug` for verbose output. For the hot-path throttling rule, see `sync-engine.md`.

## Credit-eligibility checks

The decision of whether the user can afford a gated action (file upload, folder upload, folder sync, VM creation) lives in Rust in `src-tauri/src/billing/eligibility.rs`.

The `thresholds` module is the **only** place credit pricing constants live (`VM_CREATION = 10.0`; `FILE_UPLOAD`/`FOLDER_UPLOAD`/`FOLDER_SYNC`/`SHARING` are all `0.0` — a "must have a strictly-positive balance" floor, NOT a non-trivial minimum; the real per-action cost comes from the byte-priced layer plus the hcfs-server 402). Changing the price for an action means editing one constant.

Two entry points:

1. `check_action_eligibility` (Tauri command) does a **live** balance fetch (no caching) and returns a structured `ActionEligibility { eligible, reason, currentBalance, requiredBalance }` for the FE's proactive dialog gate.
2. `require_eligible(state, account_id, action)` is the helper that **every gated action IPC** (`add_file`, `add_files`, `add_folder`, `add_local_sync_folder`, `create_vm`) calls as its FIRST line, returning `Err(NotReady(InsufficientCredits))` when ineligible. IPC enforcement makes the gate atomic with the action and impossible to bypass via direct IPC calls or a stale FE cache.

The FE `useCreditCheck` hook is a thin async wrapper around `check_action_eligibility`. **Frontend code must never read `useUserCredits` for eligibility decisions** (that hook is `staleTime: Infinity` and only suitable for display). When matching the IPC error in catch blocks, match on the structured shape `{ kind: "NotReady", message: "Insufficient credits..." }`, NOT on substring matching of `err.message`.

## `utils/`: App Translocation detection

`app_location.rs`: the pure, unit-tested `path_is_translocated` matches a whole `Component::Normal` named `AppTranslocation` — component equality, NOT a substring, so an unrelated `/Apps/MyAppTranslocationTool/…` is not a false positive; no FFI/`unsafe`. `is_app_translocated` IPC lets the FE query it race-free on mount; `setup()` also logs a `warn!` on macOS so it lands in support-log bundles.

This is the root-cause fix for "macOS re-asks for Documents/Desktop access on every launch": a quarantined/DMG copy run from a randomized read-only `…/AppTranslocation/<UUID>/d/` path can never persist a TCC folder grant. The FE `app/components/TranslocationGuard.tsx` invokes the command once in `AppShell` and shows a persistent sonner "move Hippius to /Applications" notice.

## `utils/logs.rs`: support-log scrubbing

`attach_logs_to_ticket` bundles recent `~/.hippius/logs/` files into a redacted zip. Two layers:

- **Secret redaction** — mnemonics, API tokens, JWTs, PEM keys, labelled `key=value` secrets, 0x-64 hex.
- **Identity anonymization** — SS58 wallet addresses → `[REDACTED_ADDRESS]`, home-dir/username paths collapsed to `/Users|/home/[REDACTED_PATH]`, non-home filename leaves → `[REDACTED_FILENAME]`, emails → `[REDACTED_EMAIL]`.

IPFS CIDs are deliberately preserved (the 47–48-char address bound excludes them) — they carry no identity and aid debugging. Redaction is idempotent (proptest-pinned in `logs.rs::tests::redaction_is_idempotent`).

**SS58 addresses are redacted by `redact_ss58_addresses`, not by a `LINE_REDACTORS` entry**, because the boundary check cannot be expressed in the pattern and BOTH obvious ways of writing it leak:

1. `\b` never fires between an address and an underscore (`_` is a word character), and `sync::drive::lifecycle` logs its drive identity as the composite `<ss58>_<folder_hash>` — so the wallet address survives in full on those lines while every standalone occurrence nearby is correctly redacted.
2. A *consuming* boundary class (`([^0-9A-Za-z]|$)`) swallows the separator, and since `replace_all` resumes scanning after it, two addresses ONE character apart (`A,B`) leave the second **entirely unredacted** — a total leak.

The function therefore matches a bare 47-48 char base58 run and asserts both boundaries by inspecting the surrounding bytes at the match offsets, consuming neither. This also keeps the length bound exact: in a 49-char run the right boundary fails and the candidate is returned verbatim, so a CIDv1 is never partially eaten (pinned by `preserves_longer_base58_run_than_an_address` and `redacts_both_addresses_separated_by_a_single_character`).

**The bundle must never fail silently.** Three independent silent-skip paths once combined to make an opted-in log upload vanish with no trace for the user, for support, or in the log file itself:

1. `attach_logs_to_ticket` resolves the target message itself via `support::first_message_id`. The FE used to read `ticket.messages[0].id` off the create response, a field the API does not guarantee, and skipped the upload entirely when it was absent — the command no longer takes a `messageId` at all, so the gate cannot come back.
2. Every failure is `warn!`-logged in Rust before it is returned, so the NEXT bundle explains why the previous one never arrived.
3. The support page surfaces a `toast.warning` after the ticket's own result instead of a bare `console.warn`.

An oversized log file is **truncated to its tail** (`read_tail_lossy`, seek-based, dropping the partial first line and prepending `TRUNCATION_NOTICE`), never dropped — the incident is at the end of the file and the day a user files a ticket about is the likeliest to be oversized. `MAX_BYTES_PER_FILE` and `MAX_TOTAL_BYTES` are both measured against the bytes actually written.

The create-ticket attachment picker is **unfiltered**, matching `TicketMessagesDialog` and what `upload_attachment_bytes` accepts (`application/octet-stream`); an images-only filter greys out a user's own diagnostic zip, which reads as "I sent it and you never got it" rather than as a rejection.

## `vpn/`

App-scoped NetBird VPN for **VM connections only**. Embeds a NetBird **userspace** mesh peer (no OS TUN / root / separate binary) behind the `MeshEngine` trait (`engine.rs`): `DisabledEngine` by default; the real `netbird_engine.rs` only under the off-by-default **`netbird-vpn` Cargo feature**, which pulls `netbird-embed`'s Go/cgo build (**requires Go 1.25, NOT 1.26** — 1.26 breaks the pinned gvisor); and a `#[cfg(test)]` `FakeMeshEngine` (real loopback echo) backing the `state.rs` tests.

`VpnState` (`state.rs`) owns a `tokio::watch` status channel — a startup bridge task (`commands::spawn_status_bridge`, wired in `main.rs`) is the **single emitter** of `vpn_status_changed`, so every transition surfaces exactly once regardless of which command/error path caused it — plus a per-VM proxy registry; opening a connection returns a `127.0.0.1:<port>` forward via `start_proxy` (cross-platform).

IPC: `vpn_status` / `vpn_connect` / `vpn_disconnect` / `vpn_open_vm_connection` / `vpn_close_vm_connection` / `vpn_list_connections`. The desktop credential comes from the Hippius-backend seam (`config.rs` — `NotConfigured` until that endpoint exists; dev `HIPPIUS_NETBIRD_SETUP_KEY` env override for manual testing) and the peer name from `sync::device::get_device_name_internal`; the VPN is torn down on logout. Typed `VpnError` (`error.rs`) → `AppError::Vpn` + `NotReadyKind::VpnNotConnected`.

Known limitation: `netbird-embed` 0.3 has no per-proxy stop, so `close_proxy` is best-effort until `disconnect`. See `docs/plans/2026-06-29-netbird-vpn-vm-connections.md`.
