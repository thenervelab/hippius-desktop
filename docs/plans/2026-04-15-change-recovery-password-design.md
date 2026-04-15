# Change Recovery Password — Design

Date: 2026-04-15
Status: Implemented in feature/change-recovery-password
Owner: Desktop
Scope: Desktop-only (`hippius-desktop`). No hcfs-server changes.

## 1. Goal & Scope

Let a signed-in user rotate the password that encrypts their sealed mnemonic
blob on hcfs-server, without changing the underlying mnemonic itself.

### In scope

- **Settings → Security / Recovery** entry point ("Change recovery password").
- Dialog with current / new / confirm fields, strength meter on the new
  password, "new must differ from current" rule.
- Rust IPC command that GETs the sealed blob, decrypts with the current
  password, re-seals with the new password, POSTs the upsert, and re-encrypts
  the local `master_enc_mnemonic.json`.
- Partial-failure handling via a sidecar file so a boot-time retry finishes
  the rotation if the local rewrite fails after a successful upload.
- Button only rendered when the server already holds a blob
  (`hasServerBlob === true`).

### Out of scope (YAGNI)

- No "forgot current password" reset path. The blob is unrecoverable without
  the password by construction; a user who forgot it must reset the account.
- No audit log / rotation history in UI.
- No cross-device "your password changed" notification.
- No custom rate-limit UI beyond surfacing the server's 429 message.
- No hints, last-changed timestamps, or other metadata.

## 2. hcfs-server changes

**None.** `POST /v1/mnemonic-blob` is already an upsert
(`handlers/console_blob.rs:262` → `upsert_mnemonic_blob`). The server stores
ciphertext only and cannot distinguish "set for the first time" from
"rotate". Existing features are sufficient:

- Bearer-scoped to the caller's SS58 — a user can only overwrite their own
  blob.
- Rate limiting already applied per SS58 (covers brute-force concerns).
- Upsert runs in a single DB transaction.
- `BlobMetadata.updated_at` already exposed for future UI needs.
- Existing Ed25519-signed-body verification (if any) is already wired for
  the existing `seal_and_upload_mnemonic` call, which we reuse at the wire
  level.

## 3. UX flow

### Entry point

A row in Settings → Security / Recovery:

```
Recovery password
Protects your account on new devices. Change it if you suspect it was
exposed.                                               [ Change password ]
```

Rendered only when `check_recovery_state().hasServerBlob === true`. For
accounts without a server blob (fresh signup or legacy migration),
pre-existing dialogs handle the state; no "change" affordance here.

### Dialog

Reuses `DialogContainer` with the centering override landed in
`AccountRecoveryDialog`. Three fields top-to-bottom:

1. **Current recovery password** — single password field.
2. **New recovery password** — password field + `StrengthMeter`.
3. **Confirm new recovery password** — live-validated against field 2.

- Primary button: **Change password** — disabled until all three fields are
  filled, new passes the strength bar, new ≠ current, confirm === new.
- Secondary button: **Cancel** — closes dialog, clears all three fields.
- Submitting shows an inline spinner on the primary button.

### Outcomes

| Outcome | UI |
|---|---|
| Success | Close dialog, toast "Recovery password updated." |
| Wrong current | Inline error on field 1 ("Incorrect current password."), clear only field 1 |
| Strength fail | Inline error under the strength meter |
| New == current | Inline error on field 2 |
| Rate-limited (429) | Toast "Too many attempts. Try again in a few minutes." |
| Server / network | Toast with mapped message; dialog stays open |
| Derivation-guard fail | Toast with the full explanation (see §4 step 5); dialog stays open |

No post-success re-login or sync re-init — the mnemonic itself is unchanged,
so every downstream key (drive password, session mnemonic, cached auth)
stays valid.

## 4. Backend flow (Rust)

New Tauri command in `src-tauri/src/recovery.rs`:

```rust
#[tauri::command]
pub async fn change_recovery_password(
    state: tauri::State<'_, crate::app_state::AppState>,
    current: String,
    new: String,
) -> Result<()> { ... }
```

Both `String`s are wrapped in `Zeroizing` on the first line.

### Steps

1. **Resolve context** — `state.current_account_id()`, `state.pool()?`,
   `seed_hcfs_server_url_if_missing(pool, &account_id)`, `HcfsServerCtx::resolve`.
2. **GET `/v1/mnemonic-blob`** → `SealedBlob`. A 404 returns
   `AppError::Other("No sealed recovery blob on the server.
   Set a recovery password first.")`. The FE shouldn't reach this, but we
   defend.
3. **Decrypt** with `open_mnemonic(&blob, &current, &ctx.ss58)`. Wrong
   password maps through `crypto_to_err` to `AppError::Validation("Wrong passphrase.")`.
4. **Validate the new password**:
   - Non-empty (`AppError::Validation`).
   - Strength via the same scorer used at signup (`PassphraseStrength::acceptable_for_submit`). Failing strength returns `AppError::Validation` with the reason.
   - `new != current` (`AppError::Validation("New password must differ from current.")`).
5. **Derivation guard** — call `validate_master_against_existing_folders(pool, &account_id, &mnemonic)`, already landed for the signup path. Reused verbatim. Failure: `AppError::Other(<full explanation>)`.
6. **Reseal** — `seal_mnemonic(&mnemonic, &new, &ctx.ss58)` → new `SealedBlob`.
7. **POST `/v1/mnemonic-blob`** with the new blob. Commit point. 2xx required before step 8.
8. **Re-encrypt local file** — `install_recovered_mnemonic(&account_id, &mnemonic, &new)`. On success, ensure any pending sidecar (§5) is cleared.
9. **Cache** — `auth.cache_session_mnemonic(&account_id, mnemonic)` (same payload; refreshes any internal TTL).

Tracing: `info!` on entry and success; `warn!` on the soft-fail at step 8;
`error!` only for unexpected failures. Never log `current`, `new`, or any
mnemonic bytes.

## 5. Partial-failure sidecar

### Problem

If step 7 succeeds but step 8 fails, the authoritative server blob is
encrypted under the **new** password while the local
`master_enc_mnemonic.json` is still encrypted under the **old** password.
The next `check_recovery_state` returns `flow=Proceed` (local file present),
so no dialog would ever fire. If the in-memory mnemonic is later evicted
(keychain miss on reboot), the user hits an AEAD-tag failure trying to
decrypt the local file with the new password they expect to work.

### Mechanism

1. After a successful POST in step 7, write a sidecar
   `recovery_pending_local_rewrite.json` next to `master_enc_mnemonic.json`
   containing `{ "ss58": "...", "created_at_ms": ... }`. Mode `0o600`.
   No password or mnemonic in it.
2. Attempt step 8. On success: delete the sidecar. On failure: leave it.
3. On app boot, after `restore_session` populates `AuthInfo`, check for the
   sidecar:
   - If the account's mnemonic is available in `AuthInfo.session_mnemonic`,
     prompt once via a dedicated dialog:

     > Finishing recovery password change
     >
     > Please re-enter your new recovery password to complete the update.

     - Cheap verification: call `open_mnemonic(&server_blob, &password, ...)`
       round-trip. On success, `install_recovered_mnemonic` + delete
       sidecar.
     - On AEAD failure: reopen the prompt with an inline error.
   - If the mnemonic isn't in `AuthInfo` (user logged out between failure
     and boot), delete the sidecar, emit an informational toast
     ("Your password change didn't fully finish; you may be asked to unlock
     with your new recovery password next time."), and let the existing
     `recover_mnemonic` path rewrite the local file on the next unlock.

### Why a sidecar file

Matches how `master_enc_mnemonic.json` already lives — same directory,
same `0o600` permission model, one place to clean up per account. Avoids a
new DB row for a state that's inherently tied to a specific account's file
tree.

## 6. Error handling

| Scenario | Variant | FE behavior |
|---|---|---|
| Wrong current password | `Validation("Wrong passphrase.")` | Inline on field 1 |
| New fails strength | `Validation("Password is too weak. <reason>")` | Inline on field 2 |
| New == current | `Validation("New password must differ from current.")` | Inline on field 2 |
| Derivation guard fails | `Other("... out of sync with folder state ...")` | Toast; dialog stays open |
| Server 404 on GET | `Other("No sealed recovery blob on the server...")` | Toast; close dialog |
| Server 429 | `Validation("You've hit the rate limit...")` (existing) | Toast |
| Server 5xx / network | `Api{status, body}` / `Other` | Generic toast, log |
| Local rewrite failure | **Not an error** — `Ok(())`, sidecar written, warn log | Success toast; next-boot retry |
| Mnemonic missing on boot retry | `Other("Session mnemonic unavailable...")` | Informational toast; sidecar deleted |

### Invariants

- `current`/`new` wrapped in `Zeroizing` on entry. Never logged.
- All mnemonic / sealed-blob bytes live in `Zeroizing` heap allocations.
- No `println!`/`dbg!`. `tracing` macros only.
- Every failure path before step 7 leaves zero side effects.
- Between steps 7 and 9, the sidecar is the only piece of persisted state
  that says "more work needed".

### Concurrency

The command is async but not reentrant-safe at the storage layer. Driven by
a single user click on a modal, so realistic contention is zero. Skipping a
mutex for v1. If we ever see a race, add `recovery_rotation_lock: Mutex<()>`
to `AppState`.

## 7. Testing

### Rust (`src-tauri/tests/` + inline `#[cfg(test)]`)

1. **Happy path** — mock server ctx. Assert full GET → decrypt → reseal →
   POST → local-rewrite chain, no sidecar left.
2. **Wrong current password** — `AppError::Validation("Wrong passphrase.")`,
   no POST, no mutation.
3. **New equals current** — `Validation`, no network call.
4. **New fails strength** — `Validation` with reason, no network call.
5. **Derivation guard** — seed a folder `enc_mnemonic.json` derived from a
   different master. Assert `Other` with the explanation, no POST.
6. **Local rewrite failure → sidecar written** — mock
   `install_recovered_mnemonic` to error. Assert `Ok(())` from the command,
   sidecar present, warn log emitted.
7. **Boot-time retry happy path** — pre-seed sidecar + `AuthInfo` mnemonic
   + correct password. Assert retry succeeds, local file re-encrypts,
   sidecar deleted.
8. **Boot-time retry wrong password** — same as 7 with wrong password.
   Assert sidecar retained, AEAD error surfaced, prompt reopens.
9. **Boot-time retry with no mnemonic in `AuthInfo`** — assert sidecar
   deleted, informational toast event emitted.
10. **Zeroization sanity** — confirm the command signature takes `String`
    and the first line wraps in `Zeroizing`. No logged field ever carries
    the password.

### Frontend (Vitest)

- Smoke test: mount dialog, fill fields, assert button enable/disable logic
  for strength/match/new-equals-current.
- One snapshot for the wrong-current-password error state.

### Manual QA (PR checklist)

- Change password, relaunch, log out, log in on same device with new
  password.
- Change password, relaunch, log in on a **fresh** device with new password
  (full recovery path — most important; verifies server upsert + install).
- Change password with network interrupted between steps 6 and 7 — confirm
  no partial state.
- Change password successfully, then manually delete the local
  `master_enc_mnemonic.json` before next launch. Confirm the existing
  `recover_mnemonic` flow rewrites it with the new password on next unlock.

### What we are NOT testing

Server upsert semantics, rate limits, or auth. Those belong to hcfs-server's
own suite.
