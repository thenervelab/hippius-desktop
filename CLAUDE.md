# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## MUST-DO Rule for AI Agents (Claude and all others)

**Business logic MUST live in the Rust backend (`src-tauri/`). Frontend-only concerns MUST stay in the TypeScript frontend (`app/`).**

- All business logic — data processing, state transitions, persistence, network/IPC, blockchain, crypto, sync, validation, and domain rules — goes in `src-tauri/` (Rust).
- The `app/` TypeScript frontend is for UI, presentation, routing, and user interaction only. It calls into Rust via Tauri `invoke()` and listens to backend events.
- Do NOT implement business logic in TypeScript. If a feature needs logic, add a Rust command in `src-tauri/` and call it from the frontend.

## Overview

Hippius Desktop is a Tauri 2.0 application combining a Next.js 15 frontend with a Rust backend. It provides encrypted file sync, blockchain wallet management, VM provisioning, and billing — all integrated with the Hippius/Bittensor network.

## Coding rules

- Put business logic in Rust (`src-tauri/`) and interface with the frontend (`app/`), not the other way round.
- Every change needs tests. Do not add dummy tests that will never identify a real issue.
- Document non-obvious code where you change it.
- When a change is user-visible, add a one-line entry to the `[Unreleased]` section of `CHANGELOG.md` **in the same PR**. That file is read by non-engineers (marketing writes release announcements from it), so describe the outcome, not the mechanism — "uploads are faster on slow connections", never "parallel chunk uploads with per-chunk retry". Internal refactors, dependency bumps with no user-visible effect, and test-only changes get no entry. On release, rename `[Unreleased]` to the version + date and open a fresh `[Unreleased]` above it.

### Where new knowledge goes

Write it to the narrowest scope that holds it. This file is loaded into **every** session, so anything here is paid for on every task.

| Kind of fact | Goes to |
|---|---|
| An invariant every session needs | this file — one line |
| Subsystem detail, gotchas, design rationale | `.claude/rules/<subsystem>.md` (loads only when Claude reads a matching file) |
| Design docs and plans | `docs/plans/` |

Do not paste incident narratives, dates, report attributions, or debugging chronology into any of them — record the rule and, in one clause, why it exists. If a test pins the rule, say so in one clause and stop.

**A rule whose `paths:` glob matches nothing fails silently** — it simply never loads, and nothing reports it. After adding or editing a rule, confirm it actually fires:

```bash
cat > /tmp/probe.json <<'JSON'
{"hooks":{"InstructionsLoaded":[{"hooks":[{"type":"command","command":"cat >> /tmp/instructions.log"}]}]}}
JSON
rm -f /tmp/instructions.log
claude -p "Read <a file the rule should cover> and reply DONE" \
  --settings /tmp/probe.json --allowedTools Read < /dev/null
grep -o '"file_path":"[^"]*"\|"load_reason":"[^"]*"' /tmp/instructions.log
```

The rule should appear with `"load_reason":"path_glob_match"`. Note rules added mid-session are not picked up until a new session starts, so always probe with a fresh `claude -p`.

## Build & Development Commands

```bash
pnpm install                    # Install frontend dependencies
pnpm dev                        # Next.js dev server (localhost:3000)
pnpm tauri:dev                  # Full desktop dev (frontend + Rust backend)
pnpm build                      # Production frontend build (static export to out/)
pnpm tauri:build                # Full desktop production build
pnpm lint                       # ESLint
pnpm test                       # Vitest

# Rust backend (from src-tauri/)
cd src-tauri
cargo build                     # Build Rust backend
cargo clippy --all -- -D warnings
cargo fmt --all
cargo test                      # All Rust tests
cargo test --test auth_commands # Single test file
SQLX_OFFLINE=true cargo build   # Required for CI (offline SQLx mode)
RUST_LOG=debug pnpm tauri:dev   # With debug logging
```

**Prerequisites:** Node.js v18+, pnpm 9.12.3+, Rust toolchain. A `src-tauri/.env` file must exist (referenced in tauri.conf.json resources).

On macOS, `pnpm finder:dev` builds and registers the Finder Sync extension for local testing — see `.claude/rules/macos-packaging.md`.

### Release channels: `staging` and `main`

Development and both release lanes live in the **public** repo `thenervelab/hippius-desktop`. Full detail in [`docs/release-channels.md`](docs/release-channels.md); the rules that bind code changes:

- **Two long-lived branches.** `staging` → `tauri-staging.yml` → `v<version>-staging` prerelease (macOS + Linux + Windows, never marked latest). `main` → `tauri-build.yml` → `v<version>` production release. Both publish **on push** — there is no build-without-releasing mode, so `staging` is the validation gate and `main` is merged into deliberately. `main` requires linear history, so `staging` → `main` is always a **squash**. The older `redesign` / `redesign-preview` / `sync-engine` branches and the `tauri-dev.yml` lane are retired.
- **Never put a channel-specific updater pubkey in the tree.** `tauri.conf.json` carries the **production** pubkey on every branch; `tauri-staging.yml` patches the staging key in at build time via `scripts/use-staging-updater-key.sh` (fails closed on a missing `TAURI_UPDATER_PUBKEY_STAGING`). A per-branch pubkey was safe only while the lanes lived in separate repos — in one repo a `staging` → `main` merge carrying the staging key ships a production release whose update signature fails against every installed copy, with no error anywhere: users simply stop receiving updates.
- **A version bump touches three files and they must agree** — `src-tauri/tauri.conf.json` (canonical; every workflow reads it with `jq -r .version`), `src-tauri/Cargo.toml` (+ `Cargo.lock`), `package.json`. NOT `Info.plist` (see `.claude/rules/macos-packaging.md`). Forgetting to bump means the jobs upload into the *previous* release instead of creating a new one.
- **A push that changes nothing the artifact can see cuts no release.** Both workflows carry a `paths-ignore` denylist (markdown, `docs/`, `.claude/`, `.vscode/`, the ignore files); everything else builds, `.github/**` included. It is a denylist so a path nobody listed still ships. Run the workflow manually when a skipped push does need a release — `workflow_dispatch` ignores path filters.
- `hcfs-bump.yml` bases its PR on `staging`, not the default branch: an engine pin must be proven by a staging build and the `e2e-live` lane before it can reach production.

### `src-tauri/.env` and `INDEXER_API_KEY`

`src-tauri/.env` is gitignored, bundled as a Tauri resource, and loaded at runtime by dotenvy (`main.rs`). It must carry `INDEXER_API_KEY`: the indexer answers **401** without it, so `api/indexer.rs::IndexerClient` fails and EVERY indexer-backed surface — the home page's storage card, the storage total, the billing charts — renders a **confident zero instead of an error**. A build with no key looks healthy and the symptom reads as a data bug, which is why the key is guarded in three places rather than documented once.

- **Local dev**: `pnpm setup:env` (`scripts/dev-env.mjs`) resolves the key from `$INDEXER_API_KEY` or from an installed Hippius build's bundled `.env`, and writes it. It is Node, not bash, deliberately: `pnpm tauri:dev` runs it on every start, and a bash wrapper makes the project's primary dev command fail outright on a Windows machine without Git Bash on PATH. Its parse/rewrite/resolve helpers are pure and unit-tested (`scripts/__tests__/devEnv.test.mjs`), because the script rewrites a gitignored file in place. `pnpm tauri:dev` and `pnpm tauri:build` run it in `--soft` mode first, so a missing key is a loud warning rather than a hard block — everything except indexer data works without it. Harvesting from an installed app is deliberate: the same key ships in every distributed build and is extractable from any of them. The key is cached in a `OnceLock` for the process lifetime — **restart the app**, a hot reload won't pick it up.
- **`.env.example`** is the committed template listing every var the app reads (`INDEXER_API_KEY`, optional `HIPPIUS_INDEXER_URL` / `HIPPIUS_CONSOLE_BASE_URL`).
- **CI**: both release workflows (`tauri-build.yml` prod, `tauri-staging.yml`) write the file from the **`TAURI_ENV_FILE`** repository secret through `scripts/write-tauri-env.sh`, which **fails the build** when the result carries no key. Do not read `secrets.INDEXER_API_KEY` directly — an undefined secret expands to the empty string, so a prod release would bundle an empty key and ship the zeros. `ci.yml` writes the same file but deliberately does NOT gate on the key: it only needs the file to exist for `cargo check`.
- The staging console URL is **not** written into `.env`. `tauri-staging.yml` sets `HIPPIUS_RELEASE_CHANNEL: staging` on the build step and the compile-time channel does the routing. This is deliberate: an `.env` line is a file that can be copied between lanes; a build-step env var cannot leave the workflow that sets it.

## Architecture

### Frontend → Backend Communication

All frontend-to-backend calls go through Tauri IPC via `invoke()` from `@tauri-apps/api/core`. Backend commands are Rust functions annotated with `#[tauri::command]` and registered in `src-tauri/src/main.rs` via `tauri::generate_handler![]`. Backend-to-frontend events use `app.emit()` (Rust) and `listen()` (TypeScript).

There is no codegen between the two sides, so the IPC boundary is the only place a Rust type change can reach the frontend. Adding a command or event that carries an `hcfs-client` type means adding a wire-contract pin — see `.claude/rules/testing.md`.

### Layout

- **`app/`** — Next.js 15 frontend, static export (`output: "export"`, no SSR). Path aliases: `@/components/*` → `app/components/*`, `@/lib/*` → `app/lib/*`, `@/services/*` → `app/lib/services/*`.
- **`src-tauri/src/`** — Rust backend. `main.rs` registers every IPC command; `app_state.rs` holds all shared state; `sync/` is the largest area.
- **`macos/`** — Finder Sync extension (Swift) and its build/embed/sign scripts.
- **`docs/`** — `release-channels.md`, `release-checklist.md`, and the design docs under `docs/plans/`.

## Always-true invariants

These hold everywhere; the subsystem rules files carry the reasoning.

- **Rust owns business logic.** A feature that needs logic gets a Rust command, not a TypeScript implementation.
- **Never `println!`/`eprintln!`** in Rust — use `tracing` (`info!`, `debug!`, `warn!`, `error!`).
- **A callback that fires per file/chunk/entry either throttles its log or logs nothing.** Per-item logging crowds real diagnostics out of the 5 MB-per-file support bundle.
- **Never mutate `driveStatusesAtom` directly** from the frontend — call the IPC (`pause_drive`, `resume_drive`, `remove_drive`) and let the event listener propagate the change.
- **Route every in-app file mutation through `notifyFilesMutated`** (`app/lib/utils/fileMutationEvents.ts`) — the nested folder listings only refresh on its window event.
- **Read theme via `useAppTheme()`**, never `window.matchMedia("(prefers-color-scheme: dark)")`; raw CSS keys off `.dark`, not `@media (prefers-color-scheme: dark)`.
- **Never read `useUserCredits` for an eligibility decision** — call `check_action_eligibility`. Every gated IPC also enforces `require_eligible` as its first line.
- **Every re-authentication from a stored mnemonic derives via `service.rs::derive_verified_keys`**, never the bare `derive_keys` — an OAuth account's sync mnemonic derives a different identity than its login SS58.
- **Sync-failure copy comes from Rust** (`FileFailureKindPayload::display_reason`), never from reqwest's `Display`. Do not tell the user to check their connection.
- **Match IPC errors on the structured shape** `{ kind, message }`, not on substring matching of `err.message`.
- **Run the live e2e lane on every `hcfs` pin bump**, before merging the bump PR.

## Testing

```bash
# Rust integration tests (from src-tauri/)
cargo test                               # All tests
cargo test --test auth_commands          # Auth/mnemonic tests
cargo test --test crypto_migration       # Encryption-at-rest migration tests
cargo test --test migration_server_mock  # Server migration mock tests

# Frontend
pnpm test                                # Vitest
```

The `*_real_backend.rs` suites are `#[ignore]`d and skip quietly without their env, so a plain `cargo test` stays hermetic. See `.claude/rules/testing.md` for the live lane, the replay harnesses, and the hcfs wire-contract pins.

## Where the detail lives

`.claude/rules/*.md` files load automatically when Claude reads a file they scope to. Read one directly when you need it before touching code.

| File | Covers | Loads when touching |
|---|---|---|
| `sync-engine.md` | multi-drive sync, per-drive status, chunk reclaim, folder entities, keep-awake, rename, migration, conflict sync, failure gating | `src-tauri/src/sync/**` |
| `auth-recovery.md` | identity guard, OAuth, deep links, session restore, recovery + unlock flows | `src-tauri/src/auth/**`, `recovery*.rs`, `app/lib/auth/**` |
| `shares-and-shared-drives.md` | file/folder share links, shared drives, DriveIdentity resolver, grant crypto, revocation | `src-tauri/src/shares/**`, `shared_drives/**` |
| `sync-widget.md` | widget anti-flicker, data-correctness invariants, upload feed, Review Changes dialog | `app/(pages)/Sync*`, `app/lib/upload-feed/**` |
| `frontend.md` | theme, feature flags, sidebar search, viewer scoping, Live Photo, home cards | `app/**` |
| `backend-modules.md` | module map, global state, SQLite, credit eligibility, log scrubbing, VPN | `src-tauri/src/**` |
| `tray.md` | tray popover panel, platform differences, tray icon state | `src-tauri/src/tray/**`, `app/tray-panel/**` |
| `macos-packaging.md` | Finder extension, signing, notarization, bundle version, release packaging | `macos/**`, `tauri-*.yml` |
| `testing.md` | test inventory, live e2e lane, replay harnesses, hcfs bump guards | `src-tauri/tests/**`, `**/__tests__/**` |
