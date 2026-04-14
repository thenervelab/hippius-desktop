# OAuth Account Recovery

**Date:** 2026-04-14
**Status:** Design (revised after review)
**Related:** 2026-04-13-console-password-blob-design.md

## Problem

A user who logs in via OAuth, syncs files, then wipes their device, cannot currently recover their data on a fresh install. The app prompts "Setup your encryption" — suggesting first-time setup — instead of "Unlock your account". The server already supports encrypted mnemonic blobs (via the Console Access feature), but:
- Console Access is opt-in, so users who never enabled it have no blob to recover from (this is how Dubs got stuck).
- No client flow fetches and decrypts the blob on re-login; the Settings page assumes first-time setup.

The goal: make recovery always-on so every OAuth account is recoverable by password, and wire the unlock flow into OAuth callback.

## Guarantees (verified)

- **SS58 is server-provided**: `oauth.rs:420` extracts `user.substrate_address` from Hippius backend's OAuth exchange response. Same OAuth identity → same SS58 across devices.
- **KDF params travel with the blob**: hcfs-client's `SealedBlob` embeds Argon2id params + salt + nonce + AAD.
- **AAD binds blob to SS58**: tampered-account detection is free; deterministic SS58 makes this a safety check, not a blocker.
- **Server auth is bearer-token + SS58-scoped**: hcfs-server `get_mnemonic_blob` returns the full sealed payload. **No new endpoint needed.**
- **Passkey gate is gone**: removed in hcfs PR #122, pinned via cargo rev bump to `bcfb6131cc63f7f6ae4f64e86c7f5e1b3e8b5975`.

## Design decisions (committed)

1. **Always-on recovery**: the Console Access Settings toggle is removed. Every OAuth signup seals the mnemonic and uploads unconditionally. No opt-out. This is the only way to guarantee recovery works.
2. **Recovery gates `ensure_sync_mnemonic`**: OAuth callback awaits a `recovery_resolved` flag before any code path that touches the mnemonic store. Otherwise a race mints a new mnemonic + drive password and trips `MasterMnemonicUnrecoverable` when recovery arrives seconds later.
3. **Primary-account only**: V1 restores the OAuth-bound SS58. Sub-accounts are out of scope (and being deprecated from the product). UI says so plainly.
4. **Static default HCFS URL**: `const DEFAULT_HCFS_SERVER_URL` in `recovery.rs`. OAuth callback seeds `hcfs_config.server_url` from it before recovery runs, resolving the `ConfigMissing` blocker on fresh devices.
5. **Reuse existing errors**: wrong password maps to existing `AppError::Validation("Wrong passphrase.")` (`console_access.rs:562-581`). No new error variant.

## Scope

### Track A — hippius-desktop Rust backend

1. **Split `console_access.rs` → `recovery.rs` + thin `console_access.rs`**. Move sealing/unsealing/fetch/install logic into `recovery.rs`. `console_access.rs` keeps only the legacy API surface during transition (removed entirely in a follow-up cleanup when FE references are gone).

2. **Add `DEFAULT_HCFS_SERVER_URL` const** in `recovery.rs`. Source value from existing production URL (confirm with ops). `seed_hcfs_server_url_if_missing(state)` helper writes it into `hcfs_config` when empty.

3. **Add recovery-resolved gate** in `AppState`:
   ```rust
   pub struct AppState {
       // ... existing fields
       pub recovery_resolved: Arc<tokio::sync::Notify>,
       pub recovery_state: Arc<RwLock<RecoveryGateState>>,
   }
   ```
   Enum `RecoveryGateState { Pending, Resolved, Skipped }`. `ensure_sync_mnemonic` awaits `recovery_resolved.notified()` when state is `Pending`. OAuth callback sets `Resolved` after the dialog completes (recover / fresh-setup / no-blob-found paths all resolve).

4. **New Tauri commands** (registered in `main.rs`):
   - `check_recovery_state(account_id) -> RecoveryCheck`
     - Returns `{ has_server_blob, has_local_mnemonic, updated_at?, recommended_flow: "signup" | "unlock" | "proceed" }`.
     - Calls `seed_hcfs_server_url_if_missing` first so the GET succeeds pre-sync-setup.
     - Network failure returns `Unknown` variant; FE shows retry UI.
   - `recover_mnemonic(account_id, password) -> Result<()>`
     - Fetches blob via existing `GET /v1/mnemonic-blob`, deserializes as `SealedBlob`, calls `hcfs_client::mnemonic_blob::open_mnemonic`, writes to local store via `hcfs_client::auth::save_encrypted_mnemonic` + `cache_session_mnemonic`, marks `recovery_resolved`.
     - Wrong password → `AppError::Validation("Wrong passphrase.")` (via existing `crypto_to_err` mapping).
   - `seal_and_upload_mnemonic(account_id, password) -> Result<()>`
     - Extracted sealing half of today's `enable_console_access`, callable from signup dialog.
     - Drops the `confirmed_backup=true` requirement — the server-sealed blob IS the backup.
   - `mark_recovery_skipped(account_id) -> Result<()>`
     - For the narrow case where `check_recovery_state` returns `has_local_mnemonic=true` and no server action is needed; unblocks the gate so sync can proceed.

5. **OAuth callback integration** (`complete_oauth_flow` in `auth/oauth.rs:420`):
   - After session save, before emitting `auth_ready`, emit new event `oauth_recovery_check_needed` with `RecoveryCheck` payload so the frontend can route to the correct dialog before anything else touches mnemonic state.

6. **Remove Console Access Settings surface**: delete the FE Settings entry and the `enable_console_access` / `disable_console_access` / `console_access_status` IPC commands (or mark deprecated and no-op). Blob upload is now wired into signup, not Settings.

7. **Migration for existing users**: one-shot prompt on next launch if user has local mnemonic but no server blob: "Set a recovery password". Called from post-login init. Same `seal_and_upload_mnemonic` command. If user dismisses, prompt again on next launch — never a silent "skip".

8. **Tests** in `src-tauri/tests/recovery.rs`:
   - Round-trip: seal → store (mock hcfs-server) → fetch → unseal → install → verify `get_mnemonic_for_account` returns the same mnemonic.
   - Wrong password: `AppError::Validation`.
   - Tampered AAD (simulated SS58 mismatch): distinct error, logs the mismatch.
   - Gate behavior: `ensure_sync_mnemonic` blocks until `recovery_resolved` fires.
   - Race: if `ensure_sync_mnemonic` is called before gate is resolved, it must NOT mint a new mnemonic.
   - Existing-user migration: local mnemonic + no server blob → `seal_and_upload_mnemonic` succeeds.

### Track B — frontend (Next.js)

1. **New component** `AccountRecoveryDialog` with three branches (driven by `RecoveryCheck.recommended_flow`):
   - **Signup** (no server blob, no local mnemonic): 3-step wizard
     1. "Here is your recovery seed phrase" — display mnemonic, require scroll + check "I've saved this".
     2. "Create a recovery password" — password + confirm, strength meter, explainer ("this password cannot be reset").
     3. "Finalizing…" — calls `seal_and_upload_mnemonic`, resolves gate.
   - **Unlock** (server blob exists, no local mnemonic): password field + "Forgot password?" link. `recover_mnemonic` on submit. Wrong password inline error, allows retry. Forgot-password link opens an explainer: "Your files are encrypted and cannot be recovered without this password. To start over, reset the account — your files will be lost."
   - **Proceed** (local mnemonic already present): `mark_recovery_skipped`, close dialog, continue.

2. **Mount point**: `OAuthCallbackPage` listens for `oauth_recovery_check_needed`, routes to the dialog before redirecting to `/`. The dialog is blocking — no "skip" button except on the Proceed branch.

3. **Existing-user migration dialog**: a separate `SetRecoveryPasswordDialog` that fires post-login for users with local mnemonic + no server blob. Same password-entry UI as signup step 2, reuses `seal_and_upload_mnemonic`.

4. **Delete Console Access Settings entry** and related FE files. The rename "Console Access" → "Account Recovery" from the prior plan is obsolete — there's no Settings surface at all now.

5. **Change-password** (follow-up, not V1): expose `rotate_passphrase` as a Settings action under Account Recovery. Out of V1 scope.

## Edge cases

| Case | Behavior |
|------|----------|
| User has local mnemonic, no server blob | `SetRecoveryPasswordDialog` fires post-login. Can't be dismissed permanently. |
| User forgets password | No reset. Clear messaging. Reset-account flow (out of V1) deletes blob + local state. |
| Tampered AAD / SS58 mismatch | Distinct error ("account mismatch"), logs it — indicates a bug worth diagnosing. |
| Network error on `check_recovery_state` | Retry screen; do not fall through to signup (would overwrite server state on retry). |
| User closes app during recovery | `recovery_resolved` never fires → next launch re-runs the check. Idempotent. |
| User has server blob AND local mnemonic that differ | Trust local, log warning. Shouldn't happen if gate works. |
| GET rate limit (5/hr per SS58) | File issue with hcfs-server to raise to ~30/hr for GET. AEAD is the real rate limiter. Non-blocking for V1. |

## Non-goals (V1)

- Multi-factor recovery (recovery codes, security questions).
- Social / shared recovery.
- Server-assisted password reset.
- Sub-account recovery.
- Change recovery password UI (plumbing exists via `rotate_passphrase`; UI deferred).

## Rollout

1. Bump cargo rev (done).
2. Implement Track A (backend).
3. Integration-test against staging hcfs-server.
4. Implement Track B (frontend).
5. Staged rollout: internal dogfood → canary → full.
6. Monitor `seal_and_upload_mnemonic` success rate and `recover_mnemonic` error rates.

## Size estimate

- Track A: 5 days.
- Track B: 4 days.
- Integration, copy review, QA: 2 days.

**~2 weeks focused work for one engineer.** Passkey blocker dissolved via rev bump; sub-account scope removed; no new server endpoint needed.

## Open coordination items (not blocking)

- **File follow-up issue on hcfs-server** to raise GET `/v1/mnemonic-blob` rate limit to ~30/hr — 5/hr will cause password-typo lockouts.
- **Confirm default HCFS URL** with ops before committing the const.
- **Schedule Console Access FE removal** with any team that references it (check for external docs / support scripts).
