# Dependency Audit — 2026-08-24

Scope: every crate in `src-tauri/Cargo.toml` (`[dependencies]`, target-gated
deps, `[dev-dependencies]`, `[build-dependencies]`). Goal: find crates that
can be deleted outright, and crates where only a small function is used from
a much larger library, such that vanilla Rust (or a call already covered by
another dependency already in the tree) can replace them.

Method: `cargo machete` (both plain and `--with-metadata`) for unused-dep
detection, cross-checked by hand with `rg` against `src/`, `tests/`,
`build.rs`, `tauri.conf.json`, and the `capabilities/` directory (a plugin
crate can show up as "unused" to machete yet still matter via
`.plugin(...)` registration or a JSON capability — each candidate below was
checked against that before being called dead). No code was changed; this
is audit only.

## Summary

- **10 of ~65 declared crates are entirely unused** — zero source
  references anywhere in the repo. Delete them; no replacement code needed.
- **4 more are used at only 1–2 call sites** for something vanilla Rust (or
  an already-present dependency) can do directly. Two are strong,
  low-risk candidates; two are weaker trade-offs, included for completeness.
- Everything else (crypto, blockchain, async runtime, Tauri + its plugins,
  DB, compression/image codecs, file watching, cross-platform special
  dirs, temp files) is either heavily used or in a domain this project's
  own CLAUDE.md already rules out for hand-rolling ("prefer battle-tested,
  well-maintained, industry-standard tools" — crypto and protocol code
  explicitly). Those are listed at the end with the one-line reason each
  survived the audit, so "checked all the crates" is actually true rather
  than just the interesting subset.

---

## 1. Delete now — zero source references, zero rewrite needed

Verified with `cargo machete --with-metadata` plus manual `rg` across
`src/`, `tests/`, and config files. None of these appear in a single
`use`, a fully-qualified call, `.plugin(...)` in `main.rs`, or a
`capabilities/*.json` permission.

| Crate | Where declared | Note |
|---|---|---|
| `tar` | `[dependencies]` | No `tar::Builder`/`Archive` anywhere. |
| `flate2` | `[dependencies]` | No `GzEncoder`/`GzDecoder` anywhere. `zip`'s own `deflate` feature handles its internal compression without this direct dep. |
| `serde_yaml` | `[dependencies]` | No YAML files in the repo, no `serde_yaml::` call site. |
| `sysinfo` | `[dependencies]` | No `System::new`/`sysinfo::` anywhere. |
| `which` | `[dependencies]` | No `which::which(...)` anywhere. |
| `tauri-plugin-shell` | `[dependencies]` | Declared but **never registered** — `main.rs`'s `.plugin(...)` chain has 8 plugins (`process`, `updater`, `opener`, `dialog`, `fs`, `single_instance`, `deep_link`, and the E2E-only `webdriver`); `shell` isn't one of them, and no `capabilities/*.json` grants a shell permission. The plugin is completely inert. |
| `anyhow` | `[dependencies]` **and** `[dev-dependencies]` | Zero `anyhow::`, `anyhow!`, or `.context(...)` calls anywhere. The project fully migrated to the custom `AppError` (thiserror) taxonomy (see the multi-PR error-taxonomy work already in this repo's history); this is a leftover from before that migration completed. |
| `aes` | `[dev-dependencies]` | Zero references in `tests/` or `src/`. |
| `cbc` | `[dev-dependencies]` | Zero references. |
| `md5` | `[dev-dependencies]` | Zero references. |

**Action:** remove all 10 lines from `Cargo.toml`, run `cargo build` to
confirm, done. `aes`/`cbc`/`md5` were presumably test helpers for the
at-rest crypto migration tests (`crypto_migration.rs`) at some point and
were never cleaned up after that test was rewritten.

`tauri-build` also flagged by `--with-metadata`, but that's a **false
positive** — `build.rs` calls `tauri_build::build()`. Keep it.

---

## 2. Small function, big library — vanilla-Rust candidates

### `nix` — strong candidate

Full usage in the entire codebase:

```rust
// src/sync/migrate/migration.rs:313
let stat = nix::sys::statvfs::statvfs(path)
    .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
```

One call, to check free disk space before a migration. Everything else
that looked like `nix::` in a `rg` sweep was actually `std::os::unix::*`
(std, not the crate). `nix` is a large crate (process, mount, signal,
socket, terminal APIs...) pulled in for exactly one syscall wrapper around
`libc::statvfs`.

**Replacement:** a direct `libc::statvfs` FFI call. Note this DOES require
adding `libc` to `Cargo.toml` — a transitive dependency is not nameable as
`libc::` from our own code, so "already in the tree" is not the same as
"already usable". Declare it under `[target.'cfg(unix)'.dependencies]`,
matching how `nix` was gated. What does not change is the dependency
*tree*: `libc` is already built as a transitive dep of `hostname`,
`keyring`, and others, so this trades the whole `nix` crate for a
declaration line on a crate that was compiling anyway:

```rust
fn statvfs_free_bytes(path: &std::path::Path) -> std::io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: c_path is a valid NUL-terminated C string for the syscall's
    // lifetime; statvfs is initialized fully on success (errno checked).
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    Ok(stat.f_bavail as u64 * stat.f_frsize as u64)
}
```
(~15 lines, unix-only, matching the existing `cfg(unix)` gating of `nix`
today.) Drops the whole `nix` crate and its `fs` feature for one syscall.

### `uuid` — strong candidate

Full usage in the entire codebase, two call sites:

```rust
// src/utils/logs.rs:326 — random tag for a temp zip filename
std::env::temp_dir().join(format!("hippius-logs-{}.zip", uuid::Uuid::new_v4()))

// src/auth/oauth.rs:313 — CSRF state token
let oauth_state = uuid::Uuid::new_v4().to_string();
```

Both uses want "an unpredictable, effectively-unique string," not
anything UUID-spec-specific (no parsing, no version/variant checks
downstream). `rand` is already a direct dependency. A hand-rolled v4-shaped
formatter is ~10 lines and needs no new dependency (`uuid` currently pulls
its *own* `getrandom` + `serde_core`, which this removes too):

```rust
fn random_id() -> String {
    let bytes: [u8; 16] = rand::random();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    )
}
```
Neither call site depends on RFC-4122 version/variant bits being set, so
this doesn't even need to bother forcing them — but setting them is one
extra line if a real UUID shape is wanted for readability.

### `mime_guess` — moderate candidate

Two call sites, both the same pattern (`shares/commands.rs:391,579`):

```rust
mime_guess::from_path(&local_path).first_or_octet_stream().essence_str().to_owned()
```

Used only to pick a `Content-Disposition`/preview hint for shared files.
The crate + its `unicase` transitive dep exist for extension→MIME lookup
across hundreds of types; this app only cares about a preview mode for a
handful of image/doc/media extensions (the existing `image` crate dep
comment already scopes preview support down to "jpeg+png+bmp cover the
common cloud image types"). A ~20-entry hardcoded `match` on lowercased
extension, falling back to `"application/octet-stream"`, covers the same
ground the app actually exercises, with a purely cosmetic downside (wrong
icon/preview mode) if an obscure extension isn't in the table — no
correctness or security stake here.

**Recommendation:** worth doing, but lower priority than `nix`/`uuid`
since it trades a well-maintained lookup table for a hand-maintained one
that will need occasional additions as new file types come up in support
tickets.

### `hostname` — weak candidate, listed for completeness

One call site (`utils/schema.rs:619`), a display-label fallback
("My Device"). The crate itself is tiny (`cfg-if` + `libc`, 2 deps), and
replacing it needs *per-platform* code — `libc::gethostname` on Unix,
`GetComputerNameExW` via a Windows API crate — which is more surface than
the thing it replaces, for a cosmetic fallback string only ever seen when
a device name lookup fails.

**Recommendation:** not worth it. The dependency is already about as small
as it can be, and the cross-platform reimplementation risk/effort doesn't
pay for itself here.

### `dotenvy` — considered, recommend keep

Three call sites (`main.rs`), all "load a `.env` file into process env" at
startup. Tempting because it's used for a small, singular purpose, but
two things argue against touching it: (1) it already has **zero**
transitive dependencies, so removing it doesn't shrink the tree at all
beyond the one crate; (2) this `.env` file carries `INDEXER_API_KEY` and
other secrets, and this repo has already been bitten once by a careless
rewrite of `.env`-adjacent parsing logic dropping unrelated vars (the
`scripts/dev-env.mjs` dev-tooling script documents exactly that lesson and
is unit-tested because of it). Re-implementing quote/escape/comment
handling by hand to save one zero-cost leaf crate is a bad trade.

---

## 3. Checked and kept — everything else

Grouped by why each survived, so the "check all the crates" ask is fully
covered rather than just the actionable subset:

- **Crypto** — `ed25519-dalek`, `sha2`, `chacha20poly1305`, `hkdf`,
  `argon2`, `bip39`, `zxcvbn`, `zeroize`, `keyring`. All security-critical
  and match this repo's own standing rule to prefer audited,
  battle-tested crypto over hand-rolled equivalents. `zeroize` in
  particular is the textbook "small crate, don't touch" case — its whole
  job is defeating compiler optimizations that would otherwise elide the
  "useless" memory-clearing writes a vanilla version would produce.
  `zxcvbn` especially: it's a scoring *algorithm* with dictionaries
  (common passwords, keyboard-walk patterns), not a wrapper around one
  syscall — reimplementing it risks silently rating weak passwords as
  strong.
- **Blockchain** — `subxt`, `subxt-signer`, `alloy-signer`,
  `alloy-signer-local`. Protocol-correctness-critical (Substrate/Ethereum
  wire formats, extrinsic signing); out of scope for hand-rolling.
- **Encoding** — `base64`, `bs58`, `hex`. Zero-dependency, tiny,
  extremely widely used crates that interoperate with the server and
  other crypto code; a hand-rolled base64 padding bug is exactly the
  class of bug that breaks server interop silently. No benefit to
  removing, real risk to introduce a subtle encoding mismatch.
- **`unicode-normalization`** — one call site (NFC-normalizing paths
  before `register_relative_paths`, per the documented macOS APFS
  NFD-vs-server-NFC issue), but Unicode normalization tables are
  thousands of composition rules; this is precisely the kind of
  correctness-sensitive, not-actually-small logic that "one call site"
  can be misleading about. Keep.
- **`regex`** — used only in `utils/logs.rs` for secret/PII redaction
  before a log bundle is attached to a support ticket. This repo has
  already had a real redaction-boundary bug ship and get caught in review
  (documented in `logs.rs`'s own comments) — redaction correctness is a
  security control, not a place to swap a proven regex engine for
  hand-rolled string matching.
- **Async/runtime** — `tokio`, `futures-util`, `tokio-util`. Foundational;
  not reasonably replaceable.
- **Tauri + registered plugins** — `tauri`, `tauri-plugin-opener`,
  `-deep-link`, `-fs`, `-dialog`, `-process`, `-single-instance`,
  `-updater`, and the feature-gated `-webdriver`/`netbird-embed`. All
  actively registered in `main.rs`'s `.plugin(...)` chain (unlike
  `tauri-plugin-shell` above) and provide OS-level integration no vanilla
  rewrite would attempt.
- **`reqwest`, `sqlx`** — HTTP+TLS client and the SQLite driver. Writing
  either from scratch is out of scope for any project.
- **`notify`** — cross-platform filesystem watching (inotify/FSEvents/
  ReadDirectoryChangesW under one API), core to the sync engine's
  correctness. Not a "small function" usage — it's a stateful watcher the
  sync loop depends on continuously.
- **`zip`, `image`** — binary format codecs (DEFLATE archives,
  JPEG/PNG/BMP decode for thumbnails). Format-parsing correctness bugs
  are exactly the class of thing not to hand-roll.
- **`tempfile`** — 60+ call sites across the codebase. TOCTOU-safe
  temp-file creation; also exactly the kind of "looks simple, is actually
  full of platform edge cases" utility CLAUDE.md's own philosophy calls
  out as worth depending on.
- **`dirs`** — 11 call sites resolving home/Documents/Desktop/Downloads
  cross-platform (XDG on Linux, Known Folders on Windows, `NSHomeDirectory`
  equivalents on macOS). Genuinely nontrivial to get right by hand across
  three platforms.
- **`chrono`** — date/time arithmetic and formatting used throughout
  billing charts and sync timestamps; hand-rolled calendar math is a
  classic source of off-by-one and leap-year bugs.
- **`rand`** — CSPRNG source used elsewhere (and now also proposed as the
  `uuid` replacement's source above); not a candidate to remove, only to
  reuse.
- **`thiserror`** — this repo's own established error-handling
  convention (`AppError` taxonomy); removing it would mean hand-writing
  every `Display`/`Error` impl the macro currently generates.
- **`tracing`, `tracing-subscriber`, `tracing-appender`** — structured
  logging + daily log rotation + non-blocking file writer, whose output
  is bundled into support tickets (`utils/logs.rs`). Log-rotation
  correctness (not losing or corrupting a day's logs) isn't worth
  re-implementing to save one crate.
- **`nix` (remaining unix-only surface after the `statvfs` fix above)**
  — n/a, the fix above removes the entire crate, not just the one call.
- **`cocoa`, `objc`, `keepawake`** (macOS/Windows target-gated) — direct
  bindings to native APIs (`IOPMAssertionCreateWithName`,
  `SetThreadExecutionState`, Cocoa/Objective-C runtime calls for the
  Finder integration). This *is* the vanilla-Rust-equivalent layer for
  those OS APIs; there's nothing further to strip.
- **`hcfs-client`, `hcfs-shared`** — first-party protocol crates
  (git-pinned to the `hcfs` repo), not general-purpose utility
  dependencies; out of scope for this kind of audit entirely.
- **`proptest`, `axum`** (dev-only) — property-based testing and the mock
  HTTP server used by the server-mock test suites
  (`migration_server_mock.rs`, `shared_drive_server_mock.rs`, etc.).
  Test-only, actively used, not a production dependency-count concern.

---

## Net result

- **10 crates removable today**, no code changes beyond deleting the
  `Cargo.toml` lines: `tar`, `flate2`, `serde_yaml`, `sysinfo`, `which`,
  `tauri-plugin-shell`, `anyhow` (both sections), `aes`, `cbc`, `md5`.
- **2 more removable with a small, low-risk vanilla rewrite**: `nix`
  (→ one `libc::statvfs` FFI call) and `uuid` (→ a `rand`-based
  formatter). Both are one-function usages of otherwise large crates —
  exactly the pattern asked about.
- **2 more possible but lower-value**: `mime_guess` (→ a small hardcoded
  extension table) and `hostname` (→ per-platform FFI, more code than it
  saves).
- **1 explicitly considered and rejected**: `dotenvy` (zero-transitive-dep
  leaf crate, real regression risk in a secrets-adjacent path, not worth
  it).

That's **12–14 of roughly 65 declared dependencies** (~20%) addressable,
with the first 10 being pure deletions and zero rewrite risk. Everything
else in the tree is either heavily used, security/protocol-critical, or
covers real cross-platform complexity this project's own conventions
already say not to hand-roll.

No code was changed as part of this audit. Happy to implement the
deletions and/or the `nix`/`uuid` rewrites as a follow-up PR if wanted.
