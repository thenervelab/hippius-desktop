# Restore unlock password from mnemonic — Design

Date: 2026-08-26
Status: Implemented
Owner: Desktop
Scope: Desktop-only (`hippius-desktop-internal`). No hcfs-server changes.
Related: `2026-04-15-change-recovery-password-design.md` (YAGNI forgot-password), `2026-04-14-oauth-account-recovery.md`

## Problem

A user who still has their master mnemonic but forgot the unlock password was told their files were gone. That copy was false: files are encrypted with keys derived from the mnemonic (`derive_folder_mnemonic` → `derive_encryption_key`), not the password. The password only wraps the mnemonic (Argon2id + XChaCha20-Poly1305). The April 15 change-password design marked a forgot-password path as YAGNI; that was a scope cut, not a crypto limit.

There is no safe "reset the account" product: minting a new master is new keys. `/v1/mnemonic-blob` is an upsert, so sealing a *wrong* phrase would overwrite the real backup.

## Flows

**A. Unlock dialog (lockout).** Signed-in, `recommendedFlow=unlock`, forgot password, still has the seed. "Use your mnemonic seed" → phrase + new password → `restore_with_mnemonic`. OAuth users are never sent to `/login` with the seed (that authenticates as `derive(mnemonic)`, a different empty namespace). Mnemonic-login users keep "Sign in with your recovery phrase instead" as a lighter path.

**B. Settings, already unlocked on this device.** Change Unlock Password → "Forgot current password?" → `reset_unlock_password` (session already holds the master). If this device cannot open the mnemonic, the dialog switches to the same phrase form as A.

**C. Out of scope.** Lost OAuth *and* lost password *and* have seed → existing `list_recoverable_accounts` / `recover_account_files`. Console unlock-with-seed. docs.hippius.com copy.

## Proof (fail closed)

`recovery_proof.rs::decide_master_proof` combines probes. Reseal only on `Confirmed`. Order: mnemonic identity (`derive_verified_keys`) → drive-password row → local folder seals → recovery binding → remote decrypt. OAuth identity *mismatch* is not a phrase mismatch (custodial login SS58 ≠ sync mnemonic). Empty account with nothing to check is `Unproven` — no POST, no "overwrite anyway" confirm in v1.

Live recovery-binding is **not** probed: `challenge_response` as a typed (possibly wrong) BIP-39 would mint a phantom server account (audit H-3). Binding stays in the pure table; the gatherer leaves it `Absent`. Owner-side list of bound `recovery_ss58` would be the safe follow-up.

`restore_with_mnemonic` / `reset_unlock_password` never call `seal_and_upload_mnemonic` (that path mints on a miss). Shared commit is `commit_new_unlock_password` (also used by rotation after it opened the blob with the current password).

## Copy

Files are encrypted with the mnemonic seed. The unlock password unwraps a sealed copy of that seed. We never see the password, so we cannot reset it. If the user has the seed, they can restore and set a new password.

## Tests

Pure combiner: `recovery_proof.rs`. Source pins: restore commands acquire `recovery_lock`, never mint, prove-before-POST. FE: `AccountRecoveryDialog.unlock.test.tsx` (OAuth in-dialog restore, no login escape; mismatch stays on the dialog).
