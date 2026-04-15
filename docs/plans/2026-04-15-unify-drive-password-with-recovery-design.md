# Unify `drive_password` with the recovery password — Design

Date: 2026-04-15
Status: Implemented in `feature/unify-drive-password`
Owner: Desktop
Scope: Desktop-only (`hippius-desktop`). No hcfs-server changes.

## 1. Goal

Make the user's recovery password the **single** password that wraps every
piece of local key material. One password the user types; one password
that secures everything on disk.

Before this change, two passwords existed side-by-side:

| Name | User-visible? | Encrypts |
|---|---|---|
| Recovery password | Yes — user chooses it | Sealed blob on server, local `master_enc_mnemonic.json` |
| Drive password | No — stored in `hcfs_config.drive_password` | Per-folder `enc_mnemonic.json` files |

The frontend may or may not have reused the same string for both prompts.
Unifying in the backend removes that ambiguity and makes cross-device
password changes predictable without a separate migration step.

### What this does NOT change

- The underlying mnemonic is invariant across rotations.
- Folder mnemonics are still deterministically derivable from the master
  via `hcfs_client::drive::keys::derive_folder_mnemonic(master, label)`.
- Server-side behaviour (sealed blob upsert) is unchanged.

## 2. hcfs-server changes

**None.** Everything stays in desktop.

## 3. Architecture

One private helper in `src-tauri/src/recovery.rs`:

```rust
async fn align_drive_password(
    pool: &SqlitePool,
    account_id: &str,
    server_url: &str,
    master: &str,
    new_password: &str,
) -> Result<()> {
    save_hcfs_config_internal(pool, account_id, server_url, new_password, Some(master)).await?;
    reencrypt_all_folder_mnemonics(pool, account_id, master, new_password).await?;
    Ok(())
}
```

It overwrites the `hcfs_config.drive_password` row (encrypted with a
mnemonic-derived HKDF key) and rewrites every folder's
`enc_mnemonic.json` under the new password. The second step is a no-op
when there are no folders yet.

The helper is called from every flow that settles "the user's canonical
password is this now":

| Flow | Call site in `recovery.rs` | When it runs |
|---|---|---|
| Fresh signup | `seal_and_upload_mnemonic` after successful POST + local install | User completes the signup wizard |
| Fresh-device unlock | `recover_mnemonic` after successful decrypt + local install | User types their recovery password on a new device |
| Rotation (Ok branch) | `change_recovery_password` after successful POST + local rewrite | User completes the change-password dialog |
| Boot-time sidecar retry | `resume_recovery_password_rotation` after successful install | A previous rotation left the local file half-updated |

After any of these succeeds, the DB row + every on-disk folder file are
aligned with the user's current recovery password.

## 4. What we deliberately did NOT build

An earlier iteration of this design proposed:

- A boot-time **migration state machine** (9-cell truth table).
- A **gathered inputs struct** + pure decision function.
- A **one-time migration flag** in `user_preferences`.
- An **auto-heal toast** on detected conflict.

All of it was scaffolding around the same conclusion: "align the drive
password with whatever password the user just typed." The natural flows
above already reach every device state we care about without a separate
migration pass, so that code was reverted in commit `a956a0b3`.

The commits that built it (`48ca9b0e`, `f4e61274`) are preserved in the
branch history for anyone curious about the path not taken.

## 5. Backwards compatibility

Existing users fall into these states at upgrade time:

| State | What they have | What happens |
|---|---|---|
| A — Fresh install | Nothing | Normal signup writes aligned state. |
| B — Sync set up pre-PR #305 | `drive_password` row, no server blob | Signup wizard fires on next OAuth login. Its POST + install now also runs `align_drive_password`, which overwrites the existing `drive_password` row and rewrites folder files under the typed password. If FE passes the same string the user had been using, it's a no-op rewrite. If different, folder files switch to the new password (all already present in this device's memory via the mnemonic, so no data loss). |
| C — Sync + recovery, aligned | Both rows under same password | No-op rewrite on next rotation/unlock. |
| C — Sync + recovery, conflicted | Drive password X, server blob sealed under Y, X ≠ Y | Silent until they naturally hit a flow. On fresh-device unlock they type Y → Y becomes the drive password there. On rotation they type X as current → new password unifies everything. If they never do either, nothing changes. |
| D — OAuth with blob, no sync yet | Server blob only | Fresh-device unlock writes the drive password row. |
| E — OAuth with blob + sync aligned | Everything aligned | No-op. |

No boot-time migration; no flag; no toast. The worst-case user is in
state C-conflicted and uses device B with evicted keychain — they'd type
what they remember (likely the drive password, since that's what they
type at every sync start) and the server blob decrypt would fail. They
re-type the other password and it works. Recoverable through trial.

If support data later shows users getting stuck, we can layer an
opportunistic boot-time re-seal (the "AutoSealAndUpload" action from the
reverted state machine) on top of this design — the decision is pure
and the logic is already proven. But it's unnecessary for v1.

## 6. Security considerations

- **Password entropy drop.** The old drive password was derived from
  the mnemonic (~256 bits). The new drive password is user-chosen with
  ≥50 bits enforced by `score_passphrase`. Argon2id in
  `save_encrypted_mnemonic` slows offline guessing.
- **Single-point-of-failure.** Forgetting the recovery password already
  meant losing server-side recoverability. Now it also means losing
  access to local folder keys. Folder mnemonics are deterministic from
  the master, so a user who remembers the master mnemonic can still
  recover by hand.
- **No new server attack surface.** The server never sees either
  password; all encryption happens locally.

## 7. Testing

Rust unit + integration tests in `recovery.rs` and `sync/mnemonic.rs`:

- `reencrypt_all_folder_mnemonics` — overwrite existing file, create
  missing file, skip `migration` label, idempotent second call, zero
  folders returns Ok, invalid master warn-skips all.
- `align_drive_password` — writes `hcfs_config` row and re-encrypts
  folder files under the new password; recovered password round-trips
  through the mnemonic-derived HKDF key.

Tests that override `$HOME` use the shared `test_helpers::HOME_LOCK`
mutex to serialise, because `cargo test` runs tests in parallel threads
within one process.

Manual QA to run on a real build:

1. Existing user in state C-conflicted: rotate their password, relogin,
   confirm sync works on both devices.
2. Fresh-device unlock: recover with the recovery password, confirm
   subsequent sync setup doesn't prompt for a separate password.
3. Delete `master_enc_mnemonic.json` between sessions, unlock, confirm
   local state rebuilds.

## 8. Rollout

No migration step required. Ship on top of `sync-engine` (merged PR #307).
No feature flag; no deployment requirements beyond what's already
needed for `HCFS_FEATURE_CONSOLE_BLOB=1` on hcfs-server.

## 9. Out of scope

- Removing `hcfs_config.drive_password` entirely. The DB row still
  exists; it just now mirrors the recovery password.
- Changing where folder mnemonics live on disk.
- Any server-side change.
