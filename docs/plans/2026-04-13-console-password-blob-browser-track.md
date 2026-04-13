# Console mnemonic blob — browser / consumer track

**Owner:** hippius-console team
**Repo:** `hippius-console/`
**Companion plan:** `2026-04-13-console-password-blob-server-track.md` (server + WASM + desktop)
**Design reference:** `2026-04-13-console-password-blob-design.md` (threat model, KDF parameters, full architecture)

This plan covers everything Console needs to ship: the unlock flow,
the passkey enrollment and unlock, the file-decrypt path, and the
browser-hardening pass.

## What this track delivers

1. A `/console-unlock` page that takes a passphrase, downloads the
 user's encrypted-mnemonic blob, decrypts in WASM, and holds the
 mnemonic in memory.
2. A mandatory passkey-enrollment step that re-wraps the mnemonic
 with a WebAuthn-PRF-derived key and stores the wrapped blob in
 IndexedDB. Subsequent visits unlock with Touch ID / Face ID /
 Windows Hello — no passphrase re-entry on the same device.
3. The existing files page wired to fetch from Arion and decrypt
 through the WASM crate (streaming for large files).
4. A "browser not supported" gate that blocks unsupported browsers
 with the exact copy: **"Browser not supported, download/decrypting
 sync-engine files not supported."**
5. A hardening pass: strict CSP, SRI on all scripts and the WASM
 fetch, no third-party JS on mnemonic pages, supply-chain locks.

## What you depend on

The server track delivers two things you consume — you can mock both
locally and start work in parallel:

1. **`@hippius/crypto-wasm` npm package** — TypeScript signatures
 below. Pin an exact version with SRI.
2. **REST API** — five endpoints, OAuth-gated, on `api.hippius.com`.

### WASM API surface

```ts
import init, {
 mnemonic_to_seed,
 derive_folder_mnemonic,
 derive_file_key,
 decrypt_file_chunk,
 argon2id_derive,
 open_mnemonic_blob,
 derive_ss58_from_mnemonic,
} from "@hippius/crypto-wasm";

await init(); // loads .wasm with SRI verification

// Decrypt the server blob with the user's passphrase. `expectedSs58`
// is bound into the AEAD as AAD on seal; mismatch fails the AEAD tag
// check and surfaces as `Error("AeadTag")` — distinct from a wrong
// passphrase ("InvalidPassphrase").
const mnemonic: string = open_mnemonic_blob(blob, passphrase, expectedSs58);

// Defense in depth: re-derive SS58 from the decrypted mnemonic and
// confirm it matches the OAuth session's SS58 before caching.
if (derive_ss58_from_mnemonic(mnemonic) !== expectedSs58) {
 throw new Error("Mnemonic does not match session identity");
}

// Per-folder key derivation
const folderMnemonic = derive_folder_mnemonic(mnemonic, label);

// Per-file key + decrypt
const key = derive_file_key(folderMnemonic, cid);
const plaintext = decrypt_file_chunk(key, nonce, aad, ciphertext);
```

### REST API contract

All Console-side requests use `Authorization: Bearer <oauth-token>`.
The server resolves the caller's SS58 from the OAuth `sub` via its
`users` table (populated by the desktop on signup). Console never
needs to know the SS58 *before* unlock — the server handles the
mapping. *After* unlock, Console derives SS58 locally from the
decrypted mnemonic and asserts it matches what the session backend
reports.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/passkey/registration-challenge` | Get challenge for `navigator.credentials.create`. |
| `POST` | `/v1/passkey/register` | Submit attestation. Server stores under the resolved SS58. |
| `POST` | `/v1/passkey/assertion-challenge` | Get challenge for `navigator.credentials.get`. |
| `GET` | `/v1/mnemonic-blob` | Returns `{ ciphertext, salt, nonce, aad, kdf }`. `aad` is the SS58 bytes the desktop bound at seal time. Header `X-Passkey-Assertion: <b64>` required after first enrollment. |
| `GET` | `/v1/me` | Returns `{ ss58_address: string }` — the SS58 the server has on file for the OAuth user. Used by Console to obtain `expectedSs58` before calling `open_mnemonic_blob`. |
| `DELETE` | `/v1/passkey/{id}` | Revoke. |

Mock these from a local fixture server while waiting for the real
endpoints to land on staging.

## 1. Browser-support gate

Runs on every Console route load, before any other Console code:

```ts
async function isPasskeyPrfSupported(): Promise<boolean> {
 if (typeof PublicKeyCredential === "undefined") return false;
 if (!PublicKeyCredential.isConditionalMediationAvailable) return false;
 // Probe by attempting a minimal create() with the PRF extension
 // and inspecting the result. Cached in sessionStorage after first
 // successful detection so the probe runs at most once per tab.
 // …
}
```

If unsupported, render a single page with the exact copy:
**"Browser not supported, download/decrypting sync-engine files not supported."** No links, no fallback path.

Implementation: a top-level Next.js layout guard at
`src/app/(authed)/layout.tsx`.

## 2. Unlock flow

Page: `src/app/console-unlock/page.tsx`.

State machine:

```
LandingCheck → CheckSupport → CheckUnwrapped → PromptPassphrase → Decrypting → EnrollingPasskey → Done
                    │              │                                                │
                    │              └─ if IndexedDB has wrapped → UnwrappingWithPasskey → Done
                    └─ if unsupported → render the gate page from §1
```

### 2a. CheckUnwrapped

Look in IndexedDB (`hippius_console.mnemonic_wrapped`):

- **Found** → run a WebAuthn `get` with PRF, derive unwrap key, decrypt the IndexedDB ciphertext, hand the mnemonic to the in-memory atom. Done.
- **Missing** → render the passphrase form.

### 2b. PromptPassphrase

Single password input. On submit:

1. `GET /v1/me` → cache the server's view of `session.ss58_address`. Done once per session.
2. `GET /v1/mnemonic-blob` → `{ciphertext, salt, nonce, aad, kdf}`.
3. `argon2id_derive(passphrase, salt, mem, time, parallelism)` — WASM-side, UI shows a "Deriving key (~1.5s)" spinner.
4. `open_mnemonic_blob(blob, passphrase, session.ss58_address)` — passes the SS58 as expected AAD. Outcomes:
 - `Ok(mnemonic)` → continue.
 - `Err("InvalidPassphrase")` → toast, stay on the page, rate-limit the submit button (1s cooldown).
 - `Err("AeadTag")` → **abort with a hard error**, don't retry. The server returned a blob whose AAD doesn't match the session SS58 — possible blob swap. Surface a "Session integrity check failed, please contact support" message and log the incident.
5. `derive_ss58_from_mnemonic(mnemonic) === session.ss58_address` — second-layer assertion. Same failure handling as the AAD mismatch.

### 2c. EnrollingPasskey (mandatory)

Right after a successful decrypt, before the user can proceed:

```ts
const cred = await navigator.credentials.create({
 publicKey: {
 challenge: ..., // from /v1/passkey/registration-challenge
 rp: { name: "Hippius Console", id: "console.hippius.com" },
 user: { id: ..., name: userEmail, displayName: userName },
 pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
 authenticatorSelection: { residentKey: "required", userVerification: "required" },
 extensions: { prf: { eval: { first: prfSeed } } },
 },
});
```

- `prfSeed` is a fixed app-wide string: `"hippius-mnemonic-wrap-v1"` (UTF-8 bytes). Treated as a domain separator, not a secret.
- POST the attestation to `/v1/passkey/register`.
- Read `cred.getClientExtensionResults().prf.results.first` — the 32-byte PRF output.
- Derive an AES-256-GCM key from PRF output via HKDF-SHA256 (info = `"mnemonic-wrap"`).
- Encrypt the mnemonic with that key + a random 12-byte nonce.
- Store `{ ciphertext, nonce, credentialId }` in IndexedDB.

If enrollment fails or the user dismisses → Console refuses to finish the unlock. Nothing cached.

### 2d. UnwrappingWithPasskey

On every subsequent tab open with cached wrapped blob:

1. Fetch challenge from `/v1/passkey/assertion-challenge`.
2. `navigator.credentials.get({ publicKey: { challenge, allowCredentials: [{ id: credentialId, type: "public-key" }], userVerification: "required", extensions: { prf: { eval: { first: prfSeed } } } } })`.
3. Read PRF output → derive AES key → decrypt IndexedDB ciphertext → mnemonic in memory.
4. POST the assertion to subsequent blob-download requests if we ever need to refetch the server blob (e.g. user rotated passphrase).

### 2e. Mnemonic in memory

Single Jotai atom in a sealed module:

```ts
const mnemonicAtom = atom<Uint8Array | null>(null);
```

- Stored as `Uint8Array` (not string) so we can zero it.
- On `visibilitychange === "hidden"` for >5 minutes → clear the atom and force re-unlock on return.
- On any logout or `beforeunload` → zero the bytes via `crypto.getRandomValues` over the buffer, then null the atom.
- Never serialized, never logged.

## 3. File decrypt path

The existing files list/grid stays as-is. New decrypt step on
download/preview:

```ts
async function decryptFile(file: FileMeta): Promise<Blob> {
 const mnemonic = decodeMnemonic(get(mnemonicAtom));
 const folderMnemonic = folderMnemonicCache.get(file.label)
 ?? derive_folder_mnemonic(mnemonic, file.label);
 folderMnemonicCache.set(file.label, folderMnemonic);

 const key = derive_file_key(folderMnemonic, file.cid);
 const ciphertextStream = (await fetch(`${arionBase}/f/${file.cid}`)).body!;

 // Streaming decrypt — one chunk at a time through WASM
 const plaintextStream = ciphertextStream.pipeThrough(
 new TransformStream({
 transform(chunk, controller) {
 const pt = decrypt_file_chunk(key, file.nonce, file.aad, chunk);
 controller.enqueue(pt);
 },
 }),
 );

 return new Response(plaintextStream).blob();
}
```

- Streaming is the **default**. A 4 GB video must not OOM the tab.
- Image / video preview: `URL.createObjectURL(blob)`.
- Download: `<a href={url} download={file.name}>`.
- Folder-mnemonic cache lives in memory only, cleared with the mnemonic atom.

## 4. Hardening (non-negotiable)

### 4a. CSP

`next.config.ts` headers:

```
Content-Security-Policy:
 default-src 'self';
 script-src 'self';
 style-src 'self' 'unsafe-inline';
 img-src 'self' data: blob: https://arion.hippius.com;
 media-src 'self' blob: https://arion.hippius.com;
 connect-src 'self' https://api.hippius.com https://arion.hippius.com;
 frame-ancestors 'none';
 object-src 'none';
 base-uri 'self';
```

No `unsafe-inline` on `script-src`. No `unsafe-eval`. If Next.js
needs inline scripts for hydration, use the nonce-based CSP pattern
(per-request nonce in the header and on the inline script tags).

### 4b. SRI

Every `<script src>` and the WASM fetch must verify SHA-384.

```ts
// Pin the WASM hash from the @hippius/crypto-wasm package metadata
const wasmUrl = "/static/crypto.wasm";
const expectedSri = "sha384-…"; // from npm package
const resp = await fetch(wasmUrl);
const bytes = await resp.arrayBuffer();
const hash = await crypto.subtle.digest("SHA-384", bytes);
if (b64(hash) !== expectedSri) throw new Error("WASM integrity check failed");
await WebAssembly.instantiate(bytes, imports);
```

### 4c. Supply chain

- `pnpm config set ignore-scripts true` for the Console workspace.
- `pnpm config set minimumReleaseAge 1440` (24h delay before a
 just-published version is installable).
- All deps pinned to exact versions (no `^`, `~`).
- `pnpm audit --audit-level=moderate` in CI; PR fails on any new
 advisory.
- No third-party scripts on routes under `/console-unlock`,
 `/files`, or anything that touches the mnemonic. Analytics, if
 required, isolated to a separate subdomain (`metrics.hippius.com`)
 and only loaded on marketing pages.

### 4d. Cookies & headers

- Session cookie: `httpOnly`, `Secure`, `SameSite=Strict`.
- HSTS preload header on the Console domain.
- `Referrer-Policy: same-origin` on all responses.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.

### 4e. Input handling

- No `dangerouslySetInnerHTML` anywhere.
- File names are rendered as text only; never as HTML or as part of
 a `style` attribute.
- File previews (images, videos) sandboxed via `URL.createObjectURL`
 + `<img>`/`<video>`. No `<iframe srcdoc>` or `<object>`.

## 5. Phases

| # | Work | Days | Depends on |
|---|---|---|---|
| 1 | Browser-support gate + "Browser not supported" page | 0.5 | — |
| 2 | Unlock page state machine + passphrase form (no WASM yet — mock the open) | 1 | — |
| 3 | Wire the real WASM (`@hippius/crypto-wasm`) once Server track ships v0.1.0 | 1 | Server track #2 |
| 4 | WebAuthn enrollment + PRF wrap + IndexedDB store | 1.5 | Server track #4 |
| 5 | Subsequent-visit passkey unlock | 1 | #4 |
| 6 | File decrypt path + streaming + preview/download UI | 2–3 | #3 |
| 7 | Hardening pass — CSP, SRI, supply chain, headers | 1 | — |
| 8 | E2E test suite — staging round trip with real server + real desktop | 1 | All server endpoints live |

**Track B total: 8–10 engineering days.**

Phases 1, 2, 7 can land before the server track finishes.

## 6. Rollout

- Whole feature behind a `console_decrypt` feature flag.
- Internal dogfooding on a staging Console pointed at a staging
 `hcfs-server` first.
- Production launch only after:
 - The npm package has been at `1.0.0` for at least one CI cycle.
 - At least three internal users have done the full enrol → close
 tab → reopen → Touch ID → decrypt loop on each of: Safari 18,
 Chrome 116+, Edge 116+.

## 7. Out of scope

- Sharing files with other users.
- Uploading from Console (read-only first).
- Server-side preview generation.
- Anything in `hcfs/` or `hippius-desktop/` — owned by the server track.

## 8. Open questions

1. Does Console already have an OAuth flow against `api.hippius.com`,
 or do we need to add one? (Skim of `hippius-console/src/services/`
 should answer this in 5 minutes.)
2. Existing Next.js version — App Router or Pages? PRF detection at
 layout level differs slightly between the two.
3. Where does the WASM file get hosted? Bundled by Next.js's static
 output (preferred for SRI), or served from a CDN (needs the SRI
 hash to ship in HTML).
4. Is `analytics` already on the Console domain? If yes, we need to
 either remove it from mnemonic pages or move it to a subdomain
 (per §4c).
