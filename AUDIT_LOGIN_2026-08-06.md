# Login System Audit — 2026-08-06

> **Remediation status (2026-08-06, on `redesign`, uncommitted):** H-1, H-2, H-3, H-4 and
> the S-1 desktop sinks are **FIXED** — identity guard `derive_verified_keys` in
> `auth/service.rs` wired into `refresh_auth_token_internal` + `ensure_billing_auth`
> (unit tests + `tests/auth_wiring_pins.rs`); `complete_oauth_flow` probe now bounded
> best-effort via the shared `probe_recovery_state_bounded` (pinned); state-less fallback
> is newest-wins + drain (`consume_fallback_flow`, unit-tested); deep-link logging via
> `deep_link_public_part` and FE dedup via the Rust `dedupKey`
> (`app/lib/auth/deepLinkDedup.ts` + tests). **M-1 is also FIXED** (follow-up slice):
> tri-state token resolution in `auth_session_repo` + `classify_restore_token` in
> `session_restore.rs` — keychain-unreadable with an unexpired session now fails soft
> (no localStorage clear, no `/login` logout bounce); and the `hcfs_auth_relogin_required`
> event now has a frontend listener (deduped persistent toast in `useSyncEvents`), closing
> the silent-degradation gap the PR #102 review surfaced. Console-repo confirmation during the fix:
> its callback page sends only `code`/`username`/`id` (never `token`) and forwards
> `state` for mobile only — the desktop `state` forwarding (S-3) is a one-condition
> change in `hippius-console/src/app/auth/callback/page.tsx`. **M-2, M-6, M-7 and L-1
> are also FIXED** (third slice): pending OAuth states persist in `oauth_pending_states`
> with a wall-clock 5-min TTL and reload on `complete_oauth_flow` (M-2, which also
> converts the TTL off `Instant` — L-1); `get_latest` skips cleared rows and
> `update_logout_time` no longer bumps `updated_at` (M-6); an empty `substrate_address`
> callback is now an error instead of a half-login (M-7). Still open: M-3/M-4 (deep-link
> listener placement + dedup TTL), M-5, S-2…S-6 (S-4 deliberately deferred — interacts
> with the H-2 tamper binding).

Top-to-bottom review of the authentication stack, prompted by two reported symptoms:
intermittent **OAuth login failures** and intermittent **stored-account (session restore) issues**.

Scope reviewed: `src-tauri/src/auth/*` (state, login, oauth, session_restore, service,
tokens, token_keychain, keychain, auth_session_repo, logout, account_key, billing_auth),
sync-loop token-refresh callers (`sync/projection/tauri_bridge.rs`, `sync/drive/lifecycle.rs`),
deep-link wiring (`main.rs` single-instance handler), and the frontend half
(`wallet-auth-context.tsx`, `LoginForm.tsx`, `OAuthButtons.tsx`, `auth/callback/page.tsx`,
`scheduleOAuthSyncInit.ts`).

Prior context honored: `WALLET_FIX_PLAN_2026-06-08` R-02 (deep-link token accepted without
server introspection) remains a **known deferred item** requiring console/server work; it is
not re-litigated here. The H-2 token-binding fix, R-05 logout-residue fixes, and the CSRF
state binding are all present and verified in the current code.

---

## HIGH — likely root causes of the reported symptoms

### H-1. `complete_oauth_flow` fails (or hangs) AFTER authentication already succeeded, on the recovery probe
`auth/oauth.rs:526` — `let recovery_check = crate::recovery::check_recovery_state_inner(&state).await?;`

This network probe to hcfs-server runs **after** the session is fully persisted
(`auth_session_repo::upsert`, `save_api_token`, `set_active_account` at lines 484–507). It is
**unbounded** (no timeout) and **fatal** (`?`). If hcfs-server is slow or unreachable:

- the callback page spins on "Completing Sign In" indefinitely, or
- the flow errors → user sees "Failed to complete authentication" → localStorage session is
  never written → user retries or gives up — yet the backend session exists, so the *next
  launch* silently restores it.

This is a textbook match for "OAuth login sometimes fails". `session_restore.rs` already
solved this exact problem for the restore path with `probe_recovery_state_bounded`
(10 s timeout, best-effort, `None` ⇒ gate `Pending`). **Fix: use the same bounded,
best-effort probe here**, keep the gate transition (`None` ⇒ `Pending`), and never fail the
flow after the session is persisted.

### H-2. The single-pending-flow fallback makes OAuth login fail whenever ≠ 1 flow is pending
`auth/oauth.rs:393–411`.

Per the in-code TEMPORARY note, the console currently drops the `state` param, so **every
real callback takes the `states.len() == 1` fallback**. Two very common user behaviors break it:

1. **Double-start.** `OAuthButtons.tsx:104–124` re-enables the button whenever the window
   regains focus — precisely what happens when the user switches to the browser and back.
   "Click Google → nothing seems to happen → click again" leaves **2 pending entries**, and
   then **every** callback is rejected ("Missing state parameter…") for up to 5 minutes
   (`PKCE_STATE_TTL`). Clicking Google then GitHub does the same.
2. **Slow browser dance.** 2FA / account picker / password reset taking > 5 min purges the
   entry → 0 pending → rejected.

Fixes, in preference order:
- Verify whether the console now forwards `state`; if yes, delete the fallback (strict path
  already handles overlapping flows correctly). (Verified during remediation: console
  forwards `state` for mobile only — desktop is a one-condition change.)
- Until then, make the fallback tolerant: when `state` is absent, consume the **most
  recently created** non-expired entry (and drop the rest), instead of requiring exactly one.
- Optionally: `start_oauth_flow` could evict older pending entries for the same provider.

**Risk-acceptance re-sign (supersedes `AUDIT_REDESIGN_2026-06-22.md` H-1's narrowing
factor):** that note accepted the unverified direct-grant risk partly because the
state-less fallback fired "ONLY when exactly one OAuth flow is pending". The tolerant
fallback widens that to "newest of N pending" — accepted here because the attack
prerequisites are unchanged (pending flows are mintable only by the local user clicking
sign-in; a cold deep link with no login in progress is still rejected; and the console
sends only `code`, never `token`, so the direct-grant branch is not exercised by deployed
traffic). The real exit remains S-3: console forwards `state` for desktop, fallback
deleted.

### H-3. Token refresh authenticates as the WRONG identity for OAuth accounts
`auth/service.rs::refresh_auth_token_internal` (called ungated from
`sync/projection/tauri_bridge.rs:927` and `sync/drive/lifecycle.rs:1183`).

The refresh derives keys from `get_mnemonic_for_account(account_id)` — the **sync
mnemonic**. For OAuth accounts the login SS58 is server-custodied and the sync mnemonic is a
locally-minted key (`ensure_sync_mnemonic`); the derived substrate address is a **different
identity**. When an OAuth session nears the 30-day expiry (4 h margin in the sync bridge,
60 s pre-init margin), the refresh:

1. runs challenge-response **as the derived address** — potentially *creating a new server
   account* (`is_new`);
2. upserts a **phantom `auth_session` row** under the derived address (with a fresh 30-day
   token and the newest `updated_at`);
3. never refreshes the real OAuth token — then reads the stale token back
   (`tauri_bridge.rs:930`) and pushes it into live drives → 401 loop, retried every cycle;
4. at the next boot after the localStorage session expires, `get_latest` picks the phantom
   row → the user is restored into an **empty phantom account** (mnemonic-provider,
   keychain-miss ⇒ `Restored` + reauth banner, none of their files).

This matches "sometimes I have issues with the stored account" precisely.
**Fix:** gate the refresh on `provider == "mnemonic"` / `AuthCapabilities::Full`, and as a
hard invariant, refuse to persist when `derived_substrate_address != account_id`. OAuth
tokens cannot be refreshed client-side; surface `AUTH_RELOGIN_REQUIRED` instead.

### H-4. `ensure_billing_auth` can swap an OAuth account's credentials to the wrong identity
`auth/billing_auth.rs:183–226`, invoked for every account from `PreAuthProvider.tsx`.

Same identity confusion as H-3, but worse persistence: it mints a token via
challenge-response **as the sync-mnemonic-derived address**, then stores that token under the
**OAuth `account_id`** (`save_api_token`) and rewrites the account's `auth_session` row with
`provider: "mnemonic"`. Gated only on "hcfs config has a password" (true for OAuth users)
and "no API token currently resolvable" — i.e. exactly the post-hiccup state M-1 produces.
Afterwards every API call for that account runs as a different server identity ("my files
are gone" shape), and the localStorage token no longer matches the DB token → next boot the
H-2 tamper check force-logs-out (see M-5).

**Fix:** after `derive_keys`, skip (or error) unless the derived substrate address equals
`account_id` — one guard fixes H-3 and H-4.

---

## MEDIUM

### M-1. Transient keychain unavailability destroys valid sessions
`auth_session_repo::resolve_token` + `session_restore.rs:312–323, 508–510`.

Once a token has been migrated to the OS keychain the DB column is scrubbed to NULL. If the
keychain is **Unavailable** at boot (locked keychain, denied prompt, D-Bus hiccup),
`resolve_token` returns `None` and restore treats it as "token missing/expired":

- OAuth branch: **clears localStorage** (destructive) and bounces to login;
- DB branch: unauthenticated.

A transient OS condition permanently logs the user out even though the token still exists.
**Fix:** thread the `Unavailable` vs `NotFound` distinction up to `restore_session`; on
`Unavailable`, fail soft (retry next boot / show a "keychain locked" message) instead of
clearing the session. Same applies to the mnemonic keychain (`rehydrate_or_restored` shows
the scary "re-enter seed phrase" banner on a transient `Unavailable`).

### M-2. In-memory PKCE state does not survive an app restart
`OAuthState::pkce_states` is process-local. Quit/crash/update-restart between
`start_oauth_flow` and the callback ⇒ 0 pending entries ⇒ callback rejected. Either accept
(document) or persist `{state, provider, created_at}` rows with the same 5-min TTL.

### M-3. Deep-link listener only exists on the login page
`LoginForm.tsx:130–239` is the only `onOpenUrl`/`getCurrent` subscriber. A callback arriving
while the app shows the `/auth/callback` error screen (a failed first attempt!), the splash,
or any other route is **silently dropped**. Move the deep-link subscription to a global
mount (AppShell level) that routes OAuth callbacks to `/auth/callback`.

### M-4. Deep-link dedup latches permanently, before success
`LoginForm.tsx:139–149, 192–196` marks `last_processed_deep_link` **before**
`complete_oauth_flow` runs and never expires it (`last_processed_deep_link_time` is written
but never read). A legitimate redelivery of the same URL — e.g. the user re-clicks "Open
Hippius" on the still-open console tab after a failed attempt — is skipped with only a
console log. Dedup should be time-bounded and only latched after the flow succeeds.

### M-5. Stale localStorage token becomes a forced logout (interaction with the H-2 tamper check)
`session_restore.rs:333 fe_session_proves_token` requires exact equality with the DB token,
but nothing updates `localStorage.hippius_oauth_session` when Rust rotates the token:
`auth_token_refreshed` is emitted (`service.rs:213`) and **no frontend listener exists**.
Today this is masked for OAuth accounts only because H-3 fails to update the correct row;
fixing H-3/H-4 (or any future token rotation) makes every rotation ⇒ "tampered" ⇒ cleared
session ⇒ login bounce at next boot. **Fix:** listen for `auth_token_refreshed` and rewrite
the localStorage session token (or better: stop persisting the token in localStorage at all
and let restore rely purely on the DB/keychain + address).

### M-6. `get_latest` can restore the wrong row (cleared-row / preference-bump shadowing)
`auth_session_repo.rs`: `clear()` keeps the row (for `logout_time_minutes`) and bumps
`updated_at`, and `update_logout_time` also bumps `updated_at`. The boot fallback
`get_latest` orders by `updated_at` only, so a logged-out account's husk can shadow another
account's valid session (⇒ spurious login screen), and a preference edit can flip which
account restores. **Fix:** `WHERE substrate_address IS NOT NULL` (and consider ordering by
`last_login_at`).

### M-7. Direct-grant callback with empty `substrate_address` yields a half-login
`oauth.rs:414–421, 477`: with `token` present but `substrate_address` empty, nothing is
persisted and no `AuthInfo` is set — yet the command returns `Ok`, and the FE
(`setOAuthSession`, `wallet-auth-context.tsx:487–526`) sets `isAuthenticated = true` with
`polkadotAddress = null` and persists an unrestorable localStorage session. Should be an
error (`AppError::Auth`) when the address is empty.

---

## LOW / notes

- **L-1.** `PkceState.created_at` is an `Instant`; on macOS it does not advance during
  sleep, so the 5-min TTL stretches across sleep. Harmless, but if the TTL matters for the
  fallback semantics, use wall-clock.
- **L-2.** `parse_oauth_deep_link` accepts any path *containing* `/auth/callback`; fine
  today, but an exact-path match is cheaper to reason about.
- **L-3.** `complete_oauth_flow` direct-grant defaults (`user_id.unwrap_or(0)`, empty
  username/email) persist junk metadata; consider requiring them or logging.
- **L-4.** Standing deferred item (R-02): the direct-grant `token` from the deep link is
  persisted without server-side introspection. Unchanged risk profile; still needs the
  console `state` forwarding + a token-introspection endpoint.

## What is in good shape

- The `fe_session_proves_token` binding (audit H-2 fix) is correctly implemented and tested,
  including the missing-token pivot case.
- CSRF `state` binding: random UUID v4, consume-on-first-use, TTL purge before lookup —
  well tested; the only weakness is the temporary no-state fallback (H-2 above).
- Logout ordering (persisted state cleared before memory; failure keeps a consistent
  "still logged in" state) and the R-05 residue cleanup (`clear_api_token` + legacy S3
  columns) are correct and pinned by tests.
- Per-account refresh serialization (`refresh_locks`), the recovery-gate funnel
  (`Pending` on unknown probe), keychain per-process caching (macOS re-prompt avoidance),
  and the frozen key-derivation vectors are all solid.
- `auth_session_repo` as the sole writer with COALESCE preference preservation is clean and
  well covered by unit tests.

## Industry-standards alignment (added 2026-08-06)

Checked against: **RFC 8252** (OAuth 2.0 for Native Apps), **RFC 9700** (OAuth 2.0 Security
BCP, 2025), **RFC 7636** (PKCE), **RFC 6750 §2.3** (bearer token usage), the **OWASP Session
Management / HTML5 Security cheat sheets** (which carry NIST 800-63B §7.1's "no session
secrets in localStorage"), and Google's OAuth client best-practices (platform keystores).

### Compliant today
- **External user-agent (RFC 8252 §5 MUST):** login opens the system browser via
  `plugin-opener`; no embedded webview auth. ✅
- **Authorization-code exchange path exists** (`code` → `/api/auth/exchange/`). ✅ shape
- **`state` CSRF binding (RFC 6749 §10.12 / RFC 9700):** high-entropy random value,
  consume-on-first-use, TTL purge — desktop side is compliant. ✅ (but see gaps: the console
  drops it, and the `len()==1` fallback disables the protection when it fires)
- **Token storage (Google/Duende/industry):** OS keychain first (macOS Keychain / Windows
  Credential Manager / Linux Secret Service), plaintext column scrubbed after migration,
  logout clears all stores. ✅ The plaintext-SQLite fallback on keychain-less Linux is a
  pragmatic, warn-logged fallback — industry-common, acceptable.
- **Key-material hygiene:** mnemonic in OS keychain, `Zeroizing` discipline, no FE
  round-trip of the seed phrase. ✅

### Standards gaps
- **S-1 (MUST-level, RFC 9700 / RFC 6750 §2.3 / RFC 8252 §8.2): bearer token in a URL.**
  The "direct grant" deep link `hippiusapp://auth/callback?token=…` is an implicit-style
  grant delivering the access token in a URI — explicitly "MUST NOT" (query params) and
  "SHOULD NOT" (token response type) territory. It transits browser history, OS deep-link
  plumbing, and two sinks we own: `main.rs:234` logs the **full URL** to the on-disk log
  (support-bundle scrubbing redacts at upload, but the raw log retains it), and
  `LoginForm.tsx` persists the full URL **indefinitely** in
  `localStorage.last_processed_deep_link`. Server-side fix = always issue a one-time,
  short-lived `code` (this is the same work as deferred R-02); desktop-side fixes we can do
  now: never log the query string of a deep link, and hash the URL for dedup instead of
  storing it verbatim.
- **S-2 (MUST-level, RFC 8252 §8.2 + RFC 7636): no PKCE.** Public native clients MUST
  implement PKCE; `/api/auth/exchange/` doesn't consume `code_challenge`/`code_verifier`
  (we even repurpose `code_verifier` to carry the provider name). Requires server support —
  should be planned together with S-1, since PKCE is the standard mitigation for the
  custom-scheme interception risk (§8.1: any app can register `hippiusapp://`).
- **S-3 (end-to-end `state`):** the console dropping `state` means the deployed system does
  not actually have the RFC-required CSRF binding — the desktop fallback (H-2) is the
  symptom. Restoring console forwarding and deleting the fallback is a compliance fix, not
  just a bug fix.
- **S-4 (OWASP/NIST): bearer token stored in webview localStorage.**
  `hippius_oauth_session` includes the token; OWASP guidance is unambiguous (no session
  secrets in Web Storage). Rust already refuses to *trust* it (H-2 binding) — the remaining
  step is to stop *storing* it: keep only `{substrateAddress, provider, expiresAt, profile}`
  in localStorage and let restore resolve the token from keychain/DB. This also eliminates
  M-5 (stale-token tamper bounce) by construction.
- **S-5 (RFC 8252 §7.1 MUST): scheme naming.** `hippiusapp://` is a generic scheme; the RFC
  requires reverse-domain form (`com.hippius.app://`). Low urgency, coordinate with console
  + OS registrations; alternatively adopt the loopback redirect (`http://127.0.0.1:{port}`,
  §7.3) which most desktop tools (gcloud, VS Code, gh) use — it removes the
  custom-scheme interception class and the console deep-link forwarding entirely.
- **S-6 (RFC 9700, advisory): token lifetime/rotation.** A 30-day static bearer with
  *client-assumed* expiry (server returns no expiry; we hardcode `now + 30d` in three
  places) vs. the BCP's short-lived access tokens + rotating/sender-constrained refresh
  tokens. Server-driven; at minimum the server should return the real expiry.

Verdict: the desktop's *storage and CSRF mechanics* match industry practice; the deployed
*flow shape* (token-in-URL direct grant, no PKCE, no end-to-end state) predates the app and
is where the standards violations live. None of the H-1…H-4 fixes conflict with the
standards — S-1's desktop sinks, S-3, and S-4 should be folded into the same remediation.

## Recommended fix order

1. **H-3 + H-4** — one shared guard: never persist credentials when the mnemonic-derived
   address ≠ `account_id`; gate the sync-loop refresh on mnemonic-provider sessions.
   (Data-integrity class; creates phantom accounts today.)
2. **H-1** — bounded best-effort recovery probe in `complete_oauth_flow` (pattern already
   exists in `session_restore.rs`).
3. **H-2** — confirm console `state` forwarding; tolerant fallback in the meantime.
4. **M-1** — fail-soft on keychain `Unavailable` in both restore branches.
5. **M-5** — FE listener for `auth_token_refreshed` (prerequisite for shipping the H-3 fix
   safely for mnemonic users too).
6. M-3/M-4 (deep-link robustness), M-6, M-7, then the LOWs.
7. Standards items, desktop-side now: S-1 sinks (stop logging deep-link query strings;
   hash the dedup key) and S-4 (drop the token from localStorage — also deletes M-5).
8. Standards items, cross-repo (console + api server, one coordinated effort): S-3 (forward
   `state`, then delete the fallback), S-1/S-2 (code-only grant + PKCE — supersedes R-02),
   S-6 (server-returned expiry), S-5 (scheme rename or loopback redirect).
