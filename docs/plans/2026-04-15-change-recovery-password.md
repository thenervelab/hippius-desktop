# Change Recovery Password Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a signed-in user rotate the password that encrypts their sealed mnemonic blob on hcfs-server, without changing the underlying mnemonic.

**Architecture:** New Rust IPC `change_recovery_password(current, new)` performs GET → decrypt → validate → reseal → POST-upsert → rewrite local `master_enc_mnemonic.json`. A sidecar file guards partial failures so the next launch can finish the rotation. Frontend adds a "Change recovery password" button to the existing `RecoveryPhraseSettings` and a dedicated modal.

**Tech Stack:** Rust + Tauri 2 (`src-tauri/src/recovery.rs`), SQLx, tokio. Frontend: React + Jotai + Radix Dialog + Sonner toasts. Tests: `cargo test`, Vitest.

**Design reference:** `docs/plans/2026-04-15-change-recovery-password-design.md`

**Worktree:** `/Users/georgiosdelkos/Documents/GitHub/Bitensor/hippius-desktop/.worktrees/change-recovery-password` on branch `feature/change-recovery-password`.

**Conventions:**
- All `String` passwords wrap in `Zeroizing` on the first line of the function.
- Never log a password or mnemonic — not in `tracing` fields, not in error messages.
- Prefer `info!`/`warn!`/`error!` over `println!`.
- Every step ends with a commit. Use imperative mood, ≤72 char subjects.
- Each task opens with a failing test (TDD) except when pure wiring (e.g. `generate_handler!`).

---

## Task 0: Baseline verification

**Step 0.1 — Confirm worktree state**

Run:
```
cd /Users/georgiosdelkos/Documents/GitHub/Bitensor/hippius-desktop/.worktrees/change-recovery-password
git status
git log --oneline -3
```

Expected: clean worktree on `feature/change-recovery-password` branched from `sync-engine`.

**Step 0.2 — Baseline Rust compile**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo check -q`
Expected: exits 0 with no output.

**Step 0.3 — Baseline Rust tests**

Run: `SQLX_OFFLINE=true cargo test --lib recovery -q 2>&1 | tail -10`
Expected: `recovery::tests` section passes.

No commit in this task.

---

## Task 1: Rust — `change_recovery_password` skeleton + wrong-current test

**Files:**
- Modify: `src-tauri/src/recovery.rs` (end of file)
- Modify: `src-tauri/src/main.rs` (imports + `generate_handler!`)

**Step 1.1 — Write the failing test**

Append to `src-tauri/src/recovery.rs`, inside the existing `#[cfg(test)] mod tests` block:

```rust
#[test]
fn change_password_rejects_empty_new() {
    // Unit-testable precondition check: new password must be non-empty.
    // (Full IPC path exercised by integration tests in Task 3.)
    let err = super::validate_new_password_inputs("current", "").unwrap_err();
    match err {
        AppError::Validation(msg) => assert!(msg.contains("cannot be empty")),
        other => panic!("expected Validation, got {other:?}"),
    }
}

#[test]
fn change_password_rejects_new_equals_current() {
    let err = super::validate_new_password_inputs("same", "same").unwrap_err();
    match err {
        AppError::Validation(msg) => assert!(msg.contains("must differ")),
        other => panic!("expected Validation, got {other:?}"),
    }
}
```

**Step 1.2 — Run test; verify failure**

Run: `SQLX_OFFLINE=true cargo test -p Hippius change_password -q 2>&1 | tail -10`
Expected: compile error — `validate_new_password_inputs` undefined.

**Step 1.3 — Implement `validate_new_password_inputs`**

Add to `src-tauri/src/recovery.rs` above the `#[cfg(test)]` block:

```rust
/// Pure input validation for [`change_recovery_password`]. Separated so
/// unit tests can exercise rules without a running Tauri app or network.
///
/// Rules (v1):
/// - new password must be non-empty
/// - new password must differ from current
///
/// Strength scoring is NOT here — it lives in
/// `crate::console_access::score_passphrase` and is called from the IPC
/// command itself so that the structured `PassphraseStrength` reasons
/// can be surfaced in the error message.
fn validate_new_password_inputs(current: &str, new: &str) -> Result<()> {
    if new.is_empty() {
        return Err(AppError::Validation("New recovery password cannot be empty.".into()));
    }
    if current == new {
        return Err(AppError::Validation("New password must differ from current.".into()));
    }
    Ok(())
}
```

**Step 1.4 — Run tests; verify pass**

Run: `SQLX_OFFLINE=true cargo test -p Hippius change_password -q 2>&1 | tail -10`
Expected: both tests pass.

**Step 1.5 — Add the IPC command skeleton**

Below the existing `seal_and_upload_mnemonic` in `src-tauri/src/recovery.rs`:

```rust
// ---------------------------------------------------------------------------
// Change recovery password (rotation)
// ---------------------------------------------------------------------------

/// Rotate the password protecting the sealed mnemonic blob on hcfs-server.
///
/// Flow:
/// 1. GET sealed blob.
/// 2. Decrypt with `current` (wrong password → `Validation("Wrong passphrase.")`).
/// 3. Validate `new` (non-empty, strength, != current).
/// 4. Derivation guard (reuses [`validate_master_against_existing_folders`]).
/// 5. Reseal under `new`.
/// 6. POST upsert (commit point).
/// 7. Re-encrypt local `master_enc_mnemonic.json`. On failure, write a
///    sidecar and return `Ok(())` anyway — boot-time retry finishes it.
///
/// The mnemonic itself is unchanged, so no sync re-init or session
/// invalidation is needed.
#[tauri::command]
pub async fn change_recovery_password(
    state: tauri::State<'_, crate::app_state::AppState>,
    current: String,
    new: String,
) -> Result<()> {
    let current = Zeroizing::new(current);
    let new = Zeroizing::new(new);

    validate_new_password_inputs(&current, &new)?;

    let account_id = state.current_account_id().map_err(AppError::Other)?;
    let pool = state.pool()?;
    seed_hcfs_server_url_if_missing(pool, &account_id).await?;

    info!(
        account = %crate::console_access::short_ss58(&account_id),
        "recovery: starting password rotation (will GET /v1/mnemonic-blob → decrypt → reseal → POST)"
    );

    // TODO(Task 2-5): GET, decrypt, strength check, guard, reseal, POST,
    // local rewrite. Intentionally unimplemented.
    Err(AppError::Other("change_recovery_password: not yet implemented".into()))
}
```

**Step 1.6 — Register the command**

In `src-tauri/src/main.rs`:
- Modify the import on line 48 to include `change_recovery_password`.
- Add `change_recovery_password,` in the `generate_handler!` list right after `mark_recovery_skipped,`.

**Step 1.7 — Compile**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo check -q 2>&1 | tail -5`
Expected: exits 0.

**Step 1.8 — Commit**

```
git add src-tauri/src/recovery.rs src-tauri/src/main.rs
git commit -m "feat(recovery): skeleton change_recovery_password command"
```

---

## Task 2: Rust — strength validation in the command

**Files:**
- Modify: `src-tauri/src/recovery.rs` (`change_recovery_password` body, new test)

**Step 2.1 — Add failing test**

Append to the `tests` module:

```rust
#[tokio::test]
async fn change_password_rejects_weak_new() {
    // Strength scorer lives in console_access and returns acceptable=false
    // for short/low-entropy inputs. We surface the first reason verbatim.
    use crate::console_access::score_passphrase;
    let score = score_passphrase("abc");
    assert!(!score.acceptable_for_submit);
    // The command layer turns this into a Validation error; we reproduce
    // the exact message here so a regression is caught at unit-test level.
    let expected = format!(
        "Password is too weak: {}",
        score.reasons.first().cloned().unwrap_or_default()
    );
    let err = super::reject_if_weak("abc").unwrap_err();
    match err {
        AppError::Validation(msg) => assert_eq!(msg, expected),
        other => panic!("expected Validation, got {other:?}"),
    }
}
```

**Step 2.2 — Run; expect failure (`reject_if_weak` missing).**

Run: `SQLX_OFFLINE=true cargo test -p Hippius change_password_rejects_weak_new -q 2>&1 | tail -10`

**Step 2.3 — Implement `reject_if_weak`**

Add above the `#[cfg(test)]` block in `recovery.rs`:

```rust
/// Return `Err(Validation)` if `candidate` fails the signup strength bar.
/// Extracted for unit testability.
fn reject_if_weak(candidate: &str) -> Result<()> {
    let score = crate::console_access::score_passphrase(candidate);
    if !score.acceptable_for_submit {
        let reason = score.reasons.first().cloned().unwrap_or_else(|| "too weak".into());
        return Err(AppError::Validation(format!("Password is too weak: {reason}")));
    }
    Ok(())
}
```

**Step 2.4 — Wire into the command**

In `change_recovery_password`, right after `validate_new_password_inputs`:

```rust
reject_if_weak(&new)?;
```

**Step 2.5 — Run tests**

Run: `SQLX_OFFLINE=true cargo test -p Hippius change_password -q 2>&1 | tail -10`
Expected: all three unit tests pass.

**Step 2.6 — Commit**

```
git add src-tauri/src/recovery.rs
git commit -m "feat(recovery): reject weak new password in rotation"
```

---

## Task 3: Rust — GET + decrypt + derivation guard + reseal

**Files:**
- Modify: `src-tauri/src/recovery.rs`

**Note:** Full IPC happy-path is tested manually + via the existing mock-free tests added in later tasks. We keep this task focused on composing existing helpers; each is already independently tested.

**Step 3.1 — Fill in the body after `reject_if_weak`**

Replace the `TODO(Task 2-5)` block with:

```rust
let ctx = HcfsServerCtx::resolve(&state).await?;

// 1. Fetch the current sealed blob.
let blob: SealedBlob = match get_json::<SealedBlob>(&ctx, "/v1/mnemonic-blob").await? {
    HttpOutcome::Ok(b) => b,
    HttpOutcome::NotFound => {
        return Err(AppError::Other(
            "No sealed recovery blob on the server. Set a recovery password first.".into(),
        ));
    }
};

// 2. Decrypt with `current`. Wrong password → Validation("Wrong passphrase.").
let mnemonic = open_mnemonic(&blob, &current, &ctx.ss58).map_err(crypto_to_err)?;

// 3. Derivation guard — refuse to rotate under a master that can't
//    reproduce existing folder mnemonics.
validate_master_against_existing_folders(pool, &account_id, &mnemonic).await?;

// 4. Reseal under `new`.
let new_blob = seal_mnemonic(&mnemonic, &new, &ctx.ss58).map_err(crypto_to_err)?;

// 5. Commit point: POST upsert.
post_json_discard(&ctx, "/v1/mnemonic-blob", &new_blob).await?;

info!(
    account = %crate::console_access::short_ss58(&account_id),
    "recovery: sealed blob upserted under new password (server is now authoritative)"
);

// 6. Re-encrypt local file. On failure, write the sidecar so boot-time
//    retry finishes the rotation, and still report success to the user.
match install_recovered_mnemonic(&account_id, &mnemonic, &new).await {
    Ok(()) => {
        clear_rotation_sidecar(&account_id).await;
        state.auth.lock()?.cache_session_mnemonic(&account_id, (*mnemonic).clone());
        info!(
            account = %crate::console_access::short_ss58(&account_id),
            "recovery: password rotation complete"
        );
        Ok(())
    }
    Err(e) => {
        warn!(
            error = %e,
            account = %crate::console_access::short_ss58(&account_id),
            "recovery: server rotated but local rewrite failed — writing sidecar for boot-time retry"
        );
        write_rotation_sidecar(&account_id).await?;
        // Still Ok — the rotation is durable on the server.
        Ok(())
    }
}
```

**Step 3.2 — Add sidecar helpers (stubs; real bodies in Task 4)**

Insert above `validate_master_against_existing_folders`:

```rust
/// On-disk path of the rotation sidecar for `account_id`.
fn rotation_sidecar_path(account_id: &str) -> Result<std::path::PathBuf> {
    let master = crate::sync::mnemonic::master_mnemonic_path(account_id)?;
    let parent = master
        .parent()
        .ok_or_else(|| AppError::Other("master mnemonic path has no parent".into()))?;
    Ok(parent.join("recovery_pending_local_rewrite.json"))
}

async fn write_rotation_sidecar(account_id: &str) -> Result<()> {
    let path = rotation_sidecar_path(account_id)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let body = serde_json::json!({
        "ss58": account_id,
        "created_at_ms": chrono::Utc::now().timestamp_millis(),
    });
    tokio::fs::write(&path, body.to_string()).await?;
    // chmod 0o600 — match master_enc_mnemonic.json.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(&path).await?.permissions();
        perms.set_mode(0o600);
        tokio::fs::set_permissions(&path, perms).await?;
    }
    Ok(())
}

/// Best-effort removal. Missing sidecar is not an error.
async fn clear_rotation_sidecar(account_id: &str) {
    if let Ok(path) = rotation_sidecar_path(account_id)
        && let Err(e) = tokio::fs::remove_file(&path).await
        && e.kind() != std::io::ErrorKind::NotFound
    {
        warn!(error = %e, path = ?path, "clear_rotation_sidecar: failed to remove");
    }
}
```

**Step 3.3 — Compile**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo check -q 2>&1 | tail -5`
Expected: exits 0.

If you get "cannot find function `get_json`" etc., double-check the existing imports at the top of `recovery.rs` — they should already cover `HcfsServerCtx`, `get_json`, `post_json_discard`, `HttpOutcome`, `crypto_to_err` via `use crate::console_access::...`.

**Step 3.4 — Run all recovery tests**

Run: `SQLX_OFFLINE=true cargo test -p Hippius recovery -q 2>&1 | tail -10`
Expected: existing tests still pass, 3 new `change_password_*` pass.

**Step 3.5 — Commit**

```
git add src-tauri/src/recovery.rs
git commit -m "feat(recovery): implement rotation with sidecar partial-fail guard"
```

---

## Task 4: Rust — sidecar write/clear unit test

**Files:**
- Modify: `src-tauri/src/recovery.rs` (`tests` module)

**Step 4.1 — Add failing test**

Append:

```rust
#[tokio::test]
async fn rotation_sidecar_roundtrip() {
    // Use a tempdir as the `HOME` so master_mnemonic_path points into it.
    let tmp = tempfile::TempDir::new().unwrap();
    unsafe { std::env::set_var("HOME", tmp.path()); }

    let account = "5TestSidecarAccount";
    // master_mnemonic_path creates the parent on first write via
    // install_recovered_mnemonic. We mirror that here.
    let sidecar = super::rotation_sidecar_path(account).unwrap();
    tokio::fs::create_dir_all(sidecar.parent().unwrap()).await.unwrap();

    super::write_rotation_sidecar(account).await.unwrap();
    assert!(sidecar.exists(), "sidecar should be written");

    super::clear_rotation_sidecar(account).await;
    assert!(!sidecar.exists(), "sidecar should be removed");

    // Idempotent clear.
    super::clear_rotation_sidecar(account).await;
}
```

Add `tempfile = "3"` to `[dev-dependencies]` in `src-tauri/Cargo.toml` if it isn't there already. Check with:
```
grep -n '^tempfile' src-tauri/Cargo.toml
```
If no match, append `tempfile = "3"` under `[dev-dependencies]`.

**Step 4.2 — Run**

Run: `SQLX_OFFLINE=true cargo test -p Hippius rotation_sidecar_roundtrip -q 2>&1 | tail -10`
Expected: pass.

**Step 4.3 — Commit**

```
git add src-tauri/src/recovery.rs src-tauri/Cargo.toml
git commit -m "test(recovery): roundtrip write/clear rotation sidecar"
```

---

## Task 5: Rust — boot-time sidecar detection + `resume_recovery_password_rotation`

**Files:**
- Modify: `src-tauri/src/recovery.rs`
- Modify: `src-tauri/src/auth/session_restore.rs`
- Modify: `src-tauri/src/main.rs`

**Step 5.1 — Add the resume IPC**

Append to `recovery.rs`:

```rust
/// Boot-time finish for [`change_recovery_password`] partial failures.
///
/// Called by the frontend when the user re-enters their new password
/// after a previous rotation left the local file encrypted under the
/// old password (see sidecar mechanism). Verifies `password` decrypts
/// the current server blob, then rewrites the local file and clears
/// the sidecar.
#[tauri::command]
pub async fn resume_recovery_password_rotation(
    state: tauri::State<'_, crate::app_state::AppState>,
    password: String,
) -> Result<()> {
    let password = Zeroizing::new(password);
    let account_id = state.current_account_id().map_err(AppError::Other)?;
    let pool = state.pool()?;
    seed_hcfs_server_url_if_missing(pool, &account_id).await?;

    let ctx = HcfsServerCtx::resolve(&state).await?;
    let blob: SealedBlob = match get_json::<SealedBlob>(&ctx, "/v1/mnemonic-blob").await? {
        HttpOutcome::Ok(b) => b,
        HttpOutcome::NotFound => {
            // Server blob vanished — nothing left to finish. Clean up.
            clear_rotation_sidecar(&account_id).await;
            return Err(AppError::Other(
                "No sealed recovery blob on the server; nothing to finish.".into(),
            ));
        }
    };

    // Verify the password decrypts the (new) server blob.
    let mnemonic = open_mnemonic(&blob, &password, &ctx.ss58).map_err(crypto_to_err)?;

    install_recovered_mnemonic(&account_id, &mnemonic, &password).await?;
    clear_rotation_sidecar(&account_id).await;
    state.auth.lock()?.cache_session_mnemonic(&account_id, mnemonic.to_string());

    info!(
        account = %crate::console_access::short_ss58(&account_id),
        "recovery: rotation-resume finished; local file now matches server"
    );
    Ok(())
}

/// Read-only IPC used by the frontend on boot to decide whether to show
/// the "finish rotation" prompt.
#[tauri::command]
pub async fn has_pending_rotation(state: tauri::State<'_, crate::app_state::AppState>) -> Result<bool> {
    let account_id = state.current_account_id().map_err(AppError::Other)?;
    let path = rotation_sidecar_path(&account_id)?;
    Ok(path.exists())
}
```

**Step 5.2 — Emit event from `restore_session` when sidecar present**

In `src-tauri/src/auth/session_restore.rs`, inside the OAuth rehydration branch (same block where `oauth_recovery_check_needed` is emitted — see the recent changes around the `auth_type == "oauth"` block), after the recovery-state emit and before `emit_auth_ready`:

```rust
// Notify FE if a rotation is awaiting its local-rewrite step.
if let Some(ref addr) = substrate_address
    && crate::recovery::rotation_sidecar_path(addr).map(|p| p.exists()).unwrap_or(false)
{
    info!(
        account = %crate::console_access::short_ss58(addr),
        "session_restore: rotation sidecar present → emitting recovery_rotation_pending"
    );
    if let Err(e) = app.emit("recovery_rotation_pending", addr) {
        warn!(error = %e, "session_restore: failed to emit recovery_rotation_pending");
    }
}
```

Add `pub` to `rotation_sidecar_path` in `recovery.rs` so it's reachable (`pub(crate) fn rotation_sidecar_path`).

**Step 5.3 — Register both new IPCs**

In `src-tauri/src/main.rs`:
- Add `resume_recovery_password_rotation, has_pending_rotation` to the import on line 48.
- Add both to the `generate_handler!` list.

**Step 5.4 — Compile + test**

Run:
```
cd src-tauri
SQLX_OFFLINE=true cargo check -q 2>&1 | tail -5
SQLX_OFFLINE=true cargo test -p Hippius recovery -q 2>&1 | tail -10
```

Both must succeed.

**Step 5.5 — Commit**

```
git add src-tauri/src/recovery.rs src-tauri/src/auth/session_restore.rs src-tauri/src/main.rs
git commit -m "feat(recovery): resume IPC + sidecar detection on session restore"
```

---

## Task 6: Frontend — `changeRecoveryPassword` TS wrapper + types

**Files:**
- Modify: `app/lib/utils/recovery.ts`

**Step 6.1 — Read the current file shape**

Run: `head -80 app/lib/utils/recovery.ts`
You should see `sealAndUploadMnemonic(password)`. We follow the same pattern.

**Step 6.2 — Add three exports**

Append to `app/lib/utils/recovery.ts`:

```typescript
/**
 * Rotate the recovery password for the active account.
 *
 * Delegates to Rust (`change_recovery_password`) which fetches the sealed
 * blob, decrypts with `currentPassword`, re-seals under `newPassword`,
 * POSTs the upsert, and rewrites the local master_enc_mnemonic.json.
 * If the local rewrite fails after a successful upload, a sidecar is
 * written and the next launch prompts the user to finish — callers
 * here can still treat a resolved Promise as success.
 */
export async function changeRecoveryPassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("change_recovery_password", {
    current: currentPassword,
    new: newPassword,
  });
}

/** Finish a rotation whose local-rewrite step failed on a previous run. */
export async function resumeRecoveryPasswordRotation(password: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("resume_recovery_password_rotation", { password });
}

/** `true` when a rotation-pending sidecar is on disk for the active account. */
export async function hasPendingRotation(): Promise<boolean> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("has_pending_rotation");
}
```

**Step 6.3 — Lint**

Run: `pnpm lint 2>&1 | tail -5`
Expected: no warnings or errors.

**Step 6.4 — Commit**

```
git add app/lib/utils/recovery.ts
git commit -m "feat(recovery): TS wrappers for change/resume/has-pending rotation"
```

---

## Task 7: Frontend — `ChangeRecoveryPasswordDialog` component

**Files:**
- Create: `app/components/recovery/ChangeRecoveryPasswordDialog.tsx`

**Step 7.1 — Scaffold the component**

Create the file with:

```tsx
"use client";

import React, { useCallback, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";

import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton } from "@/components/ui";
import * as Typography from "@/components/ui/typography";
import {
  PassphraseStrength,
  changeRecoveryPassword,
} from "@/app/lib/utils/recovery";
import {
  PasswordField,
  StrengthMeter,
  errMessage,
  useLiveStrength,
} from "./_shared";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Rotate the recovery password protecting the sealed mnemonic blob on
 * hcfs-server. The mnemonic itself is unchanged, so no sync re-init or
 * session invalidation happens.
 *
 * All domain rules (decryption, strength, derivation guard) live in Rust.
 * This component just renders inputs and surfaces errors.
 */
const ChangeRecoveryPasswordDialog: React.FC<Props> = ({ open, onOpenChange }) => {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [strength, setStrength] = useState<PassphraseStrength | null>(null);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useLiveStrength(next, setStrength);

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setStrength(null);
    setCurrentError(null);
  };

  const mismatch = confirm.length > 0 && confirm !== next;
  const sameAsCurrent = next.length > 0 && next === current;
  const canSubmit =
    !submitting &&
    current.length > 0 &&
    next.length > 0 &&
    strength?.acceptableForSubmit === true &&
    !mismatch &&
    !sameAsCurrent &&
    next === confirm;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setCurrentError(null);
    try {
      await changeRecoveryPassword(current, next);
      toast.success("Recovery password updated.");
      reset();
      onOpenChange(false);
    } catch (err) {
      const msg = errMessage(err);
      // Rust surfaces wrong current password as Validation("Wrong passphrase.")
      if (/wrong passphrase/i.test(msg)) {
        setCurrentError("Incorrect current password.");
        setCurrent("");
      } else {
        toast.error(`Could not change recovery password: ${msg}`);
      }
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, current, next, onOpenChange]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40" />
        <DialogContainer className="z-50 w-[420px] max-w-[90vw] !left-1/2 !top-1/2 !bottom-auto !right-auto !-translate-x-1/2 !-translate-y-1/2 p-6">
          <div className="flex flex-col gap-4">
            <Typography.H4 className="text-grey-10">Change recovery password</Typography.H4>
            <Typography.P size="sm" className="text-grey-40">
              Enter your current recovery password, then choose a new one.
              <strong> Your new password cannot be reset</strong> if you forget it.
            </Typography.P>

            <PasswordField
              label="Current recovery password"
              value={current}
              onChange={(v) => {
                setCurrent(v);
                setCurrentError(null);
              }}
              errorMessage={currentError ?? undefined}
            />

            <PasswordField
              label="New recovery password"
              value={next}
              onChange={setNext}
              errorMessage={sameAsCurrent ? "New password must differ from current." : undefined}
            />
            <StrengthMeter strength={strength} />

            <PasswordField
              label="Confirm new password"
              value={confirm}
              onChange={setConfirm}
              errorMessage={mismatch ? "Passwords do not match." : undefined}
            />

            <div className="flex gap-2 justify-end">
              <CardButton variant="secondary" onClick={() => { reset(); onOpenChange(false); }}>
                Cancel
              </CardButton>
              <CardButton onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
                Change password
              </CardButton>
            </div>
          </div>
        </DialogContainer>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default ChangeRecoveryPasswordDialog;
```

**Step 7.2 — Lint**

Run: `pnpm lint 2>&1 | tail -5`
Expected: clean.

**Step 7.3 — Commit**

```
git add app/components/recovery/ChangeRecoveryPasswordDialog.tsx
git commit -m "feat(recovery): add ChangeRecoveryPasswordDialog component"
```

---

## Task 8: Frontend — wire the button into `RecoveryPhraseSettings`

**Files:**
- Modify: `app/components/page-sections/settings/RecoveryPhraseSettings.tsx`

**Step 8.1 — Import + state**

At the top of the file, after existing imports, add:

```typescript
import ChangeRecoveryPasswordDialog from "@/components/recovery/ChangeRecoveryPasswordDialog";
import { checkRecoveryState } from "@/app/lib/utils/recovery";
```

Inside the component, alongside existing `useState` calls:

```typescript
const [showChangePassword, setShowChangePassword] = useState(false);
const [hasServerBlob, setHasServerBlob] = useState(false);

React.useEffect(() => {
  let cancelled = false;
  void (async () => {
    try {
      const check = await checkRecoveryState();
      if (!cancelled) setHasServerBlob(check.hasServerBlob);
    } catch {
      // Network hiccup: hide the button rather than show a broken one.
    }
  })();
  return () => { cancelled = true; };
}, []);
```

**Step 8.2 — Render the button + dialog**

Add a secondary action inside the existing card (just below the existing primary "Reveal recovery phrase" button — keep the UI visually paired):

```tsx
{hasServerBlob && (
  <CardButton
    variant="secondary"
    onClick={() => setShowChangePassword(true)}
    className="mt-2"
  >
    Change recovery password
  </CardButton>
)}

<ChangeRecoveryPasswordDialog
  open={showChangePassword}
  onOpenChange={setShowChangePassword}
/>
```

**Step 8.3 — Lint**

Run: `pnpm lint 2>&1 | tail -5`
Expected: clean.

**Step 8.4 — Commit**

```
git add app/components/page-sections/settings/RecoveryPhraseSettings.tsx
git commit -m "feat(recovery): surface Change recovery password in settings"
```

---

## Task 9: Frontend — boot-time `FinishRotationDialog` + listener

**Files:**
- Create: `app/components/recovery/FinishRotationDialog.tsx`
- Modify: `app/components/recovery/RecoveryEventListener.tsx`

**Step 9.1 — Create the dialog**

`app/components/recovery/FinishRotationDialog.tsx`:

```tsx
"use client";

import React, { useCallback, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";

import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton } from "@/components/ui";
import * as Typography from "@/components/ui/typography";
import { resumeRecoveryPasswordRotation } from "@/app/lib/utils/recovery";
import { PasswordField, errMessage } from "./_shared";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Finish a recovery password rotation whose local-rewrite step failed
 * on the previous launch. Verifies the entered password matches the
 * server blob, then rewrites the local file and clears the sidecar.
 *
 * The user has ALREADY successfully rotated the server blob, so this
 * is strictly a "re-enter the new password you just set" prompt, not
 * a fresh-password wizard.
 */
const FinishRotationDialog: React.FC<Props> = ({ open, onOpenChange }) => {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setPassword("");
    setError(null);
  };

  const handleSubmit = useCallback(async () => {
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await resumeRecoveryPasswordRotation(password);
      toast.success("Recovery password update finished.");
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSubmitting(false);
    }
  }, [password, submitting, onOpenChange]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40" />
        <DialogContainer className="z-50 w-[420px] max-w-[90vw] !left-1/2 !top-1/2 !bottom-auto !right-auto !-translate-x-1/2 !-translate-y-1/2 p-6">
          <div className="flex flex-col gap-4">
            <Typography.H4 className="text-grey-10">Finish recovery password change</Typography.H4>
            <Typography.P size="sm" className="text-grey-40">
              Your new recovery password was saved, but this device didn&apos;t
              finish encrypting local data with it. Re-enter the new password
              to finish now.
            </Typography.P>

            <PasswordField
              label="New recovery password"
              value={password}
              onChange={setPassword}
              errorMessage={error ?? undefined}
              onSubmit={handleSubmit}
            />

            <CardButton
              onClick={handleSubmit}
              disabled={!password || submitting}
              loading={submitting}
              className="self-end"
            >
              Finish
            </CardButton>
          </div>
        </DialogContainer>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default FinishRotationDialog;
```

**Step 9.2 — Wire the listener**

Read `RecoveryEventListener.tsx` first so you don't overwrite existing listeners:

```
head -60 app/components/recovery/RecoveryEventListener.tsx
```

Add state + a `listen("recovery_rotation_pending", ...)` handler similar to the existing `oauth_recovery_check_needed` listener. Set local state to show `FinishRotationDialog`:

```tsx
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import FinishRotationDialog from "./FinishRotationDialog";
import { hasPendingRotation } from "@/app/lib/utils/recovery";

// ... existing listener code ...

const [finishRotationOpen, setFinishRotationOpen] = useState(false);

useEffect(() => {
  // Belt-and-braces: check on mount too, in case the event fired before
  // the listener was attached.
  void hasPendingRotation().then((pending) => {
    if (pending) setFinishRotationOpen(true);
  });

  const unlistenPromise = listen<string>("recovery_rotation_pending", () => {
    setFinishRotationOpen(true);
  });
  return () => {
    void unlistenPromise.then((fn) => fn());
  };
}, []);

return (
  <>
    {/* existing return content */}
    <FinishRotationDialog open={finishRotationOpen} onOpenChange={setFinishRotationOpen} />
  </>
);
```

Adapt to the actual structure of `RecoveryEventListener` — the snippets above describe the additions, not a full replacement.

**Step 9.3 — Lint + commit**

```
pnpm lint 2>&1 | tail -5
git add app/components/recovery/FinishRotationDialog.tsx app/components/recovery/RecoveryEventListener.tsx
git commit -m "feat(recovery): boot-time FinishRotationDialog for sidecar retry"
```

---

## Task 10: Final checks + design-doc backlink

**Files:**
- Modify: `docs/plans/2026-04-15-change-recovery-password-design.md` (tick the implementation status)

**Step 10.1 — Full Rust test suite**

Run:
```
cd src-tauri && SQLX_OFFLINE=true cargo test -p Hippius -q 2>&1 | tail -20
```
Expected: all tests pass.

**Step 10.2 — Clippy**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo clippy --all-targets --all-features -- -D warnings 2>&1 | tail -20`
Expected: no warnings.

**Step 10.3 — Frontend lint**

Run: `pnpm lint 2>&1 | tail -5`
Expected: clean.

**Step 10.4 — Update design doc status**

Flip the `Status:` line at the top of `docs/plans/2026-04-15-change-recovery-password-design.md` from `Approved, ready for implementation plan` to `Implemented in feature/change-recovery-password`.

**Step 10.5 — Commit**

```
git add docs/plans/2026-04-15-change-recovery-password-design.md
git commit -m "docs(recovery): mark change-recovery-password design implemented"
```

**Step 10.6 — Manual QA checklist**

Run the app once via `pnpm tauri:static -- --release` (or the debug-capable variant with `HIPPIUS_DEVTOOLS=1`) and:

1. **Happy path.** Settings → Change recovery password → enter correct current + strong new + matching confirm → expect success toast. Log out, log in again, enter new password when prompted on fresh device (or simulate via the dev OAuth injector panel).
2. **Wrong current.** Type a wrong current password → expect inline error on that field; network tab shows a GET but no POST.
3. **Weak new.** Type a too-short new → expect inline error under the strength meter; no network call.
4. **Same new.** Type `new == current` → expect inline error; no network call.
5. **Mid-rotation crash.** After the success toast, confirm `~/.hippius/drives/<hash>/recovery_pending_local_rewrite.json` is absent. To synthesize the sidecar path, you can temporarily mock `install_recovered_mnemonic` to fail in a branch for QA only — skip if you don't want to modify code for this check.
6. **Relogin verification.** Log out. Delete `master_enc_mnemonic.json` manually. Log back in, enter the new password when the unlock branch fires → expect account unlocks and file is re-created.

Report any deviations in the PR description.

---

## Task 11: PR prep

**Step 11.1 — Push branch**

```
git push origin feature/change-recovery-password
```

**Step 11.2 — Open PR against `sync-engine`**

```
gh pr create --base sync-engine \
  --title "feat(recovery): change recovery password" \
  --body "$(cat <<'EOF'
## Summary
- Adds `change_recovery_password` IPC that rotates the password protecting the sealed mnemonic blob on hcfs-server.
- Adds Settings → Change recovery password button and dialog; only shown when the account already has a server blob.
- Adds sidecar-based boot-time retry so a failed local rewrite after a successful server upload is recoverable on next launch.
- No hcfs-server changes — existing `POST /v1/mnemonic-blob` is already an upsert.

Design: `docs/plans/2026-04-15-change-recovery-password-design.md`

## Test plan
- [ ] Rust unit tests pass
- [ ] `cargo clippy -- -D warnings` clean
- [ ] `pnpm lint` clean
- [ ] Manual QA checklist from implementation plan (happy path, wrong current, weak new, same new, sidecar retry, local-file-deleted relogin)
EOF
)"
```

**Step 11.3 — Post-merge cleanup**

After merge, from the main repo (not the worktree):
```
cd /Users/georgiosdelkos/Documents/GitHub/Bitensor/hippius-desktop
git worktree remove .worktrees/change-recovery-password
```

---

## Done criteria

- [ ] `change_recovery_password`, `resume_recovery_password_rotation`, `has_pending_rotation` IPCs implemented and tested.
- [ ] Sidecar written/cleared correctly; boot-time emit wired into `restore_session`.
- [ ] Settings → Change recovery password flow end-to-end works on a dev build.
- [ ] Partial-failure sidecar → boot-time Finish dialog completes the rotation.
- [ ] All Rust + frontend lints clean.
- [ ] PR open against `sync-engine` with manual QA checklist filled out.
