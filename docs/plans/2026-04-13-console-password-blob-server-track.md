# Console mnemonic blob — server / producer track

**Owner:** hcfs + hippius-desktop teams
**Repos:** `hcfs/`, `hippius-desktop/`
**Companion plan:** `2026-04-13-console-password-blob-browser-track.md` (Console team)
**Design reference:** `2026-04-13-console-password-blob-design.md` (threat model, KDF parameters, full architecture)

This plan covers everything the **producer** side needs to ship: the
encrypted-mnemonic blob storage, the crypto library shared with the
browser, and the desktop UI that lets a user enable Console access.

## What this track delivers

1. A versioned npm package (`@hippius/crypto-wasm`) the Console team
 can install. This is the integration contract — once it ships, the
 browser team is unblocked.
2. Three new HTTP endpoints on `hcfs-server` for storing and fetching
 the encrypted mnemonic blob, with WebAuthn-passkey gating.
3. A new desktop settings page where a user enables Console access by
 setting a passphrase and confirming an offline mnemonic backup.

The browser team needs **none** of this implementation detail beyond
the API contracts in §4 and §5.

## 0. User identification (foundational — read first)

The whole flow keys on the user's **SS58 address**. This affects the
table schemas, the API signatures, and the seal/open functions below
— so it sits ahead of every other section in this plan.

- `mnemonic_blobs.user_id` and `passkeys.user_id` are SS58 strings.
- The seal binds the SS58 into the AEAD as AAD so a server-side blob
 swap is cryptographically detectable on unlock.
- Every caller (desktop and Console) authenticates with
 `Authorization: Bearer <api_token>`. The server's existing
 `authenticate_caller` → `verify_token` pipeline resolves the SS58.
 No new signing scheme, no sr25519-signed bodies.

A `users(oauth_sub, ss58_address)` table is kept for operational
observability (admin tooling, future cross-system lookups). The
desktop's `enable_console_access` flow posts to `POST /v1/users/bind`
immediately after generating an OAuth user's mnemonic. Idempotent on
the unique constraint. Because auth is bearer-token only, the binding
is not required on the request path — the server already knows the
caller's SS58 from the token.

```sql
CREATE TABLE IF NOT EXISTS users (
 oauth_sub TEXT PRIMARY KEY NOT NULL,
 ss58_address TEXT NOT NULL UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX users_ss58_idx ON users(ss58_address);
```

## 1. `hcfs-client::mnemonic_blob` — the producer crypto

New module at `hcfs/hcfs-client/src/mnemonic_blob.rs`. Wraps the
existing `hcfs-client` crypto with passphrase-based sealing.

```rust
/// Byte fields are base64-encoded on the JSON wire. The `SealedBlob`
/// `Serialize` impl handles the encoding — callers pass raw bytes to
/// `seal_mnemonic` and receive a ready-to-POST struct.
pub struct SealedBlob {
 pub ciphertext: String, // base64 of 16-byte Poly1305 tag + ct
 pub salt: String, // base64 of 16 random bytes
 pub nonce: String, // base64 of 24 random bytes (XChaCha20)
 pub aad: String, // base64 of SS58 bytes — bound into AEAD
 pub kdf: KdfParams,
}

pub struct KdfParams {
 pub algorithm: String, // "argon2id"
 pub memory_kib: u32, // 131_072 (128 MiB)
 pub time_cost: u32, // 3
 pub parallelism: u32, // 1
}
```

AEAD is fixed at XChaCha20-Poly1305 server-side; there is no `aead`
field in the wire body. If we ever need an algorithm transition, we
bump the blob wire version in a new top-level field rather than
branching on an embedded identifier.

/// `ss58` is bound into the AEAD as AAD so a server-side blob swap
/// fails the AEAD tag check on the next `open_mnemonic`.
pub fn seal_mnemonic(mnemonic: &str, passphrase: &str, ss58: &str) -> Result<SealedBlob>;

/// `expected_ss58` MUST be the SS58 the caller believes owns this
/// blob (from their session). Mismatch surfaces as `Error::AeadTag`,
/// not as a "wrong passphrase" error.
pub fn open_mnemonic(
 blob: &SealedBlob,
 passphrase: &str,
 expected_ss58: &str,
) -> Result<Zeroizing<String>>;

pub fn rotate_passphrase(
 blob: &SealedBlob,
 old: &str,
 new: &str,
 ss58: &str,
) -> Result<SealedBlob>;
```

- KDF: `argon2` crate with the params above. Salt is fresh per seal.
- AEAD: `chacha20poly1305::XChaCha20Poly1305` (20 rounds, 24-byte random nonce). AAD = SS58 bytes.
- `kdf.algorithm` string is embedded in the blob so the opener can reject unknown KDFs. AEAD is fixed at XChaCha20-Poly1305 — no identifier travels with the blob; a future algorithm change bumps a top-level version field rather than inline dispatch.
- All intermediate buffers wrapped in `Zeroizing`.
- Test vectors fixed in `tests/mnemonic_blob_vectors.rs` so the WASM
 build can assert byte-identical outputs. Vectors include a
 cross-SS58 negative case (sealed under SS58 A, decrypt with SS58 B
 must fail with `AeadTag`).

**Acceptance:** `cargo test -p hcfs-client mnemonic_blob` round-trips
seal/open across 200 randomized passphrases, 5 frozen vectors, and
the cross-SS58 negative test.

## 2. New crate `hcfs-client-wasm` — the npm package

New workspace member at `hcfs/hcfs-client-wasm/`. `wasm-bindgen`
exports over `hcfs-client`.

```ts
// What the npm package surfaces
export function mnemonic_to_seed(phrase: string): Uint8Array; // 64 bytes
export function derive_folder_mnemonic(master: string, label: string): string;
export function derive_file_key(folder_mnemonic: string, cid: string): Uint8Array;
export function decrypt_file_chunk(
 key: Uint8Array,
 nonce: Uint8Array,
 aad: Uint8Array,
 ciphertext: Uint8Array,
): Uint8Array;
export function argon2id_derive(
 passphrase: string,
 salt: Uint8Array,
 memory_kib: number,
 time_cost: number,
 parallelism: number,
): Uint8Array; // 32 bytes
export function open_mnemonic_blob(
 blob: { ciphertext: Uint8Array; salt: Uint8Array; nonce: Uint8Array; kdf: KdfParams },
 passphrase: string,
): string;
```

**Build & publish:**
- `wasm-pack build --target web --release`.
- CI emits a versioned tarball (`@hippius/crypto-wasm@0.1.0`) and an
 SRI hash (`sha384-...`) the Console team pins.
- Test vectors generated by `hcfs-client` tests are bundled and a CI
 job runs them through the WASM build to assert byte-identical
 outputs every commit.

**Versioning:** Semver. The browser pins an exact version; major
bumps for any wire-format change.

**Size budget:** initial release < 500 KB gzipped. Profile and
optimize if it's larger.

**Acceptance:** the npm tarball builds in CI, SRI hash is recorded,
and round-trip tests pass on every PR. The Console team can install
and import successfully.

## 3. `hcfs-server` — three endpoints + tables

### 3a. New table `mnemonic_blobs`

`user_id` is the **SS58 address**, not OAuth `sub` or numeric id. The
server resolves the SS58 from whichever auth header the caller used
(see §3c).

```sql
CREATE TABLE mnemonic_blobs (
 user_id TEXT PRIMARY KEY NOT NULL, -- SS58 address
 ciphertext BYTEA NOT NULL,
 salt BYTEA NOT NULL, -- 16 bytes, Argon2id salt
 nonce BYTEA NOT NULL, -- 24 bytes, XChaCha20 nonce
 aad BYTEA NOT NULL, -- SS58 bytes, echoed back on GET
 kdf_algorithm TEXT NOT NULL, -- "argon2id"
 kdf_memory_kib INTEGER NOT NULL,
 kdf_time_cost INTEGER NOT NULL,
 kdf_parallelism INTEGER NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

(Postgres flavor — `hcfs-server` runs Postgres. SQLite-flavored
`BLOB` / `TIMESTAMP DEFAULT CURRENT_TIMESTAMP` is the equivalent if
this plan is ever ported.)

### 3b. New table `passkeys`

`user_id` is the SS58 address. One user may register many passkeys
(one per device).

```sql
CREATE TABLE passkeys (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id TEXT NOT NULL, -- SS58 address
 credential_id BLOB NOT NULL UNIQUE,
 public_key BLOB NOT NULL,
 sign_count INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_used_at TIMESTAMP
);
CREATE INDEX passkeys_user_id_idx ON passkeys(user_id);
```

### 3c. New handler module `handlers/console_blob.rs`

Three endpoints. All authenticate via `Authorization: Bearer
<api_token>` — the same header every other `hcfs-server` endpoint
uses. `resolve_caller` delegates to the existing
`auth::authenticate_caller` and returns the caller's SS58 address;
admin tokens (which return `None`) are rejected with 403 because
admins cannot act on behalf of a specific user's blob.

| Method | Path | Body / Headers | Notes |
|---|---|---|---|
| `POST` | `/v1/mnemonic-blob` | `{ ciphertext, salt, nonce, aad, kdf: { algorithm, memory_kib, time_cost, parallelism } }` (base64 strings in JSON). Server stores `user_id = caller_ss58`. | Upserts. Rate limit: 10 / hour / user. |
| `GET` | `/v1/mnemonic-blob` | Header `X-Passkey-Assertion: <b64>` required if `passkeys` has any rows for the caller's SS58. First fetch (no passkey enrolled yet) accepts bearer alone. Rate limit: 5 / hour / user. | Returns the same shape as POST body. |
| `DELETE` | `/v1/mnemonic-blob` | — | Removes the row. Used on rotation completion (after new POST) and on account deletion. |

Validation constants (enforced on POST):
- `MAX_CIPHERTEXT_BYTES = 1024` — mnemonic ciphertext is ~220 bytes; the cap rejects accidental abuse without boxing real data in.
- `EXPECTED_SALT_BYTES = 16`, `EXPECTED_NONCE_BYTES = 24` — exact-size checks; reject mismatches with 400.
- `MAX_AAD_BYTES = 256` — SS58 addresses are ~48 bytes.

### 3d. New passkey endpoints

All resolve SS58 via `resolve_caller_ss58` (sr25519 OR OAuth). Stored
rows are keyed by SS58.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/passkey/registration-challenge` | Returns a fresh WebAuthn challenge bound to the caller's SS58. |
| `POST` | `/v1/passkey/register` | Body: WebAuthn attestation. Stores in `passkeys` with `user_id = caller_ss58`. |
| `POST` | `/v1/passkey/assertion-challenge` | Returns a challenge for blob download. |
| `DELETE` | `/v1/passkey/{id}` | Revoke a passkey. The row's `user_id` must match `caller_ss58`. |

Use the `webauthn-rs` crate for verification.

### 3e. New `users` binding endpoint

```
POST /v1/users/bind
Auth: Authorization: Bearer <api_token>
Body: { oauth_sub: string, ss58_address: string }
Behavior: upsert into `users(oauth_sub, ss58_address)`. Idempotent on
the unique index. The server rejects with 403 if the caller's SS58
(resolved from the bearer token) does not match `body.ss58_address`
— the caller can only bind their own SS58.
```

Called by the desktop right after it generates an OAuth user's
mnemonic. For mnemonic-only users (no OAuth) this endpoint is a
no-op and the desktop skips it.

### 3e. Cascade and rate limits

- Account deletion: delete `mnemonic_blobs` + `passkeys` rows.
- Rate limits enforced via the existing middleware (see `src/middleware.rs`).
- All endpoints return structured JSON errors matching `ErrorResponse`.

**Acceptance:** integration tests in `hcfs/hcfs-e2e-tests/` cover:
seal → upload → fetch (no passkey) → enroll passkey → fetch (assertion required) → fetch without assertion fails 401 → delete blob → fetch 404.

## 4. The contract the browser team consumes

Three things, frozen once §1–§3 land:

1. **REST API** — the four endpoints above, with their JSON shapes.
 Documented in OpenAPI in `hcfs/hcfs-server/openapi.yaml`.
2. **WASM API** — the TypeScript signatures in §2.
3. **Wire format for the blob** — the `SealedBlob` struct with its
 base64 JSON encoding.

The browser team can mock these and start work in parallel. They
should not assume anything about Argon2id parameters or AEAD choice
beyond what the WASM API exposes.

## 5. Desktop "Enable Console access"

Repo: `hippius-desktop/`. Depends on §1.

### 5a. New Rust commands

```rust
// src-tauri/src/console_access/mod.rs

#[tauri::command]
pub async fn enable_console_access(
 state: tauri::State<'_, AppState>,
 passphrase: String,
) -> Result<(), AppError>;

#[tauri::command]
pub async fn rotate_console_passphrase(
 state: tauri::State<'_, AppState>,
 old_passphrase: String,
 new_passphrase: String,
) -> Result<(), AppError>;

#[tauri::command]
pub async fn console_access_status(
 state: tauri::State<'_, AppState>,
) -> Result<ConsoleAccessStatus, AppError>;
```

`enable_console_access` flow:

1. Resolve mnemonic via existing `get_mnemonic_for_account`.
2. Resolve the active SS58 from `state.auth.lock()?.substrate_address`.
3. Validate passphrase entropy (≥ 50 bits via a `zxcvbn`-style estimator). Reject top-10k common passwords.
4. `hcfs_client::mnemonic_blob::seal_mnemonic(mnemonic, passphrase, ss58)` — SS58 is bound into the AEAD as AAD.
5. If this is an OAuth user, also `POST /v1/users/bind { oauth_sub, ss58 }` for operational observability. Idempotent — no-op on subsequent calls.
6. `POST /v1/mnemonic-blob { ciphertext, salt, nonce, aad, kdf }` via `state.api_client`. Bearer-authenticated — same token the sync engine already uses.
7. Zeroize passphrase + intermediate buffers on drop.

### 5b. New settings page

`app/(pages)/settings/console-access/` (or as a tab in the existing settings dialog).

Three states:

- **Not enabled** — explainer + "Enable Console access" button → modal collects passphrase (twice) + entropy meter.
- **Enabled** — shows passphrase last-rotated date + buttons "Rotate passphrase" and "Disable Console access".
- **In progress** — disable controls during the IPC.

After successful `enable_console_access`:

1. Show the user's mnemonic on screen one final time.
2. Mandatory checkbox: **"I have saved my recovery phrase offline. I understand that without it AND without my passphrase, I cannot recover my files."**
3. Until the checkbox is ticked, the page does not return to the "Enabled" state and a banner reminds them.

### 5c. Acceptance

Manual:
- Enable → blob lands on staging `hcfs-server`.
- Restart desktop → `console_access_status` reports enabled.
- Rotate → old blob deleted, new uploaded; old passphrase no longer opens the new blob.
- Forced backup checkbox actually blocks completion until ticked.

Automated:
- `cargo test -p tauri-app console_access` — IPC contract, error
 mapping (`InvalidPassphrase`, `MnemonicUnrecoverable`, etc.).

## 6. Phases and order

Strict critical path:

| # | Work | Days | Blocks |
|---|---|---|---|
| 1 | `hcfs-client::mnemonic_blob` + tests | 1–2 | 2, 5 |
| 2 | `hcfs-client-wasm` crate + npm publish + SRI hash | 2 | Browser track |
| 3 | `hcfs-server` endpoints + tables + tests | 2–3 | 5, Browser track |
| 4 | `hcfs-server` passkey endpoints | 1–2 | Browser track passkey flow |
| 5 | Desktop "Enable Console access" page + Rust commands | 2 | — |

Phases 1 and 3 can run in parallel after the team is briefed on the
SealedBlob format. Phase 5 starts as soon as phase 1 lands.

**Track A total: 8–11 engineering days.**

## 7. Rollout

- Server endpoints behind a feature flag (`HCFS_FEATURE_CONSOLE_BLOB=1`)
 until Console announces ready.
- Desktop settings page hidden behind a frontend feature flag while
 the staging Console proves the round trip.
- npm package published as `0.1.0` then bumped to `1.0.0` only after
 the Console team has integrated and the contract is frozen.

## 8. Out of scope for this track

- Anything in the browser. The Console team owns it.
- WebAuthn ceremony orchestration (creating challenges, verifying
 assertions) beyond the server endpoints — the browser drives.
- File decrypt UI. The browser owns that, calling the WASM crate.

## 9. Open questions

1. Does `hcfs-server` already use a WebAuthn library? If yes, reuse.
 If no, `webauthn-rs 0.5+` is the canonical pick.
2. Are passphrase entropy checks centralized, or do desktop and
 Console each implement? Recommend a small shared crate
 (`hippius-passphrase-policy`) so the rule is identical on both
 sides — but acceptable to duplicate at v1.
3. SQLite vs Postgres — the schema above is SQLite-flavored. If
 `hcfs-server` is on Postgres, the `BLOB` columns become `BYTEA`,
 and `INTEGER PRIMARY KEY AUTOINCREMENT` becomes `BIGSERIAL`.
