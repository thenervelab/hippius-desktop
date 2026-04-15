# Unify `drive_password` with the recovery password — Design

Date: 2026-04-15
Status: Proposed, follow-up to PR #307
Owner: Desktop
Scope: Desktop-only (`hippius-desktop`). No hcfs-server changes.

## 1. Goal

Make the user's recovery password the **single** password that wraps every
piece of local key material. One password the user types; one password that
secures everything on disk. Today two passwords exist side-by-side:

| Name | User-visible? | Encrypts |
|---|---|---|
| Recovery password | Yes — user chooses it | Sealed blob on server, local `master_enc_mnemonic.json` |
| Drive password | No — stored in `hcfs_config.drive_password` | Per-folder `enc_mnemonic.json` files |

Unifying them removes the hidden second password and makes cross-device
password changes predictable.

### What this does NOT change

- The underlying mnemonic is still invariant across rotations.
- Folder mnemonics are still deterministically derivable from the master
  via `derive_folder_mnemonic(master, label)`.
- Server-side behaviour (sealed blob upsert) is unchanged.

## 2. hcfs-server changes

**None.** Everything stays in desktop.

## 3. Affected flows

Every place that reads or writes `hcfs_config.drive_password` needs updating:

### 3.1 Signup (`seal_and_upload_mnemonic`)

After a successful server POST and local `master_enc_mnemonic.json` install,
also write the recovery password into `hcfs_config.drive_password` for the
active account. Any freshly-created folder `enc_mnemonic.json` files created
after this point are encrypted with the recovery password.

### 3.2 Unlock on fresh device (`recover_mnemonic`)

After installing the recovered mnemonic locally, write the recovery password
into `hcfs_config.drive_password`. **Any pre-existing** `enc_mnemonic.json`
files on this device (e.g. left behind from a prior install) must be
re-encrypted under the new drive password. This is safe because folder
mnemonics are deterministic:

```
for each folder in sync_paths:
    new_folder_mnemonic = derive_folder_mnemonic(master, label)
    save_encrypted_mnemonic(folder_enc_path, new_folder_mnemonic, recovery_password)
```

### 3.3 Rotation (`change_recovery_password`)

After the existing POST + master-file rewrite:

1. Update `hcfs_config.drive_password` to the new recovery password.
2. For each folder in `sync_paths`:
   - Re-derive folder mnemonic from master + label.
   - Save to its `enc_mnemonic.json` under the new drive password.

Folder-mnemonic re-encrypts are per-folder atomic but the overall
"rewrite everything" step is not atomic across folders. The sidecar
must represent "rotation is mid-way through local re-encrypt" (see §4).

### 3.4 Sidecar retry (`resume_recovery_password_rotation`)

Same extra steps as rotation. The sidecar-retry flow is the only place
that might see a partially re-encrypted set of folders, so idempotency
matters: every folder must be re-derived from scratch and overwritten
whether or not it was already updated. Sidecar is cleared only after the
DB row update + all folder writes succeed.

### 3.5 Existing-user migration on first launch after upgrade

This is the trickiest piece. Existing users have:
- `hcfs_config.drive_password` = some value derived from the mnemonic,
  not equal to their recovery password.
- `enc_mnemonic.json` files encrypted under that value.
- A valid recovery password they set under the old scheme.

Migration strategy — **on first launch after upgrade, do nothing until
the next natural recovery-password entry** (either a rotation, an unlock
flow, or a prompt). Then:

1. Decrypt existing folder mnemonics using the **current** `drive_password`.
2. Verify the recovered mnemonic matches what the user just entered
   (via server blob decryption).
3. Overwrite `hcfs_config.drive_password` with the recovery password.
4. Re-encrypt all folder mnemonics under the recovery password.

If the user never hits a recovery-password entry flow (because the
keychain still holds the mnemonic), **no migration is needed** — the
mnemonic itself is unchanged; the legacy drive password keeps working
until the keychain is evicted. This lets us roll out the change
gradually without forcing every user through a migration on day one.

## 4. Partial-failure handling

The rotation sidecar gains state. Current schema:
```json
{"ss58": "...", "created_at_ms": 123456}
```

Proposed schema:
```json
{
  "ss58": "...",
  "created_at_ms": 123456,
  "step": "master_write" | "drive_password_update" | "folder_reencrypt" | "done",
  "completed_folders": ["label1", "label2"]
}
```

`resume_recovery_password_rotation` reads the sidecar, skips steps that
already completed, and re-runs the rest. On each success, the sidecar
is rewritten; on the final success, deleted.

Alternative (simpler): treat the sidecar as a single boolean "finish
the whole thing idempotently on resume" — always re-derive + overwrite
every folder. Idempotent because folder mnemonic derivation is
deterministic and `save_encrypted_mnemonic` truncates on write.

**Recommendation:** start with the simpler alternative. Add step
granularity only if real-world traces show we're repeatedly re-doing
expensive work.

## 5. Security considerations

- **Weaker entropy for drive password?** The old drive password was
  derived from the mnemonic — effectively very high entropy. The new
  drive password is whatever the user types. Minimum-entropy is already
  enforced at the recovery-password level (`score_passphrase` requires
  ≥50 bits), so this is acceptable but the bar drops from
  mnemonic-derived (~256 bits) to user-chosen (~50 bits). Argon2id
  slow-hashing in `save_encrypted_mnemonic` mitigates offline guessing.
- **Single-point-of-failure.** One forgotten password locks the user
  out of every piece of encrypted data. This was already true for the
  sealed server blob; this change extends it to local folder state.
  Given the blob is unrecoverable by design and folder mnemonics are
  re-derivable from the master mnemonic, a user who remembers either
  the mnemonic or the recovery password can still recover.
- **No new attack surface on the server side.** The server never sees
  either password; all encryption happens locally.

## 6. Testing

### Rust

1. **Signup writes drive password.** After `seal_and_upload_mnemonic(pw)`,
   `get_drive_password(account_id)` returns `pw`.
2. **Recover writes drive password + re-encrypts existing folders.** Seed
   an account with an old-scheme folder `enc_mnemonic.json` encrypted under
   a legacy drive password. Run `recover_mnemonic(new_pw)`. Assert
   `drive_password == new_pw` and the folder mnemonic can be decrypted
   with `new_pw` and equals `derive_folder_mnemonic(master, label)`.
3. **Rotation re-encrypts all folders.** Seed two folders under old_pw;
   rotate to new_pw. Assert both folder files decrypt under new_pw and
   derive correctly.
4. **Mid-rotation partial failure → idempotent resume.** Simulate a
   folder-write failure after the first folder succeeded. Sidecar
   written. Call `resume_recovery_password_rotation(new_pw)` → all
   folders end up re-encrypted.
5. **Legacy-user migration.** Seed an account in the pre-unification
   state. Run `change_recovery_password(current, new)` — assert the
   DB row and all folder files end up under `new`.

### Manual QA

- Sign up fresh, rotate, re-install on another device with new password,
  confirm sync works.
- Sign up fresh, rotate, wipe local app data, unlock with new password,
  confirm all existing folders still decrypt.
- Upgrade from current build (pre-unification) to the new build,
  rotate, confirm folder mnemonics migrate correctly on first rotation.

## 7. Rollout

- Ship PR #307 first (rotation with separate drive password). This
  design builds on top of that.
- Cut this as a separate PR against the post-PR-307 branch.
- No feature flag needed — migration is implicit on next recovery-
  password touch, which is naturally gated by user action.

## 8. Out of scope

- Removing `hcfs_config.drive_password` entirely. Even after
  unification, storing the password in DB keeps the existing read path
  simple — sync init can continue to query `get_drive_password` without
  round-tripping through the recovery dialog.
- Changing where folder mnemonics live on disk.
- Any change to the server blob schema.

## 9. Open questions

- Should `change_recovery_password` ever *delete* and re-create folder
  `enc_mnemonic.json` files, or always overwrite in place? Overwrite
  is safer (no window where the file doesn't exist).
- Should the migration path surface a progress UI ("re-encrypting 5
  folders...") or silently do it? With typical ≤5 folders, silent is
  fine; if users have >20 folders we may want a toast.
- Future: could we drop `hcfs_config.drive_password` altogether by
  caching the user-entered recovery password in `AuthInfo` for the
  session and passing it down to sync code? Deferred — would require
  a bigger refactor of sync init.
