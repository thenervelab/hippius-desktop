# Console mnemonic-blob design — desktop-optional decrypt

**Status:** draft for evaluation. Supersedes the earlier SPAKE2-pairing draft.
**Date:** 2026-04-13
**Repos touched:** `hcfs/` (server + client), `hippius-desktop/`, `hippius-console/`.

## Deliverable

A user who has set up sync on the Hippius desktop can later log into
Console (`console.hippius.com`) on a device that does not have the
desktop installed, download their encrypted files, and decrypt them in
the browser. **The desktop need not be running — or even installed —
at Console use time.**

## Decisions (locked)

| # | Decision | Why |
|---|---|---|
| 1 | Server holds a long-lived **encrypted mnemonic blob** per user. | Desktop-independence is the whole point of this feature. |
| 2 | Blob is encrypted under a key derived from a user-chosen **passphrase** via **Argon2id** (m≥128 MiB, t≥3). AEAD is **XChaCha20-Poly1305** (20 rounds, 192-bit random nonce). Algorithm identifiers are embedded in the `kdf` struct on the wire — AEAD is fixed at the server so no `aead` field travels in the body. | KDF is the only wall against offline brute force from a DB exfil. XChaCha20's 24-byte nonce eliminates any birthday-collision concern under random generation, even across rotations. |
| 3 | Passphrase never leaves the browser. Server sees only `{ciphertext, salt, nonce, kdf_params}`. | Preserves end-to-end encryption against a compromised backend. |
| 4 | Browser runs the same crypto as Rust via a WASM build of `hcfs-client`'s crypto module. | Single source of truth. |
| 5 | After first unlock, the mnemonic is **re-wrapped with a WebAuthn-PRF passkey** and stored in IndexedDB. **No other caching path exists.** Browsers without PRF (Chrome <116, Safari <18, Firefox, older Edge) see a "browser not supported" page and can't use Console. | Passphrase is typed once per device, not per session. No password ever persisted. Dropping the autofill fallback removes the weakest link — plaintext password in Keychain or Password Manager — entirely. |
| 6 | Recovery-phrase export is **forced** at desktop setup. | Passphrase has no reset — the mnemonic itself is the only recovery. |
| 7 | Downloading the blob requires OAuth **plus** a fresh WebAuthn assertion on enrolled devices. | OAuth-token theft alone can no longer fetch the blob. |
| 8 | **The user's SS58 address is the canonical identifier.** `mnemonic_blobs.user_id` is the SS58. The SS58 is bound into the AEAD as AAD on seal, and the browser asserts `derive_ss58(decrypted_mnemonic) === session_ss58` after unlock. | Prevents server-side blob swaps and guarantees the unlock flow can't silently mint a foreign identity. |
| 9 | **Blob flow is mandatory for OAuth users (they don't know their phrase) and optional for mnemonic users (who can type their phrase directly).** | Mnemonic users already have the secret and shouldn't be forced into a server-stored blob unless they want the convenience. |

## Architecture

```
┌────────────────────┐       ┌────────────────────┐       ┌────────────────────┐
│  hippius-desktop   │       │    hcfs-server     │       │  hippius-console   │
│  (Tauri + Rust)    │       │   (axum, SQLite)   │       │   (Next.js + WASM) │
│                    │       │                    │       │                    │
│  - prompts for     │       │  POST /v1/mnemonic │       │  - user enters     │
│    passphrase      │──────▶│  GET  /v1/mnemonic │◀──────│    passphrase      │
│  - Argon2id derive │       │  DEL  /v1/mnemonic │       │  - Argon2id decrypt│
│    wrap-key        │       │                    │       │  - decrypts files  │
│  - uploads blob    │       │  new DB table:     │       │    streamed from   │
│  - exports phrase  │       │  mnemonic_blobs    │       │    Arion via WASM  │
│    for recovery    │       │                    │       │  - optional passkey│
└────────────────────┘       └────────────────────┘       └────────────────────┘
         │                                                          ▲
         │                                                          │
         │          ┌──────────────────────────────────┐           │
         └─────────▶│  hcfs-client-wasm (new npm pkg)  │◀──────────┘
                    │  - mnemonic_to_seed              │
                    │  - derive_folder_mnemonic        │
                    │  - derive_file_key               │
                    │  - decrypt_file_chunk            │
                    │  - argon2id_derive               │
                    └──────────────────────────────────┘
```

## Work by repo

### `hcfs/` (server + client + new WASM crate)

**`hcfs-server`**

- New handler module `handlers/mnemonic_blob.rs` with three endpoints:
 - `POST /v1/mnemonic-blob` — body `{ ciphertext, salt, nonce, kdf_params }`. Upserts. OAuth-gated. Rate-limited (10 uploads / hour / user).
 - `GET /v1/mnemonic-blob` — returns the blob. OAuth-gated + (after first enrollment) requires a WebAuthn assertion (header `X-Passkey-Assertion`). Rate-limited (5 downloads / hour / user).
 - `DELETE /v1/mnemonic-blob` — removes the blob (used on rotation and account delete).
- New `mnemonic_blobs` table: `(user_id PK, ciphertext BLOB, salt BLOB, nonce BLOB, kdf_m INT, kdf_t INT, kdf_p INT, updated_at)`.
- WebAuthn credential table `passkeys(user_id, credential_id, public_key, created_at)` — per-device registration. One user may have many.
- Server never reads `ciphertext`. Storage only.

**`hcfs-client`**

- New module `src/mnemonic_blob.rs` with three public functions, all taking the plain mnemonic string + passphrase:
 - `seal_mnemonic(mnemonic, passphrase) -> SealedBlob`
 - `open_mnemonic(blob, passphrase) -> Zeroizing<String>`
 - `rotate_passphrase(old, new, server_client) -> Result<()>` (fetch, re-seal, upload, delete old)
- Argon2id via the `argon2` crate; ChaCha20-Poly1305 for the AEAD. Params embedded in the blob so the server never learns them.
- Zeroizing wrappers on every intermediate (passphrase, derived key, decrypted mnemonic).

**New crate `hcfs-client-wasm`** (workspace member)

- `wasm-bindgen` wrapper over the existing `hcfs-client` crypto and the new `mnemonic_blob` module.
- Exports: `mnemonic_to_seed`, `derive_folder_mnemonic`, `derive_file_key`, `decrypt_file_chunk`, `argon2id_derive`, `open_mnemonic`, `passkey_wrap`, `passkey_unwrap`.
- Built with `wasm-pack --target web`. Published as `@hippius/crypto-wasm` with SRI hash emitted by CI.
- Test vectors generated from Rust unit tests; a round-trip CI job ensures WASM decrypt of a Rust-encrypted blob matches byte-for-byte.

### `hippius-desktop/`

- **Settings page "Enable Console access"** under the existing settings dialog.
- Flow:
 1. Prompt for passphrase. Enforce ≥ 50 bits entropy via `zxcvbn`-style estimator. Reject common/top-10k.
 2. Call new Rust command `enable_console_access(passphrase)`:
 - fetch current mnemonic via existing `get_drive_mnemonic`,
 - `seal_mnemonic`,
 - POST to `/v1/mnemonic-blob`.
 3. Show the mnemonic one last time with a **mandatory** "I saved this offline" checkbox. Without the checkbox, the flow does not finish (blob remains NOT uploaded). This is the recovery backstop for "I forgot the passphrase."
- **Settings page "Change Console passphrase"** — calls `rotate_passphrase`.
- No change to existing sync, auth, or migration flows. The new command is strictly additive.

### `hippius-console/`

Already exists (Next.js, TypeScript, Tailwind). New pages/components:

- `/console-unlock` — if no mnemonic in memory and no passkey enrolled, prompt for passphrase. On submit: fetch blob → Argon2id derive → decrypt → hold in memory atom → (optional) offer passkey enrollment.
- `/files` — existing; add decrypt path:
 - `fetchFile(cid)` streams from Arion through a `DecryptTransformStream` backed by WASM.
 - `<img>`/`<video>` uses `URL.createObjectURL(blob)`; downloads use `<a download>`.
- **Passkey enrollment is mandatory** immediately after the first successful passphrase unlock. WebAuthn create call with the PRF extension. PRF output wraps a locally-generated AES key that encrypts the mnemonic in IndexedDB (`mnemonic_wrapped`). If enrollment fails or is declined, Console refuses to finish the unlock — nothing is cached.
- **Passkey unlock** on subsequent page loads: WebAuthn `get` with PRF → unwrap IndexedDB blob → mnemonic in memory.
- **No fallback path.** Browsers without WebAuthn PRF support (Chrome <116, Safari <18, Firefox, older Edge, many Android <14) are detected on first Console load via a feature-detect (`PublicKeyCredential.isConditionalMediationAvailable` + a probe `create` call with `prf` extension). Unsupported browsers get a dedicated page with the exact copy: **"Browser not supported, download/decrypting sync-engine files not supported."** Keeping one code path removes the weakest Keychain-storage option (plaintext password autofill) from the attack surface entirely.
- **Hardening**: strict CSP (`script-src 'self'`, no `unsafe-inline`, pinned `connect-src`), SRI on every script + the WASM fetch, `pnpm config set ignore-scripts true`, `minimumReleaseAge 1440`, no third-party scripts on any page that handles the mnemonic.

## User identification

The whole flow needs to know "who is this user?" at every hop. The
canonical answer everywhere on the Hippius backend, including the new
blob endpoints, is the **SS58 address** — the same identifier
`account_key()` already hashes for the `owner` column on every
desktop SQLite table.

### The SS58 is the primary key everywhere

- `mnemonic_blobs.user_id` = the user's SS58.
- `passkeys.user_id` = the user's SS58.
- All blob/passkey lookups go through SS58 — never email, never OAuth `sub`, never numeric id.

### Authentication

Every Console-blob endpoint authenticates via a single mechanism:
**`Authorization: Bearer <api_token>`**, same as every other
`hcfs-server` endpoint today. The server's `authenticate_caller`
verifies the token and returns the SS58 address the token was minted
for.

| Caller | Auth header | Server resolves SS58 via |
|---|---|---|
| Desktop (mnemonic or OAuth user) | `Authorization: Bearer <api_token>` (existing `get_api_token` store) | `verify_token` → SS58 |
| Console browser | `Authorization: Bearer <api_token>` (Console's OAuth flow mints one) | `verify_token` → SS58 |

No sr25519 signatures, no bespoke signing headers. The desktop
already has a bearer token in its session store and `state.api_client`
already attaches it to outgoing HTTP requests.

Admin tokens (existing server concept) are accepted at the transport
layer but rejected by the blob endpoints: an admin cannot upload or
fetch a blob on behalf of a user. The `resolve_caller` helper returns
`403 Forbidden` when `authenticate_caller` produces `None` (the
admin-token sentinel).

### `oauth_sub → ss58` mapping

The server keeps an `oauth_sub → ss58_address` table so that server-
side admin tooling and future cross-system lookups can resolve one
from the other. The desktop's `enable_console_access` flow POSTs this
binding to `/v1/users/bind` (bearer-authenticated) right after
generating an OAuth user's mnemonic. One write, idempotent on the
unique index.

```sql
CREATE TABLE IF NOT EXISTS users (
 oauth_sub TEXT PRIMARY KEY NOT NULL,
 ss58_address TEXT NOT NULL UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX users_ss58_idx ON users(ss58_address);
```

The bearer-auth model means this mapping is not strictly required on
the request path — the server already knows the caller's SS58 from
the token. The binding exists for operational observability and for
future flows (e.g. "which SS58 owns this OAuth account?") that
shouldn't round-trip through the token service.

### Bind the SS58 inside the blob (defense in depth)

A malicious or compromised server could swap user A's blob for user
B's. Crypto-bind the SS58 inside the blob so the swap is detected:

1. **Seal-time:** `seal_mnemonic(mnemonic, passphrase, ss58)` runs ChaCha20-Poly1305 with `aad = ss58_bytes`. The server stores `aad` alongside `ciphertext / salt / nonce` so it can echo it back.
2. **Open-time (browser):** `open_mnemonic_blob(blob, passphrase, expected_ss58 = session.ss58)` passes `expected_ss58` as AAD. AEAD tag mismatch if the server returned someone else's blob.
3. **Post-unlock check:** browser derives SS58 from the decrypted mnemonic and asserts `derive_ss58(mnemonic) === session.ss58`. Catches any swap that bypasses the AAD check.

Either step alone catches the attack; both together is two
independent layers.

### What the user is for mnemonic-only desktop users

Mnemonic-auth desktop users already know their seed phrase. They have
two paths to use Console:

- **Type the phrase on Console.** Bypasses the blob entirely — Console accepts the phrase, derives SS58 locally, asserts it matches the OAuth/login session, proceeds to passkey enrollment as in the OAuth flow.
- **Opt into the blob flow** for convenience (don't type 24 words on every new device). Same `enable_console_access` Tauri command, same passphrase prompt.

OAuth users have only one path because they don't know their phrase:
the blob flow.

## Keychain storage — the evaluation

The user's explicit question: "Can we store the password in the macOS Keychain so the browser reads it?" Let me answer fully.

### The hard constraint

**A browser page cannot call macOS Keychain APIs directly.** The browser sandbox blocks all native OS APIs for security. There are only three ways to get credential data onto macOS Keychain from a web page, ranked here by security:

### Option K1 — Browser password autofill (backs onto Keychain on Safari)

How it works: a standard `<input type="password" autocomplete="current-password">`. The browser prompts to save; next visit, autofills.

- **Safari on macOS/iOS** stores into the user's macOS Keychain and syncs via iCloud Keychain.
- **Chrome** stores in Google Password Manager (a separate store). Some users enable "iCloud Passwords for Chrome," which syncs through Apple's iCloud — still going to Keychain, just via Apple's extension.
- **Firefox** uses its own encrypted store (not Keychain).

Security:
- Any JS on `console.hippius.com` can read the autofilled value. XSS = leak. CSP + no-third-party-scripts mitigates.
- Phishing on a look-alike domain doesn't trigger autofill (origin-bound) but a user may still type.
- No biometric gate on retrieval — Safari just fills.

**Verdict:** Worst of the three viable options. The password is in plaintext in Keychain (or Google's store) permanently. Any malicious browser extension with host access reads it.

### Option K2 — Browser Credential Management API

`navigator.credentials.store({ password })` / `.get()`. Same backing store as K1 (autofill) on each browser, but programmatically controlled. Gives us code-level control over when to prompt.

**Verdict:** Strictly equal to K1 security-wise, slightly better UX. If we're going to use Keychain-via-autofill, we should use the Credential Management API so the interaction is explicit.

### Option K3 — WebAuthn passkey with PRF extension (recommended)

This is the one that actually leverages the macOS Keychain in its strongest form. On Safari, passkeys are stored in the user's Keychain, hardware-backed on Apple Silicon / T2 via the Secure Enclave. Touch ID unlocks them. iCloud Keychain syncs passkeys across the user's devices.

Instead of storing the **password** in Keychain, we store the **mnemonic wrapped by a passkey-derived key** in IndexedDB, and the passkey lives in Keychain:

1. First unlock: user types passphrase (once). Decrypts server blob. Mnemonic in memory.
2. Offer "Enable Touch ID on this device." User accepts. `navigator.credentials.create({ publicKey: { ..., extensions: { prf: { eval: { first: "hippius-mnemonic-wrap-v1" } } } }})` — creates a passkey bound to `console.hippius.com`, stored in Keychain.
3. PRF output is a 32-byte value that Keychain will release only on a live user-presence check (Touch ID, or Face ID / Windows Hello on those platforms).
4. We AEAD-encrypt the mnemonic with that PRF output and store the ciphertext in IndexedDB.
5. Future visits: `navigator.credentials.get(... prf: { eval })` → Touch ID → PRF → unwrap mnemonic → mnemonic in memory. The passphrase is never typed again on this device.

Security:
- **Passphrase is never persisted anywhere.** Only the user's memory holds it.
- **Keychain-backed.** The mnemonic-wrapping key lives in Secure Enclave/TPM, released only on biometric/user presence.
- **Origin-bound.** Keychain will not release the PRF output to any other origin. Phishing is cryptographically prevented in the unwrap step.
- **Sync across devices.** iCloud Keychain syncs passkeys, so a user who enrolls on Mac also has Touch ID on iPhone with the same passkey — without the mnemonic ever re-traversing the network.
- **Revocable.** Removing the passkey in system settings invalidates the wrapped blob.

Caveats:
- WebAuthn PRF is recent: Chrome 116+ (Aug 2023), Safari 18+ (Sep 2024), Edge 116+. Firefox has partial support. We need the K1/K2 fallback for older browsers.
- One passkey per (origin, device) in the simplest flow. iCloud Keychain sync lifts this to one passkey per Apple ID.
- If the user deletes the passkey or the IndexedDB ciphertext, they fall back to typing the passphrase again — not catastrophic, but a UX nick.

**Verdict: this is the answer to "how do I use the Keychain here without weakening the design."** The thing stored in Keychain is the passkey (hardware-bound, biometric-gated, origin-bound), not the password (soft, autofilled, exfiltratable).

### The failed options (ruled out, for the record)

- **K4 — Desktop app as localhost bridge for Keychain.** Desktop runs a local HTTP server, browser queries it, desktop returns a secret from Keychain. **Fails the deliverable — requires desktop installed and running.**
- **K5 — Browser extension with native messaging.** We ship a Hippius extension that can call macOS Keychain via a helper binary. Users must install the extension; we must maintain extension-store listings for Chrome, Firefox, Safari. **Large ongoing cost for marginal benefit over K3.**
- **K6 — Direct Keychain API from Web.** Not possible. The browser sandbox disallows it.

### The recommendation

Ship **K3 (WebAuthn PRF passkey) only.** No K1 autofill fallback, no K2 Credential-Management-API fallback. Browsers without PRF support are shown a page with the exact copy: **"Browser not supported, download/decrypting sync-engine files not supported."**

The passphrase itself is never put into Keychain. The passkey (which wraps the mnemonic) lives in Keychain. Dropping the fallback path eliminates the weakest link — a plaintext password saved in the browser's password manager — from the design entirely. It also keeps the codebase single-pathed: one unlock flow, one caching flow, one test matrix.

### Supported browsers at launch

- Chrome 116+ (Aug 2023) — desktop, Android (PRF on Android 14+).
- Safari 18+ (Sep 2024) — macOS Sequoia, iOS 18.
- Edge 116+.

Firefox has partial WebAuthn support but no PRF at time of writing — unsupported. Any user on an older or unsupported browser gets a single-line page: **"Browser not supported, download/decrypting sync-engine files not supported."**

## Threat model summary

| Threat | Protection |
|---|---|
| Server DB exfiltrated | Argon2id (m=128 MiB, t=3) on strong passphrase ≈ unfeasible to brute force |
| OAuth token stolen | Blob download requires WebAuthn assertion after enrollment |
| Console origin XSS | Strict CSP + no third-party JS + SRI on WASM. Passphrase enters one input field on one page. |
| Supply-chain attack on an npm dep | `ignore-scripts`, pinned versions, `minimumReleaseAge 1440`, `pnpm audit` |
| User's device stolen | Biometric required to unwrap IndexedDB ciphertext (K3); falls back to passphrase re-entry (K2) |
| User forgets passphrase | Forced recovery-phrase export at desktop setup — user pastes mnemonic back, skipping server blob |
| Fake `consoie.hippius.com` phishing | Passkey is origin-bound, won't assert on a different origin |
| Insider / malicious backend | Cannot read blob (ciphertext only); cannot serve tampered WASM (SRI check fails) |

## Phases and estimate

| # | Work | Repo | Days |
|---|---|---|---|
| 1 | `hcfs-client::mnemonic_blob` module (seal/open/rotate) + unit tests with Argon2id vectors | `hcfs/` | 1–2 |
| 2 | `hcfs-client-wasm` crate: wasm-bindgen exports, `wasm-pack` build, CI tarball with SRI, round-trip test vectors | `hcfs/` | 2 |
| 3 | Server endpoints + `mnemonic_blobs` + `passkeys` tables + rate limits + OAuth/WebAuthn gating | `hcfs/` | 2–3 |
| 4 | Desktop "Enable Console access" + "Change passphrase" pages + `enable_console_access` Rust command + forced recovery-phrase export | `hippius-desktop/` | 2 |
| 5 | Console unlock page: passphrase form, Argon2id in WASM, decrypt + memory atom | `hippius-console/` | 2 |
| 6 | Console passkey enrollment + PRF wrap/unwrap + IndexedDB store | `hippius-console/` | 2 |
| 7 | Console files page decrypt path: stream from Arion → WASM → Blob/URL. Large-file streaming default. | `hippius-console/` | 2–3 |
| 8 | Console hardening: CSP, SRI on WASM, dep audit, `ignore-scripts`, pairing-page copy, no-third-party-JS audit | `hippius-console/` | 1 |
| 9 | E2E: real desktop seals, real Console opens, decrypts a real file. MITM-tamper test. Brute-force sanity test. | all three | 2 |

**Total: ~16–19 days.** The WASM crate and server endpoints are on the critical path; desktop and Console work can parallelize once phase 2 lands.

## Risks, ranked

1. **Weak user passphrases**, full stop. Enforce strength in UI (zxcvbn ≥ 3, 50-bit minimum, diceware suggestion). Still imperfect. Own it in docs.
2. **Crypto drift between Rust and WASM.** Mitigation: shared CI test vectors on every build.
3. **WebAuthn PRF availability.** Recent extension. Unsupported browsers blocked with an "update your browser" page — we explicitly chose not to ship a fallback because the only non-passkey caching path (browser password autofill) is the weakest storage option and would undercut the security tier we're targeting.
4. **Recovery path discoverability.** Users who skip the "I saved my phrase offline" checkbox somehow, then forget passphrase, are unrecoverable. Make the checkbox blocking.
5. **Large-file memory.** Streaming must be the default path, not an opt-in.
6. **Passkey lost.** User clears browser data or loses device — falls back to passphrase. Acceptable, must be documented.
7. **Account deletion.** Must cascade-delete `mnemonic_blobs` and `passkeys` rows.

## Open questions

1. **hcfs-server WebAuthn stack**: does the server already have an auth library that supports WebAuthn assertions, or do we add `webauthn-rs`? (Adds one dep; well-maintained.)
2. **iCloud Keychain sync scope**: passkeys sync by Apple ID, not by Hippius account. If user A and user B share an Apple ID, passkeys could cross-enroll. Probably acceptable (they're already sharing a device), but document.
3. **Android / Windows passkey parity**: PRF is supported on Windows 11 (Hello) and Android 14+. Older platforms are **blocked** by design (no fallback) — confirm the product team is OK with that eligibility cut.
4. **Rate limits**: 5 downloads/hour/user. Is this too strict for users who clear browser state frequently?

## Decision awaited

Before implementation:
- Confirm the threat-model tier (password-blob with PRF passkey + forced recovery backup) is acceptable.
- Confirm the ~16–19-day estimate fits the delivery window.
- Answer the four open questions.
- Resolve whether we also want a SPAKE2-pairing flow alongside (defensive users) or this is the only path.
