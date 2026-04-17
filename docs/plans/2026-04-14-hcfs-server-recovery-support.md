# hcfs-server — Recovery Support Tasks

**Date:** 2026-04-14
**Owner:** hcfs-server maintainer
**Consumer:** hippius-desktop OAuth account recovery (see `2026-04-14-oauth-account-recovery.md` for the client-side design; this file is self-contained and does not require reading it)
**Target branch:** `main` at or after `bcfb6131cc63f7f6ae4f64e86c7f5e1b3e8b5975`

## Context

The Hippius Desktop app is adding an always-on account recovery flow. When a user logs in via OAuth on a fresh device, the app fetches the user's sealed mnemonic blob, prompts for the recovery password, and decrypts locally. This relies on existing `hcfs-server` endpoints but needs two small server-side changes to be production-ready.

**What the desktop consumes (unchanged contract):**
- `POST /v1/mnemonic-blob` — upsert sealed blob (bearer auth, SS58-scoped). Body: `{ciphertext, salt, nonce, aad, kdf: {algorithm, memory_kib, time_cost, parallelism}}`, all bytes base64-encoded.
- `GET /v1/mnemonic-blob` — fetch the same shape for the authenticated caller. Returns 404 when no blob exists for the SS58.
- Bearer token resolved via `resolve_caller` against `HCFS_AUTH_VERIFY_URL`, SS58 as PK.

No new endpoints are required. The changes below are limits/config/polish.

---

## Task 1 — Raise GET rate limit

### Problem

`get_mnemonic_blob` (`hcfs-server/src/handlers/console_blob.rs`) currently limits **`BLOB_GET_RATE_LIMIT = 5` per `RATE_LIMIT_WINDOW_SECS = 3600`** per SS58. The recovery UX requires the user to type their password on a new device. Typos are expected — 5 attempts/hour will cause legitimate users to lock themselves out mid-recovery.

The AEAD tag check inside the ciphertext is the real brake against brute force (each wrong-password attempt requires an Argon2id derivation client-side). A lenient server-side limit is safe.

### Change

- Raise `BLOB_GET_RATE_LIMIT` from **5** to **30** per hour (`RATE_LIMIT_WINDOW_SECS` unchanged).
- Keep `BLOB_POST_RATE_LIMIT` unchanged (writes are rare and mutate state).
- Consider a separate, lower "failed-assertion" counter in a future change if abuse appears — out of scope here.

### Acceptance

- Rate limit exceeded returns `429 Too Many Requests` with `error: "rate_limit_exceeded"` (existing shape).
- A GET request succeeds 30 times in a 1-hour window before the 31st returns 429.
- Existing test for rate limit, if any, is updated to reflect the new number (and a new test added if not).

### Rollback

Single constant change, trivial to revert if telemetry shows abuse.

---

## Task 2 — Expose a stable, documented default server URL

### Problem

Desktop recovery runs before any `hcfs_config.server_url` is set locally (the fresh-device case: OAuth callback completes before sync is configured). The client needs a **canonical production URL** to hit the blob endpoints from a clean install.

Today the desktop hardcodes URLs via the in-app sync config that users configure after first run. For recovery, we need the URL known at compile time or injected via an env var the installer sets.

### Ask (hcfs-side)

No code change required, but we need:

1. **Canonical production URL confirmed and documented** in the `hcfs-server` README or a deployment doc. The desktop will pin this as a `const DEFAULT_HCFS_SERVER_URL` in Rust source.
2. **Commitment to path stability** for `/v1/mnemonic-blob` (POST/GET/DELETE). If the base URL or path changes, it's a breaking change that requires a coordinated desktop release.

### Acceptance

- A doc comment or README section in `hcfs-server/` stating the canonical production base URL and the API version guarantee.
- Confirmation in the PR description that `/v1/mnemonic-blob` routes will remain stable (behind `/v1/` for at least one major version deprecation cycle if ever moved).

---

## Task 3 — (Optional, non-blocking) Reset-account endpoint

### Problem

V2 of the desktop recovery UX will offer a "reset account" flow for users who forget their recovery password — delete the server blob + local state, start fresh. `DELETE /v1/mnemonic-blob` already exists and handles blob deletion server-side. No change needed now; flagging only so it stays on the radar when V2 lands.

### Ask

Confirm `DELETE /v1/mnemonic-blob` semantics:
- Authenticates same way as GET/POST (bearer + SS58).
- Idempotent: deleting a nonexistent blob returns 204 or 404 (document which).
- Cascades to any associated records (if blob has FKs — currently none documented).

No code change; just a README line confirming behavior.

---

## Verification checklist (for the PR)

- [ ] `BLOB_GET_RATE_LIMIT` = 30, tests updated.
- [ ] Production URL documented in README.
- [ ] `DELETE /v1/mnemonic-blob` behavior documented (Task 3).
- [ ] `cargo test -p hcfs-server` passes.
- [ ] `cargo clippy --all -- -D warnings` clean.
- [ ] Manual smoke: POST → GET → GET (30x) → 429 → wait → GET succeeds again.

## What this PR does NOT do

- No new endpoints.
- No schema changes.
- No auth changes.
- No passkey code (already removed in PR #122).
- No KDF parameter changes.

## Desktop consumer notes (informational)

The desktop will pin to a specific `hcfs-client` / `hcfs-shared` cargo rev. Current pin is `bcfb6131cc63f7f6ae4f64e86c7f5e1b3e8b5975`. After this PR merges, the desktop will bump to the new rev as part of its recovery feature rollout.

Any wire-format changes to `BlobResponse` / `UpsertBlobRequest` must be backwards-compatible with the current shape (additive only) for at least one desktop release cycle, or coordinate a hard cut with the desktop team.

## Questions for the hcfs maintainer

1. Is 30/hr an acceptable GET rate limit, or would you prefer a different number (e.g., 60/hr with a separate lower failed-assertion counter)?
2. Is there already a public-facing URL doc for hcfs-server we can point the desktop `const` at, or should we create one in this PR?
3. Any telemetry wanted around `get_mnemonic_blob` (success / 404 / 429 counts) to help the desktop team monitor recovery health in prod?

## Estimated size

- Task 1: ~10 LOC + test, 1 hour.
- Task 2: docs only, 30 min.
- Task 3: docs only, 15 min.

**Total: under half a day.**
