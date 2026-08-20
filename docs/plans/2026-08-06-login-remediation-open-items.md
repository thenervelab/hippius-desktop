# Login remediation — validated implementation plan

**Date:** 2026-08-06
**Source audit:** [`AUDIT_LOGIN_2026-08-06.md`](../../AUDIT_LOGIN_2026-08-06.md)
**Scope decision:** no changes to the `api.hippius.com` backend. Parked items and their
residual risk are in §8.
**Status:** every item below was adversarially validated against the code on `redesign`.
Two proposed items were **dropped** as invalid, one was **replaced** with a better change,
and one new **blocker** was found. §2 records what changed and why.

---

## 1. Where we are

| Shipped | PR | Squash |
|---|---|---|
| H-1 bounded recovery probe, H-2 tolerant fallback, H-3/H-4 identity guard, S-1 deep-link hygiene | #102 | `6c7a5cda` |
| M-1 keychain fail-soft, `AUTH_RELOGIN_REQUIRED` toast | #104 | `c1e6bfbe` |
| M-2 restart-safe OAuth flows, M-6 boot-restore ordering, M-7 no half-logins, L-1 wall-clock TTL | #105 | `7f1631b3` |
| M-3 global deep-link listener, M-4 expiring dedup marker, toast dismissal | #106 | `61cedbf5` |

## 2. Validation results — what changed from the first draft

| Proposed item | Verdict | Why |
|---|---|---|
| PR 1 — token out of localStorage (S-4) | **DO**, with a corrected rationale + a new blocker | See §2.1, §2.2 |
| PR 2 — add a `warn!` on state-less callbacks | **DROP — already shipped** | The warning exists at `oauth.rs:577-581` (shipped in #102). The observation window can start from the current release; no code needed. |
| PR 3a — L-2 exact-path match | **DROP — not a real issue** | See §2.3 |
| PR 3b — L-3 junk metadata defaults | **REPLACE with something better** | See §2.4 |
| PR 4 — delete the state-less fallback (S-3) | **DO**, with an unverified pre-req | See §6 |

### 2.1 Correction: M-5 is **not** reachable today

The first draft called M-5 "a live regression risk". That was wrong, and the reasoning
matters because it was the urgency argument for PR 1.

Tracing every production write to `auth_session` (`login.rs:91`, `oauth.rs:667`,
`service.rs:255`, `billing_auth.rs:229` — the three sites in `tokens.rs` are inside
`#[cfg(test)]`) against who actually holds a localStorage session:

- **Only OAuth users have the `hippius_oauth_session` blob.** Mnemonic login only sets
  React state (`wallet-auth-context.tsx:413,466`); it never writes that key. Mnemonic users
  already restore exclusively via the DB branch.
- **An OAuth user's DB token is only ever written by `complete_oauth_flow`**, which writes
  the localStorage copy in the same flow with the same value.
- **Refresh and billing both refuse for OAuth accounts** since #102 — `derive_verified_keys`
  bails before the upsert (`service.rs:247-250`, `billing_auth.rs:190-199`).

So the two stores cannot diverge today. **H-3's fix closed the rotation path for exactly the
users who hold the blob.** M-5 is latent — it would return the moment OAuth token refresh
becomes possible (or the H-3 guard is relaxed) — but it is not live.

**PR 1 therefore stands on S-4 alone:** a live 30-day bearer token sitting in webview
localStorage, readable from any copy of the profile directory. That is sufficient
justification, but it is defense-in-depth, not an incident. Schedule it accordingly.

### 2.2 New blocker: legacy rows cause an identity split (must be fixed inside PR 1)

Pre-#102, `ensure_billing_auth` upserted with `substrate_address: &account_id` and
`provider: "mnemonic"` (verified: `git show 6c7a5cda~1:src-tauri/src/auth/billing_auth.rs`,
lines 214-222), using an **unverified** derive. For an OAuth account that produces a row
keyed by the real OAuth login SS58 but labelled `provider = "mnemonic"` and holding a token
minted by the phantom sync-mnemonic identity — audit H-4's credential swap, now sitting on
disk on every install that ran a pre-#102 build.

Today the frontend branch masks it, because localStorage says `provider: "oauth"`. Delete
that branch and the merged path reads `provider = "mnemonic"` from the row, so:

1. `rehydrate_or_restored(addr, "mnemonic")` calls `rehydrate_full_session`, which uses the
   **bare** `derive_keys` and writes `auth.substrate_address = <phantom derived address>`
   (`login.rs:51-62` — verified: no check that the derived address equals the row's).
   `AuthInfo` and the frontend then disagree about who is signed in.
2. `needs_sync_mnemonic` is computed as `provider != "mnemonic"` → `false`, so the frontend
   never receives the sync mnemonic and sync stays wedged.
3. The recovery gate is never armed, because that block is gated on `auth_type == "oauth"`.

This is a **pre-existing latent bug** — any OAuth user whose localStorage is cleared hits it
today via the DB branch — but PR 1 promotes it from an edge case to every boot. It must be
fixed in the same PR. The fix is in §3.4 items 7–8.

### 2.3 Dropped: L-2 (exact path match) is not a real issue

The premise was that an attacker-influenced path could reach `router.push`. It cannot:
`callback_path` is rebuilt from a hardcoded literal (`oauth.rs:483,491`), the query keys come
from a fixed 9-element allowlist (`oauth.rs:445-455`), and values are percent-encoded by
`append_pair`. The inbound path is tested at `oauth.rs:431` and then discarded. Traversal is
already normalized away by the `url` crate (`/auth/callback/../x` → `/auth/x` → no match).
A prefixed path like `/evil/auth/callback` grants an attacker nothing they could not do with
the exact path — the OS hands both to the same registered handler.

**The genuine defect runs the other way: the check is too strict.**
`hippiusapp://auth/callback?…` (two slashes) parses as host=`auth`, path=`/callback` and is
silently dropped. Production is unaffected because the console emits the triple-slash form —
but the dev OAuth injector in `LoginForm.tsx:159,164` is documented and pre-filled with the
**two-slash** form, so it cannot work as written. Tightening to an exact match would fix
none of this and adds regression risk for any platform variant emitting a prefixed path.

*Optional follow-up (developer ergonomics, not security):* normalize host+path together so
both forms parse, and fix the injector's documented example.

### 2.4 Replaced: L-3 becomes "log the direct-grant branch, then delete it"

Requiring the metadata fields would not remove `0`/`""` from the system:
`session_restore.rs:589-590` applies the very same `unwrap_or(0)` / `unwrap_or_default()`
when rebuilding the session, so a NULL column and a persisted default are indistinguishable
downstream. `userId === 0` is already a normal sentinel on the mnemonic path
(`buildOAuthSession.ts:19`). Nothing keys on either field — `substrate_address` is the key
everywhere. So the original item is close to noise.

The real risk in that code is **L-4/R-02**: the direct-grant branch accepts a bearer token
straight from a deep link and persists it with no server-side introspection. The console
sends only `code`, so the branch is effectively dead — reachable only via the env-gated dev
injector or a hand-crafted deep link.

**That means we can close R-02 desktop-side with no API change**, which the first draft
wrongly assumed required the server. Two steps: a `warn!` on entry to the branch
(`oauth.rs:586`), then delete the branch once a release confirms it never fires. Deleting it
also removes M-7's empty-address case and the §7 question along with it.

---

## 3. PR 1 — take the bearer token out of localStorage (S-4)

### 3.1 The problem

`hippius_oauth_session` in webview localStorage contains the raw bearer token (written at
[`app/auth/callback/page.tsx:121-133`](../../app/auth/callback/page.tsx) and
[`app/lib/wallet-auth-context.tsx:509`](../../app/lib/wallet-auth-context.tsx)). OWASP is
unambiguous that session secrets do not belong in Web Storage. Rust already refuses to
*trust* it (`fe_session_proves_token`, `session_restore.rs:695`); the remaining step is to
stop *storing* it.

### 3.2 The approach

`restore_session` has two branches: frontend-JSON (lines 331–545) and DB-fallback
(549–668). The DB branch already rebuilds the session object from the `auth_session` row
(587–595). **Delete the frontend branch and always restore from the DB row.** That removes
the token from storage, deletes the tamper class with `fe_session_proves_token`, and closes
M-5's latent trap by construction.

**Validated precondition:** every authentication path writes a complete `auth_session` row
with a resolvable token — `login_with_mnemonic` (`login.rs:91`), `complete_oauth_flow` for
*both* grant branches (`oauth.rs:667`, after the merge at 586-635), refresh
(`service.rs:255`) and billing (`billing_auth.rs:229`). `resolve_token`
(`auth_session_repo.rs:141-178`) reads keychain-or-column, and `get_latest` resolves it
(`:345-348`). **No path leaves a user authenticated with no usable row.**

**Correction to the first draft's reasoning:** the DB branch does *not* reconstruct
everything. It is missing the recovery-gate block, the OAuth logout-time exemption, the
navigation behavior, and `email`. Those gaps are why items 5, 9 and 10 below are mandatory
rather than optional — the first draft treated two of them as open questions.

### 3.3 What must not change

The in-memory session keeps the token: `ApiTokenSection.tsx:79,125` displays it and
`NotificationSection.tsx:122` gates on it. Both read React state fed from the IPC response,
and `SessionRestoreResult.oauth_session` already carries the authoritative DB token.

The localStorage key stays as a **token-free** hint, because `app/auth/callback/page.tsx:44-57`
and `app/components/auth/DeepLinkListener.tsx:93-108` read it synchronously before restore
resolves. Verified: neither reads `.token`.

`email` is lost across restore (no column in `utils/schema.rs:463-474`). Verified harmless —
nothing in `app/` reads `session.email`; it is only written at `callback/page.tsx:125`. Note
this already happens on every restart today via the DB branch.

### 3.4 Changes

**Rust — `src-tauri/src/auth/session_restore.rs`:**
1. Drop `oauth_session_json` and `oauth_expiry_ms` from `restore_session`'s signature.
2. Delete the frontend-JSON branch (lines 331–545).
3. Delete `fe_session_proves_token` (line 695) and its unit tests.
4. Route the merged path through `classify_restore_token` (line 233), replacing the ad-hoc
   expiry + keychain logic at 562–584 and preserving the M-1 precedence rule.
5. **Hoist the OAuth-only post-restore block** into the merged path, gated on
   `auth_type == "oauth"`: the recovery probe, `recovery_gate_target`,
   `oauth_recovery_check_needed` (468–504) and `recovery_rotation_pending` (507–517).
   **Mandatory, not optional** — the DB branch has no counterpart, and leaving the gate at
   its `Skipped` default is the state `session_restore.rs:65-84` describes as corrupting the
   drive password via `ensure_sync_mnemonic`.
6. `should_clear_oauth` becomes "drop the localStorage hint": `true` on hard-invalid paths,
   `false` on the keychain-soft path so M-1 still holds.

**Rust — legacy-row repair (the §2.2 blocker):**

7. In `rehydrate_or_restored` (`session_restore.rs:156`), use
   `derive_verified_keys(mnemonic, addr)` instead of the bare derive, and refuse to
   rehydrate when the keychain mnemonic does not derive the row's address — fall back to
   `Restored` / `OAuthOnly`. This generalizes the H-3/H-4 guard to the restore path and
   makes a mislabelled row degrade instead of splitting the identity.
8. **Self-healing provider repair:** when the row says `provider = "mnemonic"` but a present
   keychain mnemonic derives a *different* address, the row is a mislabelled OAuth account —
   correct it to `"oauth"` with one UPDATE, then continue on the corrected value. Only repair
   on a **positive mismatch** (mnemonic present *and* derives a different address); an
   absent or unreadable keychain must never trigger it, or a genuine mnemonic user with a
   locked keychain would be relabelled.

**Rust — behavior parity (validated as required, not optional):**

9. `logout_time_ms` must be `None` when `provider == "oauth"`. The DB branch returns
   `logout_time_minutes.unwrap_or(1440)` (598-599), and `complete_oauth_flow` passes `None`,
   which the upsert binds as an explicit NULL (`auth_session_repo.rs:86-111`) — overriding
   the column's `DEFAULT 1440`. Without this, **every OAuth user gains a 24-hour forced
   logout.** This was "decision D1" in the first draft; validation shows it is a regression
   guard.
10. Keep `redirect_to` per-provider (`None` for oauth, `Some("/")` otherwise), or every
    OAuth boot force-navigates home.

**Frontend:**
11. `wallet-auth-context.tsx:249-289` — remove both localStorage reads and both IPC args.
12. New `app/lib/auth/oauthSessionHint.ts` — one write/clear funnel for the token-free hint.
13. Wire it into `wallet-auth-context.tsx:509` and `app/auth/callback/page.tsx:132`.
14. One-time boot scrub stripping `token` from any hint an older build wrote.

### 3.5 Tests

15. Merged-path Rust unit cases: valid OAuth row → authenticated + gate armed; expired row →
    cleared + `/login`; keychain-unavailable + unexpired → soft with `should_clear_oauth == false`.
16. **Legacy-row regression test** — a row with `provider="mnemonic"` under an address the
    keychain mnemonic does not derive must not split the identity, must be repaired to
    `"oauth"`, and must arm the recovery gate.
17. **OAuth logout-time test** — an OAuth row with NULL `logout_time_minutes` returns
    `logout_time_ms: None`, not 1440 minutes.
18. Rewrite the pin `db_fallback_restore_checks_expiry_before_keychain_soft_path` in
    `tests/auth_wiring_pins.rs` — it is a **source-text** pin bounded by the markers
    `"// ── Fall back to Rust DB session"` and `"// Valid session — build OAuth session"`,
    so it fails at runtime, not compile time.
19. Deletion pin: `session_restore.rs` no longer references `oauth_session_json`.
20. Frontend vitest: hint never contains `token`; boot scrub strips a legacy blob;
    `restore_session` invoked with no args.
21. Manual matrix: fresh OAuth login → restart; mnemonic login → restart; locked keychain;
    settings API-token section still renders after restart; **a pre-#102 profile with a
    legacy `provider="mnemonic"` OAuth row.**

### 3.6 Risk

**Rollback becomes impractical after first boot.** The current DB branch sets
`should_clear_oauth = oauth_session_json.is_some()` (`:547`), so the first boot on the new
build wipes the blob. A user who then downgrades has no localStorage session and must sign in
again. Acceptable, but it belongs in the release notes.

**Effort:** ~1.5 days with the legacy-row repair and its tests. Single PR.

---

## 4. PR 2 — log the direct-grant branch (replaces L-3)

22. Add a `warn!` on entry to the direct-grant branch (`oauth.rs:586`), recording that a
    deep link delivered a bearer token directly.

Ten minutes. This is the evidence-gathering step for PR 3.

## 5. PR 3 — delete the direct-grant branch (closes R-02 / L-4 with no API change) — *gated*

23. Once a release confirms the PR 2 warning never fires, delete the direct-grant branch,
    the `token` parameter handling, and M-7's empty-`substrate_address` case (which exists
    only to guard that branch). This removes the RFC 6750 §2.3 violation desktop-side.

Gated on one release of clean logs. Also resolves §7 — with the branch gone, the question of
whether the API can return an empty address becomes moot.

## 6. PR 4 — delete the state-less fallback (S-3) — *gated*

The strict path was verified complete for every case: valid state, expired state
(`purge_expired` runs first at `oauth.rs:552`), restart mid-flow (`load_pending_states`,
`:543`), overlapping double-started logins (natively handled — the map is keyed by state),
and missing state post-deletion (the existing error at `:568-570`). No orphaned-row problem:
the strict path already deletes exactly one mirror row, and cleanup comes from the
opportunistic prune at `:149-155` plus the TTL filter in the load query.

**Delete:** `consume_fallback_flow` (`oauth.rs:193-215`), the state-less `else` branch
(`:565-583`), `clear_pending_states` (`:185-191`, becomes dead code), the tests
`fallback_consumes_newest_of_multiple_flows_and_drains_map` (`:880`),
`fallback_consumes_single_flow` (`:896`), `fallback_rejects_when_nothing_pending` (`:907`),
rewrite `consumed_and_drained_states_are_removed` (`:943-956`), and the doc blocks at
`oauth.rs:19-29`, `:522-530` plus the CLAUDE.md "State-less callback fallback" sentence.
**Keep `make_state_with`** — still used by `persisted_reload_does_not_clobber_memory` (`:964`).

24. **Unverified pre-req — confirm before merging:** `parse_oauth_deep_link`'s JSON `session`
    fallback (`oauth.rs:462-480`) extracts `code`, `username` and `user_id` but **not
    `state`**. If console #597 forwards `state` inside the session JSON rather than as a
    top-level query parameter, the desktop drops it silently and **every login breaks the
    moment the fallback is deleted.** Confirm the wire shape first.
25. Watch the **existing** warning at `oauth.rs:577-581` for one release. When it stops
    firing, the fallback is provably dead.
26. Delete, and update the pin `oauth_mirror_consume_stays_inside_the_state_lock`
    (`tests/auth_wiring_pins.rs:120,129-132`) — another source-text pin that **panics at
    runtime rather than failing to compile.**

**Residual risk:** a console *rollback* after the desktop ships without the fallback breaks
every login with no client-side recovery. Worth agreeing with whoever owns the console deploy.

With PKCE parked, `state` is the only CSRF control on this flow, so this is the
highest-value security item remaining.

---

## 7. Open question for the API owner

M-7 (shipped in #105) hard-fails a callback returning an empty `substrate_address`. If
`/api/auth/exchange/` can legitimately return one — e.g. provisioning completing
asynchronously — those logins now break, and with the API frozen the contingency is a
desktop-side defer-or-retry.

**PR 3 dissolves this question** (the branch it guards disappears), so it only needs an
answer if PR 3 slips past the next release.

## 8. Parked — requires API changes

- **S-2 PKCE (RFC 8252 MUST).** Needs the server to store a `code_challenge` and verify the
  verifier. Also blocked on a wire conflict: the desktop currently sends the *provider name*
  in the `code_verifier` field (`oauth.rs:596-608`). **Residual risk:** an app that registers
  `hippiusapp://` can intercept a callback; `state` protects against a *forged* callback, not
  interception of a real one. Compensating control: PR 4 makes `state` strict.
- **S-6 server-returned expiry.** Desktop assumes `now + 30d` in three places
  (`oauth.rs:639,642`, `service.rs:194`). Compensating control: the
  `hcfs_auth_relogin_required` toast from #104 makes the resulting 401 visible.
- **S-5 redirect scheme.** Correction to the first draft: the API only ever sees
  `https://console.hippius.com/auth/callback` (`oauth.rs:218,344-345`), so a **loopback
  redirect would need API involvement** while a **scheme rename would not**. Parked anyway —
  reverse-domain naming reduces collision but does not stop a determined squatter, and the
  control that matters (PKCE) is parked. The rename would touch `tauri.conf.json:27-31`,
  `Info.plist`, `oauth.rs`, `main.rs`, two frontend files, the console, and
  `macos/HippiusFinder/HippiusFinderSync.swift` — the Finder extension opens the app by the
  same scheme — plus a dual-scheme migration window. If PKCE is ever scheduled, do the rename
  in the same effort.

## 9. Sequencing

1. **PR 1** (S-4 + the legacy-row repair) — the only substantive work; no external deps.
2. **PR 2** (direct-grant `warn!`) — ship alongside PR 1; starts the PR 3 window.
3. **Confirm** the console `state` wire shape (item 24) — a question, not code.
4. **PR 3** and **PR 4** — both after one release of clean logs, in either order.

## 10. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | Should the auto-logout timer apply to OAuth users? | **Not a free choice** — must stay `None` in PR 1 or every OAuth user gets a 24h forced logout. Revisit as a product question separately. |
| D2 | Repair legacy `provider="mnemonic"` OAuth rows in place? | Yes — self-healing on positive mismatch only (§3.4 item 8) |
| D3 | Accept the §8 residual risks while the API is frozen? | Yes, with §8 as the written record |
| D4 | Accept the console-rollback risk before PR 4 merges? | Needs the console deploy owner's agreement |
