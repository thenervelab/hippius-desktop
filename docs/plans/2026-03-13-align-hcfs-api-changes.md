# Align hippius-desktop with hcfs API Changes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update hippius-desktop to compile and work correctly against hcfs commit `e40c304` (up from pinned `212e5e9`).

**Architecture:** The hcfs libraries made three categories of breaking changes: (1) renamed `arion_cid` → `arion_hash` across shared types, (2) removed `file_id`/`version` fields from `Manifest` and `UploadResult`, (3) switched SHA256 → BLAKE3 internally. hippius-desktop consumes these types via `hcfs-client` and `hcfs-shared` crates. All changes are mechanical renames and field removals — no logic changes needed.

**Tech Stack:** Rust (Tauri backend), TypeScript (Next.js frontend), hcfs-client/hcfs-shared crates

---

## Breaking Changes Summary

| Change | hcfs type affected | hippius-desktop files affected |
|--------|-------------------|-------------------------------|
| `remote_arion_cids` → `remote_arion_hashes` | `SyncState` | `src-tauri/src/commands/file_commands.rs:178` |
| `arion_cid` → `arion_hash` | `RemoteFileEntry` | `src-tauri/src/commands/file_commands.rs` (struct + logic) |
| `file_id` removed from `Manifest` | `hcfs_shared::network::Manifest` | No direct usage (hcfs-client builds manifests internally) |
| `file_id` removed from `UploadResult` | `hcfs_shared::network::UploadResult` | No direct usage (hippius-desktop doesn't read `UploadResult`) |
| `version` removed from `Manifest` | `hcfs_shared::network::Manifest` | No direct usage |
| SHA256 → BLAKE3 (internal hcfs hashing) | `FileMetadata`, `FileId` computation | Comment in `file_commands.rs:240` is stale |

**NOT breaking** (desktop-local SHA256 that must stay as-is):
- `syncing.rs:205` — `folder_hash()` for local directory naming
- `syncing.rs:238` — `derive_folder_mnemonic()` for key derivation
- `auth.rs:297` — Password hashing
- `utils/account_key.rs:5` — Account directory naming

These are desktop-specific conventions unrelated to hcfs-client's internal hashing.

---

### Task 1: Update hcfs dependency pins in Cargo.toml

**Files:**
- Modify: `src-tauri/Cargo.toml:80-81`

**Step 1: Update both pins**

Change:
```toml
hcfs-client = { git = "ssh://git@github.com/thenervelab/hcfs.git", rev = "212e5e9262a46fd403bf8c2d93ea140186a2a722" }
hcfs-shared = { git = "ssh://git@github.com/thenervelab/hcfs.git", rev = "212e5e9262a46fd403bf8c2d93ea140186a2a722" }
```

To:
```toml
hcfs-client = { git = "ssh://git@github.com/thenervelab/hcfs.git", rev = "e40c304de6423cb6da21c67015b588c5ca960783" }
hcfs-shared = { git = "ssh://git@github.com/thenervelab/hcfs.git", rev = "e40c304de6423cb6da21c67015b588c5ca960783" }
```

**Step 2: Update Cargo.lock**

Run: `cd src-tauri && cargo update -p hcfs-client -p hcfs-shared`

---

### Task 2: Rename `arion_cid` → `arion_hash` in file_commands.rs (Rust)

**Files:**
- Modify: `src-tauri/src/commands/file_commands.rs`

**Step 1: Update `FileEntry` struct** (line 29)

The struct already has `arion_hash` (line 27) for the path hash. The `arion_cid` field (line 29) holds the Arion storage CID. Since hcfs renamed `arion_cid` → `arion_hash`, rename this field to `arion_storage_hash` to avoid collision with the existing `arion_hash` field, OR consolidate both into one field if they serve the same purpose.

**Decision:** The `arion_hash` field (line 27) stores `hex::encode(path_hash)` and `arion_cid` (line 29) stores the Arion storage hash. These are different values. Rename `arion_cid` → `arion_storage_hash` to match the upstream rename while keeping them distinct.

Actually, looking more carefully: the frontend uses both `arion_hash` and `arion_cid` as separate fields. The simplest rename is `arion_cid` → `arion_storage_hash` on the Rust struct, BUT this is a frontend-facing API change. Alternatively, keep the field name `arion_cid` on the `FileEntry` struct (it's our own type) and just fix the internal access from `remote_arion_cids` → `remote_arion_hashes`.

**Recommended approach:** Keep `FileEntry.arion_cid` field name as-is (it's our own serialized type, not from hcfs). Only fix the internal access to the renamed `SyncState` field.

Changes in `file_commands.rs`:

1. Line 178: `state.remote_arion_cids` → `state.remote_arion_hashes`
2. Line 240: Comment "SHA256 is computed" → "BLAKE3 is computed"

No struct field renames needed on `FileEntry` or `SyncedFileInfo` — these are our own types sent to the frontend.

**Step 2: Verify compilation**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo check 2>&1 | head -50`
Expected: No errors related to `arion_cid` or `remote_arion_cids`

**Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands/file_commands.rs
git commit -m "Update hcfs deps to e40c304, fix arion_cid → arion_hash rename"
```

---

### Task 3: Fix any remaining compilation errors

**Step 1: Full cargo check**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo check 2>&1`

The `Manifest` and `UploadResult` field removals (`file_id`, `version`) should NOT affect hippius-desktop because:
- hippius-desktop never constructs `Manifest` directly (hcfs-client does internally)
- hippius-desktop never reads `UploadResult.file_id` (sync outcomes come via `SyncOutcome`)

If there ARE compilation errors, they'll be from:
- Any direct `Manifest` construction (unlikely)
- Any `UploadResult.file_id` access (unlikely)
- Any other renamed fields we missed

**Step 2: Fix any errors found and commit**

---

### Task 4: Run clippy and tests

**Step 1: Clippy**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo clippy --all -- -D warnings 2>&1 | tail -30`

**Step 2: Rust tests**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo test 2>&1 | tail -30`

**Step 3: Frontend lint**

Run: `pnpm lint`

(Frontend TypeScript code references `arion_cid` from the Rust IPC response — since we're keeping the `FileEntry.arion_cid` field name unchanged on our struct, no frontend changes needed.)

**Step 4: Commit any fixes**

---

## Existing Sync State Migration Note

Users who upgrade will have `sync_state.json` files on disk containing the old field name `remote_arion_cids`. Since hcfs-client deserializes this with `#[serde(default)]`, the field will simply start empty after upgrade and repopulate on the next sync cycle. **No migration code needed** — the arion hashes are transient cache data fetched from the server each sync.

---

## Risk Assessment

- **Low risk:** All changes are mechanical field renames. No logic changes.
- **No data loss:** `remote_arion_hashes` repopulates from server on next sync.
- **No frontend changes:** We keep our own `FileEntry` struct field names stable.
- **SHA256 on desktop stays:** Desktop-local hashing (folder names, key derivation) is independent of hcfs-client's internal hashing switch to BLAKE3.
