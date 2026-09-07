---
paths:
  - "src-tauri/src/auth/**"
  - "src-tauri/src/recovery*.rs"
  - "src-tauri/src/console_access.rs"
  - "app/lib/wallet-auth-context.tsx"
  - "app/lib/auth/**"
  - "app/components/auth/**"
  - "app/components/recovery/**"
  - "app/auth/**"
---

# Auth, session restore, and recovery

Modules: `login.rs` (mnemonic login), `logout.rs`, `session_restore.rs` (boot-time rehydration), `service.rs` (token refresh, key derivation), `oauth.rs`, `ssh_keys.rs`, `billing_auth.rs`, `tokens.rs`, `keychain.rs`, `contacts.rs`, `state.rs` (`AuthInfo`), `account_key.rs`, `auth_session_repo.rs` (SQLite session CRUD with inline tests).

## Identity guard (the rule that governs every re-auth path)

Every path that RE-authenticates an existing account from a stored mnemonic — `service.rs::refresh_auth_token_internal`, `billing_auth.rs::ensure_billing_auth`, and restore's `load_keychain_identity` — must derive via `service.rs::derive_verified_keys(mnemonic, account_id)`, **never the bare `derive_keys`**. An OAuth account's sync mnemonic derives a DIFFERENT identity than its server-custodied login SS58, and the unverified derive challenge-responded as (and could create) a phantom server account, persisting its session/token rows. A refresh mismatch surfaces re-login; a billing mismatch is a non-fatal skip. Wiring pinned by `tests/auth_wiring_pins.rs` (incl. `restore_identity_check_routes_through_verified_derive`).

## OAuth

- **Completion probe is bounded**: `complete_oauth_flow` runs its post-persistence hcfs-server recovery probe through `session_restore.rs::probe_recovery_state_bounded` (10s, best-effort; `None` parks the recovery gate `Pending`). An unbounded fatal probe failed/hung login after auth had already succeeded.
- **State-less callback fallback**: the console doesn't yet forward the CSRF `state` for desktop deep links, so `complete_oauth_flow`'s fallback (`consume_fallback_flow`) consumes the NEWEST pending flow and drains the rest — the old exactly-one rule rejected every callback for the 5-min TTL after a double-started login. Remove once console forwards `state` (its callback page already does for mobile).
- **Restart-safe flows**: pending CSRF states use wall-clock ms TTL (5 min) and are mirrored to the `oauth_pending_states` table — `start_oauth_flow` persists, `complete_oauth_flow` reloads non-expired rows into the in-memory map (in-memory wins on collision) so an auto-update restart or crash mid-login no longer strands the browser callback. The mirror follows every consume (strict match deletes one row, the state-less fallback drains all); all persistence is best-effort.
- **No half-logins**: `complete_oauth_flow` errors when the callback yields no `substrate_address` instead of returning an unpersistable success the FE would treat as authenticated.
- **Direct-grant deprecation probe**: `complete_oauth_flow`'s `params.token` branch (a bearer token delivered in the deep link — the RFC 6750 §2.3 shape) logs a `warn!` on entry. hippius-console sends only `code`, so the branch should be reachable only via the env-gated dev injector; if a release passes without the warning firing, the branch can be deleted outright.

## Deep links

Inbound `hippiusapp://` URLs are logged only via `oauth.rs::deep_link_public_part` (scheme+path, never the query — a direct-grant callback carries the bearer token). The FE dedups callbacks on `ParsedDeepLink.dedupKey` (Rust-computed SHA-256 of the URL; `app/lib/auth/deepLinkDedup.ts` keeps a legacy raw-URL comparison for markers written by pre-fix builds) instead of persisting the raw URL in localStorage.

**The deep-link listener is GLOBAL**: `app/components/auth/DeepLinkListener.tsx`, mounted once in `AppShell`'s full-app branch. When it lived inside `LoginForm`, a callback arriving on any other route (the `/auth/callback` error screen of a failed attempt, the splash, home) was silently dropped.

**The dedup marker expires**: `DEEP_LINK_DEDUP_TTL_MS` (10 min, past the backend's 5-min state TTL). It used to latch forever, making a re-clicked "Open Hippius" button a permanent silent no-op.

The session-expired toast id is the exported `AUTH_RELOGIN_TOAST_ID` (`useSyncEvents.ts`), dismissed by every login success path in `wallet-auth-context`.

## Session restore

**DB-authoritative; the bearer token never touches localStorage.** `restore_session` takes NO arguments — the `auth_session` row is the single source of truth. The frontend used to pass its localStorage OAuth session in, which forced the renderer to persist the bearer token (OWASP: no session secrets in Web Storage) and meant any future token rotation would log the user out at the next boot once the two copies diverged.

`hippius_oauth_session` survives ONLY as a **token-free hint** written through the single funnel `app/lib/auth/oauthSessionHint.ts` (`persistOAuthSessionHint` / `clearOAuthSessionHint`; `toOAuthSessionHint` is a deliberate allowlist so a field added to `OAuthSession` later cannot silently start landing on disk). Its only consumers are the synchronous "is someone signed in?" checks in `app/auth/callback/page.tsx` and `DeepLinkListener.tsx`, which read presence + expiry and never the token; the token itself lives in React state, fed from the IPC response (`ApiTokenSection` displays it). `scrubLegacyOAuthToken` runs on every boot to delete a token a pre-fix build already wrote.

**The localStorage hint is written for OAuth sessions only** (`result.authType === "oauth"`): Rust rebuilds an `oauthSession` object for every auth type, but both hint readers treat a live hint as proof that an inbound OAuth callback is a stale redelivery and swallow it. Writing it for a mnemonic account would break the invariant `DeepLinkListener` states outright — mnemonic sessions never touch the OAuth localStorage keys.

Three merge invariants the unified path MUST keep, each pinned:

1. **OAuth sessions get no idle-logout timer** — `complete_oauth_flow` writes no `logout_time_minutes` and the upsert binds that NULL explicitly, which overrides the column's `DEFAULT 1440`; applying the fallback would hand every OAuth user a 24-hour forced logout. The decision is the pure `resolve_logout_time_ms(auth_type, logout_time_minutes)` rather than an inline ternary, precisely so it can be pinned.
2. **The recovery-gate block** (probe → `recovery_gate_target` → `oauth_recovery_check_needed`) runs for EVERY OAuth restore. It used to exist only on the localStorage path, so a DB-restored OAuth session left the gate at its `Skipped` default — the state `recovery_gate_target`'s docs call unsafe, because `ensure_sync_mnemonic` may then mint a mnemonic on a device needing the server blob.
3. **Legacy mislabelled rows are self-healed** — a pre-#102 `ensure_billing_auth` wrote `provider = "mnemonic"` keyed by an OAuth account's login SS58, and believing that label sends an OAuth account down the mnemonic path where `rehydrate_full_session` writes the DERIVED address into `AuthInfo`, splitting it from the returned session. `check_provider` detects it via the tell (the keychain mnemonic does not derive the row's own account) and `auth_session_repo::repair_provider` corrects it once, without bumping `updated_at`. Repair fires only on a POSITIVE mismatch so a locked keychain never relabels a genuine mnemonic user.

`rehydrate_or_restored` refuses to rehydrate on anything but a verified match (degrading to `Restored`) as defense in depth, and takes a pre-resolved `KeychainIdentity` so the keychain — which can block on an OS password prompt — is read exactly once per restore.

**Keychain fail-soft**: `auth_session_repo` resolves tokens tri-state (`Found` / `Absent` / `KeychainUnavailable` — surfaced as `TokenStatus.keychain_unavailable` / `AuthSessionRow.token_keychain_unavailable`), and `restore_session` fails SOFT — unauthenticated, but NO hint clear and NO `/login` bounce (that path runs a full logout) — when the token is missing solely because the OS keychain is unreadable while the session is unexpired (`classify_restore_token`, unit-tested). Expiry metadata still wins, so an expired session is cleaned up regardless. The classifier is four-way (`Valid` / `KeychainUnavailable` / `Expired` / `Missing`) because only `Expired` may clear the row and bounce to `/login`.

**Boot-restore ordering**: `get_latest` skips cleared rows (`substrate_address IS NOT NULL` — `clear` keeps a husk row for the logout preference AND bumps `updated_at`, which used to shadow another account's live session), and `update_logout_time` deliberately does not bump `updated_at` (a settings edit must not change which account the next boot restores).

**Re-login signal**: `useSyncEvents` listens for `hcfs_auth_relogin_required` (emitted by the sync bridge when the engine cannot re-authenticate, e.g. an OAuth token past its 30-day expiry with no client-side refresh path) and shows one persistent deduped toast.

## Recovery-flow decision table

`recovery.rs::decide_recovery_flow` is failure-aware. The OAuth returning-device shape — `master_enc_mnemonic.json` on disk, undecryptable without the recovery password (`encryption_version=1`, keychain empty) — maps to `Unlock` when the server blob probe returns `Some(true)` and to **`Unknown` when the probe fails (`None`)**, NOT `Proceed`.

`Proceed` maps to gate `Skipped` (`session_restore.rs::recovery_gate_target`), and skipping the gate with an unopenable local file sends `ensure_sync_mnemonic` into a guaranteed dead end (`MasterMnemonicUnrecoverable`) — which is how a transient boot-time probe failure showed an OAuth Google user the mnemonic-flavored "Sync needs your seed phrase" banner even though the server held their sealed blob. `Unknown` parks the gate `Pending` and the FE's `AccountRecoveryDialog` renders its connection-retry branch. Only `(local, !decryptable, blob=Some(false))` — definitively nothing to unlock — stays `Proceed`. Pinned by `decide_recovery_flow_covers_decision_table` (every cell) and the `recovery_gate_target` tests.

The banner (`SyncReauthRequiredAlert.tsx`) is **auth-type-aware**: mnemonic users get the seed-phrase copy and a CTA to `/login?reauth=1`; OAuth users get "unlock password" copy and a CTA that re-runs `check_recovery_state` and adopts any non-`proceed` flow into `activeRecoveryCheckAtom` (opening the recovery dialog — Rust decides which branch), falling back to the seed-phrase form only on `proceed`. Component tests in `app/components/ui/__tests__/SyncReauthRequiredAlert.test.tsx`.

**Unlock-time provider repair**: a pre-#102 row (`provider="mnemonic"` for an OAuth account) with an EMPTY keychain evades `restore_session`'s repair (`check_provider` needs a keychain mnemonic for its positive-mismatch tell) and restores down the mnemonic path — banner from `restore_session`, an unconfigured 24h logout timer (log tell: `"Restoring session"` `auth_type=mnemonic`). Recovery path: `RecoveryEventListener`'s mount-time self-heal pops the Unlock dialog, and a successful `recover_mnemonic` now (1) runs `session_restore::repair_provider_from_recovered_master` — the recovered master IS the positive evidence: doesn't derive the row's SS58 + row says `mnemonic` ⇒ repair to `oauth`, via the same `check_provider` funnel; a master that DOES derive it proves a genuine mnemonic user who set an unlock password (which the settings page allows — this is why blob presence alone is NOT a safe repair tell), and (2) emits `hippius_auth_ready` (the mnemonic-labelled paths park no `ensure_sync_mnemonic` to emit it on resume). The FE `UnlockBranch` clears `syncRequiresReauthAtom` on success. Unit tests in `session_restore.rs` (`unlock_repair_*`), wiring pin `recover_mnemonic_repairs_provider_and_wakes_sync`, FE test `AccountRecoveryDialog.unlock.test.tsx`.

**Same-session sync resume after unlock** (`recovery.rs::spawn_post_unlock_sync_init`): the FE `tryAutoInitSync` retry ladder expires 10s after subscribing — long before a human finishes typing an unlock password — so on the restore-time unlock paths nothing would re-run sync init until the next launch. `recover_mnemonic` spawns `auto_init_sync` itself after resolving the gate (Rust owns the "unlock succeeded ⇒ sync can start" transition). The spawn skips when any drive is already initialized (auto-init re-inits unconditionally — teardown + re-init — so running it over live drives restarts their cycles for nothing), and a race with the fresh-OAuth-login flow's own FE-driven init is resolved by `AutoInitGuard`. `recover_mnemonic`, `restore_with_mnemonic`, and `reset_unlock_password` all wake sync this way (they are the lockout-exit paths); `seal_and_upload_mnemonic` and current-password rotation are never sync-wedged.

## Forgot unlock password, still has the mnemonic

`restore_with_mnemonic` / `reset_unlock_password`; design `docs/plans/2026-08-26-restore-unlock-with-mnemonic-design.md`.

Files are encrypted with keys derived from the master BIP-39 (`derive_folder_mnemonic` → `derive_encryption_key`), not the unlock password. The password only wraps the mnemonic (Argon2id + XChaCha20). **Copy must not say files are encrypted with the password.**

Restore **never mints** (`seal_and_upload_mnemonic` does on a miss — a wrong-master POST would upsert over the real blob). Proof is fail-closed (`recovery_proof.rs::decide_master_proof`): Confirmed via mnemonic identity (`derive_verified_keys`), drive-password row, local folder seals, or a remote-file decrypt; Unproven/Mismatch refuse to POST. Folder-seal comparison uses the same own-drive filter as `reencrypt_all_folder_mnemonics` (`owner_ss58 IS NULL AND wire_folder_hash IS NULL`) — a member seal is the owner's mnemonic and must not veto a correct master. Remote decrypt treats AEAD/hash misses as Mismatch and transport errors as retryable, never as a wrong phrase. OAuth identity mismatch is not a phrase mismatch (login SS58 ≠ sync mnemonic). Live recovery-binding is not probed: `challenge_response` as a typed phrase would mint a phantom account.

OAuth users must not be sent to `/login` with the seed (that authenticates as the derived SS58, an empty namespace); the Unlock dialog restores in-session. Settings "Forgot current password?" uses `reset_unlock_password` when the session already holds the master, else the same phrase form. Empty accounts with no files and no local seals stay Unproven — the remaining honest dead end.

## Unified recovery / drive password

The user's **recovery password** is the single password protecting every piece of local key material — the sealed blob on hcfs-server, `master_enc_mnemonic.json`, AND the per-folder `enc_mnemonic.json` files (via `hcfs_config.drive_password`, which mirrors the recovery password). The mnemonic itself is unchanged across password rotations, so sync/drive-init paths continue to work without re-derivation.

The private `align_drive_password` helper in `src-tauri/src/recovery.rs` runs after every flow that settles a "canonical password is now X" moment — signup (`seal_and_upload_mnemonic`), fresh-device unlock (`recover_mnemonic`), rotation (`change_recovery_password` Ok branch), and boot-time sidecar retry (`resume_recovery_password_rotation`). It writes the `hcfs_config.drive_password` row (encrypted with a mnemonic-derived HKDF key) and then calls `sync::mnemonic::reencrypt_all_folder_mnemonics` to rewrite every folder's `enc_mnemonic.json` under the new password. Folder mnemonics are deterministically re-derivable from the master via `derive_folder_mnemonic(master, label)`, so the rewrite doesn't need the old drive password — idempotent on repeat calls.

**The server blob has a second writer (Hippius Console), so two guards hold.** The Unlock path (`recover_mnemonic`) runs the same folder-derivation guard as the write paths (`validate_master_against_existing_folders`, with `GuardFlow::Unlock` selecting the wording) BEFORE `install_recovered_mnemonic`, because an opened blob is no longer proof its master derives this device's folder seals; and `seal_and_upload_mnemonic` re-probes `GET /v1/mnemonic-blob` immediately before its POST (`decide_seal_upload`: only a definite 404 proceeds; present refuses with wording per `SealOrigin`, unknown refuses as `Auth` for 401/403 and retryable `Hcfs` otherwise), because the boot-time routing can be stale. The guard consults the encrypted `drive_password` row BEFORE the folder short-circuit: a device that removed its drive locally has no `sync_paths` rows but still holds that row under the real master, and it is proof on its own (the restore path's `probe_drive_password_row` already treats it so). Pinned by `tests/recovery_writer_guards.rs` (order AND `?` propagation). The Settings "Set/Change Unlock Password" row re-runs `check_recovery_state` at click time for the same reason, adopting the answer only when `recommendedFlow !== "unknown"` — an offline probe resolves (never throws) with `hasServerBlob: false`.

`recovery_binding.rs` binds the OAuth login account to the encryption mnemonic via the sealed recovery blob (login SS58 + SS58-as-AEAD-AAD), solving cross-device recovery without a separate association. Proof table: `recovery_proof.rs`.

(The crate-wide `HOME_LOCK` rule for `$HOME`-touching tests lives in the root CLAUDE.md invariants — it applies well beyond this subsystem.)
