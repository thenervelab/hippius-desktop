# Logging: how the app gathers, processes, and keeps logs

The full path a log line travels, from a `tracing` macro to a redacted zip on a
support ticket. Sources: `src-tauri/src/main.rs::init_logging`,
`src-tauri/src/utils/logs.rs`, `.claude/rules/backend-modules.md` ("Logging",
"utils/logs.rs"), `.claude/rules/sync-engine.md` (throttling).

## 1. Capture — who writes logs

- **Rust only.** All backend code logs through `tracing` macros (`info!`,
  `debug!`, `warn!`, `error!`) — never `println!`/`eprintln!` (repo invariant).
- **hcfs-client logs flow into the same subscriber.** The sync engine is a
  cargo dependency; its `tracing` events are captured by the app's subscriber
  under the `hcfs_client` target.
- **Panics are captured.** `diagnostics::install_panic_hook` (installed in
  `main` right after logging init) routes every panic through `error!` with
  payload, location, and thread before chaining to the default hook — so a
  crash leaves a trace in the same rolling files a support bundle ships.
  Wiring pinned by `tests/diagnostics_wiring.rs`. Caveat: the line rides
  the non-blocking writer and flushes on unwind; an abort-style death (a
  double panic in a `Drop`, a panic crossing FFI frames) can lose it.
- **Every IPC error leaves a line.** `AppError`'s `Serialize` impl — the one
  choke point every command error crosses on its way to the renderer — logs
  the error as it is serialized: `warn!` for unexpected kinds, `debug!` for
  expected user-state preconditions (`NotReady`, `Validation`, `NotFound`,
  `Auth` — the boot-gap "No active account set" fires on every launch),
  which the frontend surfaces itself and which would otherwise drown real
  diagnostics. So "I got an error toast" always has a matching log line.
  Two guards keep the warn stream honest: the logged text scrubs any
  reqwest-rendered `for url (…)` (tokenized share routes carry the
  capability in the URL path, which the bundle scrubber cannot redact),
  and the warn is throttled to one line per kind per minute (repeats drop
  to `debug!`, and the reopening warn carries `suppressed_repeats`) so a
  dead dependency behind a 6-second poller cannot evict the real incident
  from the bundle's 5 MB tail.
- **The frontend does not feed the log files.** There is no `tauri-plugin-log`
  and no console bridge: `console.log/warn/error` in `app/` reaches only the
  WebView dev tools and is lost otherwise. Anything that must be diagnosable
  from a support bundle has to be logged from Rust — one more reason business
  logic lives in `src-tauri/`.
- **Hot-path throttling rule:** a callback that fires per file/chunk/entry
  either throttles its log or logs nothing. The scan callback is thinned by
  `LogThrottle` to one line per 2s (`SCAN_LOG_INTERVAL`), kept at `info!` on
  purpose so a "stuck" scan is visible in a default-level bundle; wiring pinned
  by `tests/scan_log_throttle_wiring.rs`. Per-page callbacks (~17/cycle) may
  stay unthrottled. Rationale: per-item logging crowds real diagnostics out of
  the 5 MB-per-file bundle cap (section 4).

## 2. Processing — filter and sinks (`main.rs::init_logging`)

Initialized in `main()` right after `load_env()`, before anything else logs.
CLI-only modes (`--finder-share`, `--version`) return before this and never
touch the log files. The first line after init is the identity banner —
`diagnostics::build_identity()` logged with version, release channel, OS,
and arch — so a fresh log file names the build that wrote it.

- **Filter:** `RUST_LOG` env var if set, else the default
  `warn,hcfs_client=info,Hippius=info` — everything at `warn`, the app crate
  and the sync engine at `info`. `RUST_LOG=debug pnpm tauri:dev` for verbose
  local runs. The filter is shared by both sinks; there is no per-sink level.
- **Sink 1 — stdout:** `fmt` layer with targets, no file/line numbers. Only
  visible when launched from a terminal (dev).
- **Sink 2 — rolling file:** `tracing_appender` daily-rotating file under
  `~/.hippius/logs/`, named `hippius.YYYY-MM-DD.log`. Plain text
  (`with_ansi(false)` — the files are read raw and shipped to support).
- **Non-blocking writer + `WorkerGuard`:** file writes go through a background
  thread; the guard returned by `init_logging` is held in a `main`-scoped local
  for the whole process lifetime. Dropping it stops the writer, silently losing
  later lines — do not move it.
- **Best-effort:** if the home dir can't be resolved or the appender can't be
  created, the app degrades to stdout-only rather than aborting startup.

## 3. Retention — what stays on disk

- `max_log_files(7)`: about a week of daily files. Pruning happens on the
  rotation/write path, not at startup (tracing-appender limitation), so a
  long-idle install can briefly hold more than seven files until the next
  write. Harmless: the bundler independently caps what it ships.
- There is no size-based rotation — a single day's file can grow without
  bound. The bundler compensates by shipping only the tail (section 4).
- Nothing else touches the directory: no in-app log viewer, no "open logs
  folder" UI, no telemetry. The only egress is the opt-in support bundle.

## 4. Egress — the support-ticket log bundle (`utils/logs.rs`)

When the user ticks "include logs" on the support form
(`app/components/page-sections/support/index.tsx`), the frontend calls the
`attach_logs_to_ticket` command after `create_support_ticket`. The command:

1. Resolves the target message itself via `support::first_message_id` — the
   create response does not guarantee a `messages` array, and the old
   frontend-supplied `messageId` silently skipped the upload when absent.
2. Builds the bundle on `spawn_blocking` (enumeration, reads, redaction, zip
   are all blocking work).
3. Takes the **newest 7 files by mtime** (`MAX_FILES`, matching retention).
4. Caps each file at **5 MB** (`MAX_BYTES_PER_FILE`) — an oversized file is
   **truncated to its tail** (`read_tail_lossy`: seek, drop the partial first
   line, prepend `TRUNCATION_NOTICE`), never dropped. The incident is at the
   end of the file, and the day a user files a ticket about is the likeliest
   day to have run long.
5. Stops at **20 MB total pre-compression** (`MAX_TOTAL_BYTES`), both caps
   measured against the bytes actually written.
6. Redacts every file (section 5), zips them (deflate) into a temp file owned
   by a `TempZip` RAII guard (unique UUID name; removed on every exit path),
   adds a `system-info.txt` entry (`diagnostics::bundle_system_info`: version,
   channel, OS, arch, `bundled_at`) so the bundle is self-identifying even
   after the startup banner has rotated out, and uploads the archive as
   `hippius-logs.zip` on the ticket's first message.
7. Returns `Ok(None)` cleanly when there is nothing to ship (fresh install,
   empty dir).

**Failure posture — the bundle must never fail silently.** Best-effort by
contract (a log failure never fails the ticket), but visible on three levels:
every failure is `warn!`-logged in Rust before being returned (so the *next*
bundle explains why the previous one never arrived), and the support page
shows a `toast.warning` after the ticket's own result. The attachment picker
is deliberately unfiltered so a user can hand-attach their own zip.

## 5. Scrubbing — what never leaves the machine

Two layers, applied per bundle file by `redact_log_text` (whole-text PEM pass,
then per-line). Redaction is **idempotent** — every `[REDACTED…]` marker is
inert to every pattern — pinned by the `redaction_is_idempotent` proptest.

**Secret redaction** (no credential leaves the machine):

| Pattern | Marker |
|---|---|
| Multi-line PEM private-key blocks | `[REDACTED_PRIVATE_KEY]` |
| BIP-39 mnemonics (12+ word runs) | `[REDACTED_MNEMONIC]` |
| Labelled `key=value` / `key: value` / JSON-quoted secrets (`authorization`, `bearer`, `token`, `share_token`, `api_key`, `secret`, `password`, `passphrase`, `seed`, `mnemonic`, `private_key`) | `key=[REDACTED]` |
| Bare `Bearer <token>` / `Token <token>` headers | `[REDACTED_TOKEN]` |
| JWTs (`eyJ…`) | `[REDACTED_TOKEN]` |
| `0x` + exactly 64 hex (private keys/signatures) | `[REDACTED_KEY]` |

**Identity anonymization** (a shipped bundle can't be tied to a person):

| Pattern | Marker |
|---|---|
| Email addresses | `[REDACTED_EMAIL]` |
| SS58 wallet addresses (47–48-char base58) | `[REDACTED_ADDRESS]` |
| Home-dir paths — username and everything below, spaces allowed | `/Users/[REDACTED_PATH]` (and `/home/…`, `C:\Users\…`) |
| Filename leaves of non-home paths (e.g. `/tmp/report.pdf`) | `[REDACTED_FILENAME]` |

Deliberately **preserved**, because support needs them and they carry no
identity: IPFS CIDs (CIDv0 is 46 chars, CIDv1 ~49 — both outside the 47–48
address bound) and `token_hash` / `token_hash_prefix` fields (the server's own
correlation handle, never the capability).

Two hard-won boundary lessons, both test-pinned in `logs.rs`:

- **`\btoken\b` can never fire inside `share_token`** (`_` is a word
  character), so `share[_-]?token` needs its own alternation — bundles shipped
  live share capabilities until it got one. The same boundary rule is what
  keeps `token_hash` loggable on purpose.
- **SS58 redaction lives in `redact_ss58_addresses`, not the regex table**,
  because neither `\b` (misses `<ss58>_<folder_hash>` composites the sync
  engine logs) nor a consuming boundary class (lets the second of two adjacent
  addresses escape entirely) is safe. The function matches a bare base58 run
  and checks both neighbouring bytes without consuming them.

Upstream of the scrubber, the cleaner rule is to not log secrets at all:
`shares_server_mock.rs` / `account_authority_guard.rs` carry wiring pins that
scan `tracing` calls in the shares/shared-drives modules for secret-bearing
field names, and reqwest errors on tokenized routes must be stripped with
`Error::without_url()` before display (the URL embeds the share token).

## 6. Quick reference

| Question | Answer |
|---|---|
| Where are the log files? | `~/.hippius/logs/hippius.YYYY-MM-DD.log` |
| How long are they kept? | ~7 daily files, pruned on write |
| How do I get more detail? | `RUST_LOG=debug` (dev); default is `warn,hcfs_client=info,Hippius=info` |
| How do logs reach support? | Only via the opt-in checkbox on the support form → `attach_logs_to_ticket` |
| What's in the bundle? | Newest ≤7 files, ≤5 MB tail each, ≤20 MB total, fully redacted, zipped, plus `system-info.txt` (version/channel/OS/arch) |
| What happens on a crash? | The panic hook logs payload + location + thread into the same files |
| Do frontend `console.*` calls get captured? | No — dev tools only; log from Rust instead |
| Is there any telemetry / automatic upload? | No — nothing leaves the machine without the opt-in |
