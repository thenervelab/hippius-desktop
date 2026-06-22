# OAuth ↔ mnemonic file-recovery binding (Option A)

**Status:** Design / API contract. No code yet. Backend-gated.
**Date:** 2026-06-22
**Related:** `2026-04-13-console-password-blob-design.md` (decision #8, the `oauth_sub → ss58`
bind sketch), `2026-04-14-oauth-account-recovery.md` (the sealed-blob recovery flow this
extends), `OAUTH_ENCRYPTION_ASSOCIATION_2026-06-22.md` (the association map this builds on).

## 1. Problem

An OAuth user holds two unrelated sr25519 identities:

- **Login SS58** (e.g. `5E4ZQ…`) — minted and custodied by `api.hippius.com`; the private key
  never exists client-side (`AuthCapabilities::OAuthOnly`). All of the user's files are stored
  on the hcfs backend **scoped to this SS58** — confirmed: `GET /search_files/{ss58}`
  (`hcfs-server/src/handlers/search.rs:144`), authorized by bearer→SS58 via
  `verify_token` / `authenticate_caller` (`hcfs-server/src/auth.rs:161,274`).
- **Master mnemonic** (derives e.g. `5GvQ…`) — minted client-side by `ensure_sync_mnemonic`
  purely for file encryption; the user self-custodies it (Settings → Backup Mnemonic Seed).

**The gap:** if the user loses OAuth access, the files are stranded. They cannot authenticate
as `5E4ZQ…` (custodial key, gone), and the mnemonic only authenticates as `5GvQ…` — a
different, empty namespace. **The sealed recovery blob does not help** because it is itself
keyed by the login SS58 (`mnemonic_blobs.user_id`) and only fetchable *after* OAuth login. So
losing OAuth loses both the files and the blob; only the offline mnemonic survives, and today
it has no way to reach the files.

This also makes the backup dialog's own promise false: *"Your mnemonic seed is the only way to
restore access to your account and encrypted files"* (`MnemonicBackupDialog.tsx`) is currently
untrue for OAuth accounts.

## 2. Goal & non-goals

**Goal:** make the self-custodied master mnemonic a complete, OAuth-independent recovery path
for an OAuth account's **files** — list, download, decrypt — by binding the mnemonic identity
to the OAuth account's namespace on the backend.

**Non-goals:**
- **Wallet / funds recovery.** The on-chain balance lives under the custodial login key and
  stays server-held. This is consistent with the 2026-06-10 decision that the wallet stays
  separate and is not derived from the mnemonic. *Restore access = files, not the wallet.*
- **Surfacing or deriving the custodial signing key.** Not done; not possible client-side.
- **Changing how OAuth accounts are minted** (the deeper "derive login SS58 from the mnemonic
  at signup" root-cause fix). Noted in §8 as a separate, larger track.

## 3. Security model — the deliberate tradeoff

Today the mnemonic is *only* a decryption key plus a separate empty account. Binding promotes
it to **a recovery principal that can reach the OAuth account's files.** A leaked mnemonic
therefore changes from "can decrypt files the attacker already has" to "can list and download
everything in the account." This is the price of the feature and must be an explicit product
decision, not a side effect. It is defensible — the mnemonic is already presented to users as
the keys to the kingdom — but it has to be chosen.

Two invariants keep the bind itself safe:

1. **Bind only from an authenticated owner session.** The bind request must be authorized by
   the owner's live OAuth bearer token, so only the real account holder can register a recovery
   principal.
2. **Prove possession of the recovery key.** The bind must include a challenge signed by the
   recovery key (`5GvQ…`), so the server records a principal the user actually controls — never
   an attacker-supplied address. This reuses the exact primitive `challenge_response`
   (`auth/service.rs:71`) already implements: a server challenge signed by the mnemonic-derived
   signer.

**Recovery-session scope (decision required):** when a recovery key is later used to open an
owner session (§5.2), should that session be **read-only** (list + download only) or **full**
(including delete/rename/upload)? Recommendation: **read-only at launch**; widen later if
needed. Read-only satisfies "get my files back" and bounds the blast radius of a leaked
mnemonic.

## 4. Backend contract (hcfs-server only)

> **Verified 2026-06-22 against the hcfs source — the entire authz surface is hcfs-server.**
> Per-SS58 scoping is enforced inside hcfs-server: file metadata lives in PostgreSQL
> (`file_records.user_id`, `hcfs-server/src/database.rs:24`) and listing/search/download filter
> by SQL predicate on `user_id`. The byte-storage backends (Arion / S3) are **content-addressed
> by hash and never receive user identity** (`hcfs-server/src/storage.rs:1`), so **they need no
> changes** — the binding/authz work is confined to hcfs-server. (`hippius-arion` is not even
> checked out locally; this finding means that no longer matters for Option A.)

### 4.1 New table

```
recovery_bindings(
  owner_ss58     TEXT NOT NULL,   -- the OAuth account namespace (e.g. 5E4ZQ…)
  recovery_ss58  TEXT NOT NULL,   -- mnemonic-derived principal (e.g. 5GvQ…)
  created_at     TIMESTAMP NOT NULL,
  scope          TEXT NOT NULL,   -- 'read' | 'full' (see §3)
  PRIMARY KEY (owner_ss58, recovery_ss58)
)
```

One owner may bind multiple recovery principals (multi-seed backups); one recovery principal may
be bound to multiple owners (a power user recovering several accounts). Hence the composite PK,
not a single-column key.

### 4.2 Bind (two-step, owner-authenticated + proof-of-possession)

```
POST /v1/recovery-binding/challenge
  Auth:  Bearer <owner OAuth token>     → resolves to owner_ss58
  Body:  { "recovery_ss58": "5GvQ…" }
  200:   { "challenge": "<nonce>", "expires_at": <ts> }

POST /v1/recovery-binding
  Auth:  Bearer <owner OAuth token>     → resolves to owner_ss58
  Body:  { "recovery_ss58": "5GvQ…",
           "challenge": "<nonce>",
           "signature": "<sig by recovery key over challenge>",
           "scope": "read" }
  200:   { "status": "ok" }
  4xx:   bad signature / expired challenge / recovery_ss58 mismatch
```

Server verifies: (a) the bearer resolves to `owner_ss58`; (b) the signature verifies against
`recovery_ss58` over the issued challenge; then upserts the binding row.

### 4.3 Authz change — one shared function

**Verified:** every file handler (`search_files`, `download`, `browse`, `register_folder`,
metadata) funnels through a single gate, `validate_and_authorize` (`hcfs-server/src/auth.rs:237-271`),
which today does:

```rust
if substrate_address != ss58_address {   // auth.rs:255
    return Err((StatusCode::FORBIDDEN, …));
}
```

So the relaxation is a **one-function change**:

```
authorized = token_ss58 == path_ss58
          || binding_exists(owner_ss58 = path_ss58, recovery_ss58 = token_ss58)
             [&& scope allows the operation]
```

Because all handlers route through `validate_and_authorize`, changing it covers search, listing,
download, and metadata at once. No Arion/S3 change.

### 4.4 Reverse lookup & revoke

```
GET  /v1/recovery-bindings/owned-namespaces
  Auth:  Bearer <recovery-key session token>   → resolves to recovery_ss58
  200:   { "namespaces": [ { "owner_ss58": "5E4ZQ…", "scope": "read" }, … ] }
         -- "which owner accounts can I recover with this identity?"

DELETE /v1/recovery-binding
  Auth:  Bearer <owner OAuth token>             → resolves to owner_ss58
  Body:  { "recovery_ss58": "5GvQ…" }
  200:   { "status": "ok" }
```

`owned-namespaces` is what lets the recovery UI say "this seed can restore account X."

## 5. Desktop integration

### 5.1 Binding (Settings → Recovery, while signed in via OAuth)

New IPC `bind_recovery_identity(state) -> BindResult`:

1. Resolve `HcfsServerCtx` (owner bearer + base_url — reuses `console_access.rs`).
2. Resolve the master mnemonic for the active account (`get_mnemonic_for_account`), derive the
   recovery keypair with the existing `derive_keys` (`auth/login.rs:83`) → `recovery_ss58` +
   signer.
3. `POST /v1/recovery-binding/challenge`, sign the nonce with the recovery signer (same call
   shape as `challenge_response`), `POST /v1/recovery-binding`.
4. Surface in `RecoveryPhraseSettings.tsx` as a new row: *"Enable mnemonic recovery — let your
   backed-up seed phrase restore this account's files without signing in."* Idempotent (re-bind
   is a no-op upsert). Best-effort, non-fatal, like `ensure_welcome_notification`.

This also closes the dangling `recovery.rs:588` message ("Import your original master mnemonic
via Settings → Recovery") by giving Settings → Recovery a real mnemonic-aware surface.

### 5.2 Recovery (fresh device, OAuth unavailable) — dedicated read-only recover flow

**Model choice (settled by Q3).** Token→SS58 is strictly 1:1 and resolved by the external auth
API (`hcfs-server/src/auth.rs:161`, `verify_token` → `api.hippius.com/api/auth/verify-token/`);
hcfs-server cannot mint an owner-scoped token. So the "recovery-key → owner session token" model
is **not** achievable in hcfs-server alone — it would need a change to the external Hippius auth
API. We therefore adopt the **per-request authz relaxation** of §4.3, which is fully contained in
hcfs-server, and pair it with a **dedicated read-only recover flow** on the desktop so we never
touch the `ss58 == account_id` invariant in the main sync path.

The recovery identity authenticates **as itself** — exactly the existing access-key login, which
already obtains a normal bearer for `5GvQ…` from the auth API (a shipped feature, no new
auth-API dependency). hcfs-server then authorizes that token against the bound owner namespace
via §4.3.

The user pastes the backed-up mnemonic into a **"Recover an account"** entry point. Desktop:

1. Derive `recovery_ss58` + signer from the pasted mnemonic (`derive_keys`), obtain a bearer via
   the existing `challenge_response` (`auth/service.rs:71`) — token scoped to `5GvQ…`.
2. `GET /v1/recovery-bindings/owned-namespaces` → list owner accounts this seed can restore; if
   several, let the user pick `owner_ss58`.
3. Run a **read-only recovery browse/download** against the owner namespace: reuse the existing
   remote-read helpers (`sync/remote.rs` — `list_remote_folder_files`, `download_remote_file` /
   `cache_remote_file`), but parameterized to target `owner_ss58` in the path instead of the
   session ss58, carrying the `5GvQ…` bearer. hcfs-server's relaxed `validate_and_authorize`
   permits it because the binding exists. Each file is decrypted with folder keys derived from
   the pasted master mnemonic (`derive_folder_mnemonic`) and written to a user-chosen folder.

**Why a separate read-only flow, not the full sync engine.** The sync path hard-asserts
`ss58 == account_id` (`console_access.rs:188`) and assumes the session owns the namespace.
Rather than re-architect that, recovery is a contained "pull my files to a folder" operation
built on the already-read-only remote helpers — a much smaller surface, and it matches the
actual user need ("get my files back"). Full bidirectional sync as a recovery identity is a
later, optional step (and the place where the external token-mint model would pay off).

The one new desktop seam is a remote-read context that targets a **bound owner namespace** with
the recovery identity's token, distinct from the asserting `HcfsServerCtx`.

### 5.3 Files-only, no wallet

The recover flow never signs extrinsics and never touches `local_wallets`. Wallet/funds remain
out of reach by construction, satisfying §2's non-goal.

### 5.4 Console parity (hippius-console)

**Verified 2026-06-22 against the console source — the console shares the same encryption
identity, so the binding covers both clients with no per-client fragmentation.**

- The console fetches the **same** sealed blob (`GET /v1/mnemonic-blob`, bearer-keyed by the
  OAuth login SS58 — `src/lib/mnemonic-blob/api.ts`) and decrypts it in-browser with the **same**
  `@hippius/hcfs-client-wasm` (Argon2id + XChaCha20-Poly1305, SS58 as AAD —
  `ConsoleUnlockModal.tsx:95-103`, `crypto-wasm.ts`). For a given OAuth account, desktop and
  console use the **same master mnemonic**. So one binding per OAuth namespace serves both.
- The console **already supports mnemonic / access-key login** (`AccessKeyLoginForm.tsx`,
  `WalletAuthContext.tsx:119` — `keyring.addFromMnemonic`), so it already has the primitive to
  authenticate as the recovery identity `5GvQ…`.
- The console lists files via the **same** per-SS58 namespace using the OAuth SS58
  (`/search_files/{ss58}`, `config.ts:129`, `useSearchFiles.ts:194`) and has the **same**
  lose-OAuth gap: both the blob fetch and file listing require the OAuth bearer; there is **no**
  mnemonic-only offline path today.

**Implication.** Because authz is enforced once in hcfs-server (§4) and the console hits the same
endpoints with the same model, the console gets the recovery grant **at the backend for free**.
To *use* it, the console needs the same recover flow mirrored (it already has mnemonic login +
the WASM crypto): after access-key login, list bound owner namespaces (§4.4) and
browse/download the owner namespace with the recovery token. The **bind** (§4.2) is shared
backend state — performed once from any authenticated OAuth session (desktop *or* console), and
the other client benefits automatically. The recover flow uses the pasted mnemonic directly, so
it does **not** need the blob (which is itself OAuth-gated) — sidestepping that gap entirely.

**Decision #8, resolved.** The console **intentionally** does not assert
`derive_ss58(mnemonic) === session_ss58`, and documents exactly why
(`ConsoleUnlockModal.tsx:107-115`: OAuth-assigned SS58 + random BIP-39 for file keys + AAD
binding prevents blob-swap; requiring derivation back would break every OAuth account). So
decision #8 was a deliberate, documented departure for OAuth accounts — not a silent regression.
This design accepts that decoupling and links the two identities explicitly (§9).

## 6. What does NOT change

- Normal OAuth login, the sealed-blob recovery (recovery-password) path, multi-drive sync,
  account switch — all untouched. Binding is purely additive.
- The sealed blob still exists and is still the primary recovery for users who *haven't* lost
  OAuth. This feature is the fallback for the "OAuth lost" case the blob can't cover.

## 7. Phasing

1. **Server (hcfs-server only):** `recovery_bindings` table + bind endpoints (§4.2) +
   reverse-lookup (§4.4) + relax `validate_and_authorize` per §4.3 (read scope). No Arion/S3 work.
2. **Desktop bind:** `bind_recovery_identity` IPC + Settings → Recovery row (§5.1).
3. **Desktop recover:** "Recover an account" entry point + the parameterized read-only
   remote-read context targeting a bound owner namespace (§5.2).
4. **Console mirror (§5.4):** mirror the bind + recover surfaces in hippius-console (it already
   has mnemonic login + the WASM crypto); benefits from the same backend with no extra server
   work. Bind state is shared — either client can create it.
5. **Later (optional):** `scope="full"` write access; full bidirectional sync as a recovery
   identity — this is where the external auth-API "owner-scoped token mint" (deferred per Q3)
   would pay off.

## 8. Verification status (resolved 2026-06-22 against the hcfs source)

1. **Arion namespace scoping — RESOLVED, non-issue.** Per-SS58 scoping is enforced entirely in
   hcfs-server (`file_records.user_id` + SQL predicates, `database.rs:24`, `:662`). Arion/S3 are
   content-addressed and never see identity (`storage.rs:1`). No Arion change is needed; the repo
   not being checked out no longer matters.
2. **`token_ss58 == path_ss58`? — RESOLVED, yes.** Enforced in `validate_and_authorize`
   (`auth.rs:255`), called by all file handlers. §4.3 is a relaxation of this one function.
3. **Owner-scoped token mint? — RESOLVED, not in hcfs-server.** `verify_token` (`auth.rs:161`)
   delegates token→SS58 to the external auth API (`api.hippius.com/api/auth/verify-token/`),
   strictly 1:1; hcfs-server cannot mint or override. Hence §5.2 uses the per-request authz
   relaxation, not a token mint. (A token-mint model is possible only with an auth-API change —
   deferred to phase 4.)
4. **No existing linking/delegation — RESOLVED.** hcfs has no account-linking/multi-owner/
   recovery-principal concept. File *sharing* (`shares/mod.rs`) is per-file, anonymous,
   token-in-URL-fragment, expiring — not reusable for account-level recovery. So `recovery_bindings`
   is genuinely new.

Still to decide (product/security, not blocking design):

- **Recovery-session scope** — read-only at launch (recommended, §3) vs full.
- **Rate-limiting** — scope offline-brute-force limits per-account and per-IP on the bind and
  recover endpoints (the blob path already handles 429, `console_access.rs:298`).
- **Revocation UX** — rotating the recovery password should NOT invalidate bindings (the mnemonic
  is unchanged across rotations); add an explicit owner-driven `DELETE` (§4.4) instead.

## 9. Alignment with prior decisions

- Records a **mapping** and grants **file** access; does **not** auto-seed `local_wallets` or
  derive/surface the custodial wallet → stays on the right side of the 2026-06-10
  wallet-auto-seed-abandoned decision.
- Does not assert decision #8's `derive_ss58(mnemonic) == session_ss58`; it accepts the two
  identities are distinct and links them explicitly instead — which is the non-custodial
  alternative that same doc sketched.
