# Associating the OAuth custodial account with the desktop encryption mnemonic

> Design exploration, 2026-06-22. Produced via a 13-agent map → design → judge → synthesize
> workflow. No code changed. Bounds: respects the 2026-06-10 wallet-auto-seed-abandoned
> decision (see MEMORY `oauth-account-identity-split`).

## 1. Current state

### 1.1 Two unrelated sr25519 identities per OAuth account

An OAuth user carries **two** keys that are deliberately not the same:

- **Login SS58 (custodial)** — minted and held server-side by `api.hippius.com` at OAuth
  signup. The desktop receives it as a field, never a private key: the deep-link token grant
  carries `params.substrate_address` and the code grant reads `data.user.substrate_address`
  from `/api/auth/exchange/` (`src-tauri/src/auth/oauth.rs:414-463`; `ExchangeUser.substrate_address`
  at `oauth.rs:172`). It is the single source of truth for "who is logged in," written to
  `AuthInfo.substrate_address` with `AuthCapabilities::OAuthOnly` (`oauth.rs:503-507`) —
  "substrate_address known, no private key — cannot sign extrinsics" (`auth/state.rs:10-11, 24-25`).
- **Encryption mnemonic** — a BIP-39 mnemonic minted (or recovered) **later and independently**
  by `ensure_sync_mnemonic` (`sync/mnemonic.rs:236-334`), used only for file encryption. It
  derives a **different** SS58 than the login account (verified 2026-06-10: `5GvQ…` mnemonic
  vs `5E4ZQ…` login). On-chain signing now comes from a separate `local_wallets` table, not
  from either of these (`blockchain/helpers.rs:3-8, 73-118`).

### 1.2 The sealed recovery blob already IS the association

The durable link between login identity and encryption mnemonic exists today and is
cryptographically authenticated. The sealed blob is an XChaCha20-Poly1305 ciphertext of the
master BIP-39 mnemonic, sealed under an Argon2id key from the recovery password, with the
**login SS58 bound in as AEAD AAD** (`hcfs/hcfs-client/src/mnemonic_blob.rs:59-66, 159-186`;
`aad = ss58.as_bytes()`).

**The linkage key is the login SS58, server-side**, in two enforced layers:

1. **Row keying** — stored on hcfs-server in `mnemonic_blobs`, `user_id = bearer-resolved SS58`,
   PK + `upsert ON CONFLICT(user_id)` + `get WHERE user_id = $1`
   (`hcfs-server/src/console_blob_db.rs:18-29, 80-133`). The SS58 is resolved from the **bearer
   token**, never the request body: `resolve_caller → authenticate_caller → verify_token`
   (`hcfs-server/src/handlers/console_blob.rs:476-494`; `auth.rs:161-233, 274-285`). The desktop
   sends only `Authorization: Bearer <token>` and no identifier (`console_access.rs:255-294`).
2. **AEAD AAD** — the client binds the same login SS58 into the AEAD, so a server-side blob swap
   fails the tag rather than silently decrypting (`mnemonic_blob.rs:108-141`; decrypt sites pass
   `ctx.ss58` at `recovery.rs:357, 763, 896`).

The recovered master derives every per-folder key via `derive_folder_mnemonic(master, label)`
(`recovery.rs:510-594`), so **(OAuth session → SS58 X) + (recovery password) is already
sufficient to recover all of account X's file-decryption keys on any device**. The desktop
session invariant `ss58 == account_id` is hard-asserted before any call (`console_access.rs:180-230`).

### 1.3 What is NOT recorded

There is **no field anywhere — desktop or server — that records "the encryption mnemonic belongs
to this OAuth account" as queryable metadata**. The only OAuth tag lives on the `auth_session`
row; `hcfs_config` is keyed by `account_key(login SS58)` with no provider/encryption column
(`auth/oauth.rs:475-496`; `sync/mnemonic.rs:346-359`). The association is **implicit** (bearer→SS58
row keying + AAD), not **explicit** (no row you can SELECT that says login_ss58 → enc_identity).

**Conclusion:** A partial, cryptographically-authenticated association already exists. The linkage
key is the login SS58, derived server-side from the bearer token. What is missing is only an
*explicit, queryable* record and any *cross-device verification surface*.

## 2. The real question

"Associate" has three distinct meanings, and the ambiguity is exactly where the abandoned work
went wrong:

- **(a) Cross-device recovery** — "a fresh device that authenticates as the OAuth account can
  recover the *same* encryption mnemonic." **This already works** (§1.2). Nothing to build.
- **(b) Preventing a duplicate/divergent mnemonic** — "a fresh mint must not happen when a sealed
  blob already exists for this account." Guarded today by `has_existing_mnemonic_state` + the
  network probe feeding `decide_recovery_flow`. Gap: offline/keychain-evicted case where the local
  master is gone but a server blob exists.
- **(c) A queryable mapping** — an explicit server- or client-side record `login_ss58 → enc_identity`
  for observability/support/future flows.

**This is NOT the abandoned wallet-auto-seeding work.** The 2026-06-10 decision rejected
*materializing key material* — writing a `local_wallets` row from the master mnemonic
(`seed_account_wallet`, branch `feat/wallet-auto-seed` tip `a1b4250c`, never merged). That surfaced
the *wrong* address as "the wallet" for OAuth accounts. The mapping ask (meaning c) records *which
SS58 owns this OAuth account* without moving, exporting, or re-deriving any key.

**Decision #8** of `docs/plans/2026-04-13-console-password-blob-design.md` (lines 26, 173-184)
requires `derive_ss58(decrypted_mnemonic) === session_ss58`. **This invariant is FALSE for every
OAuth account today** (login SS58 server-minted, mnemonic client-minted — two unrelated keys). Any
design that re-asserts address-equality, or stores a usable encryption *signing* address, is back
in rejected territory.

## 3. Options (adversarially scored 0–10)

### Option A — server-side mapping (score 6/10)

New bearer-keyed hcfs-server row `{login_ss58 (server-derived), enc_account_pubkey}`, written at
the end of `align_drive_password`, optionally verified on a fresh device after blob decrypt.

- **Respects wallet separation:** stores only the **public** encryption address; never touches
  `local_wallets`, never uses the (never-client-side) OAuth private key.
- **Verified durability gap:** `decide_recovery_flow` returns `Proceed` for `(local=true, _, _)`
  (`recovery.rs:280`) and that path runs `mark_recovery_skipped` (`recovery.rs:941`), which does
  **not** call `align_drive_password`. So a steady-state returning OAuth user never writes the
  binding — the exact cohort a mapping should cover often gets no row.
- **The cross-device assert is a trap:** failing a *correct* recovery on a stale/planted binding is
  a self-inflicted recovery-DoS on the most safety-critical path; fail-open guts its value. The
  AEAD-AAD already performs this check.
- **Risk:** entire authz half is on the un-indexed hippius-arion server (unaudited).

### Option B — blob-as-binding (score 3/10, do not ship)

Add an `assoc` field to `SealedBlob` carrying `{login_ss58, enc_fingerprint}` and verify on
recovery.

- **Fatal redundancy:** the `login_ss58` half **duplicates the AAD binding that already exists**
  (`aad = ss58` at `mnemonic_blob.rs:133`); the `enc_fingerprint` half is **circular** — it hashes
  the plaintext AEAD just authenticated. Four-repo blast radius (hcfs-client, wasm, hcfs-server,
  desktop) for a redundant check, plus a new brick-everyone failure mode (AAD change breaks every
  existing blob unless byte-identical). Re-couples login SS58 into the encryption blob — exactly
  what decision #8 was killed for.

### Option C — local association row (score 4/10)

Client-only SQLite table `oauth_encryption_assoc` keyed by `account_key(login_ss58)`, storing the
public encryption SS58 + a non-secret blob fingerprint; powers a read-only diagnostic and hardens
the anti-double-mint guard.

- **Respects wallet separation** (public SS58 + hash only).
- **Verified broken write site:** `align_drive_password` (`recovery.rs:617`) has **no SealedBlob in
  scope** — only its callers do — so the rotation/boot-retry refresh must move to the call sites.
- **Largely redundant:** a fingerprinted row implies the local master existed, already caught by
  `has_existing_mnemonic_state`. Fail-safe (can only refuse to mint, never mint), but low marginal
  value over the existing AEAD-AAD backstop.

## 4. Recommendation

**The association already exists via the blob (§1.2), cryptographically authenticated and
single-valued. It does not need a new binding mechanism** — at most (1) hardening of the offline
anti-divergence gap and (2) a thin read-only diagnostic. Do **not** ship Option B. Do **not** ship
Option A's cross-device assert.

**Stage 1 (do now — desktop-only, no server, no new failure surface):**
- Ship a read-only `diagnose_oauth_association` IPC + the `crypto_to_err` cleanup that distinguishes
  a binding/identity mismatch from `AeadTag`→"Wrong passphrase." (`console_access.rs:314`). Gives
  support/observability with zero crypto risk.
- **Do NOT** add the local table or the anti-mint third signal *unless* a concrete offline scenario
  (keychain evicted + local master missing + server blob present) is shown to currently mis-mint —
  and if it is, fix `has_existing_mnemonic_state`/`decide_recovery_flow` to consult the **network
  blob probe** (already the authority), not a new local row.

**Stage 2 (only if product wants explicit server-side queryability — meaning c):** Option A's
*write* half **without the cross-device assert** — write the public `enc_account_pubkey`
best-effort, downgrade the read to non-blocking telemetry, and **close the verified Proceed-path
gap** by writing on the `mark_recovery_skipped` path too. Gate behind an independent **hippius-arion
authz/write-scope audit**.

**First-step outline (Stage 1):**
1. `console_access.rs:314` (`crypto_to_err`): add a distinct error arm so a binding/identity
   mismatch surfaces an actionable message instead of "Wrong passphrase." (new `AppError` variant).
2. Add read-only `#[tauri::command] diagnose_oauth_association(state) -> { login_ss58,
   encryption_address, blob_present, has_local_master }` — reads `AuthInfo.substrate_address`,
   probes the existing `GET /v1/mnemonic-blob` existence check (`recovery.rs:301`), derives the
   public encryption address via `wallet::commands::derive_address` (`wallet/commands.rs:43`,
   `pub(crate)` bump). Register in `main.rs`. No persistence, no signing.
3. Tests: IPC returns `blob_present=true/false` on probe 200/404 (mock `console_access`); a
   `crypto_to_err` test pinning the new variant ≠ the `AeadTag` arm.

## 5. Open questions / cross-repo unknowns

1. **hippius-arion (Arion) server keying** — CANNOT VERIFY here: whether the blob row (and any
   future binding row) is keyed by bearer-resolved SS58 vs raw JWT subject vs internal user-id.
   Desktop comments assert SS58 (`recovery.rs:328-330`; `console_access.rs:319-322`) but Arion is
   not illu-indexed.
2. **Server authz scope (read + write)** — CANNOT VERIFY: that `GET`/`POST /v1/mnemonic-blob` (and
   any new binding endpoint) are scoped so account A cannot read/overwrite account B. A broken
   write-scope is a recovery-data DoS/takeover vector and would make Option A's assert dangerous.
3. **Remote auth API provenance** — whether the login SS58 is *deterministically derived* from the
   OAuth identity or *custodially assigned*. MEMORY says custodially assigned. Gates whether a
   future signup-derivation root-cause fix (account == wallet == encryption identity) is possible.
4. **Custody of the OAuth account key** — does `api.hippius.com` hold the login key as an exportable
   mnemonic or a non-extractable HSM keypair? Gates any rebind/reconciliation path.
5. **Decision #8 in console today** — does `hippius-console` still run `derive_ss58(mnemonic) ===
   session_ss58`? If yes, console file-decryption should be broken for every OAuth user; if no, the
   assert was silently dropped.
6. **Rate-limit scope** — confirm per-account vs per-IP on recovery ops (`console_access.rs:298`)
   against the offline-attack threat model before adding any new endpoint.
7. **One-master-per-login invariant** — Option A/C single-row models assume one master encryption
   mnemonic per login across all drives. True today but undocumented; confirm before a single-row PK.
