# Hippius Desktop — File Sharing

**Date:** 2026-04-28
**Repo scope:** `hippius-desktop` (Tauri backend + Next.js frontend)
**Sibling plans:**
- `hcfs/docs/plans/2026-04-28-file-sharing-design.md` (server + shared crate)
- `hippius-console/docs/plans/2026-04-28-file-sharing-design.md` (web sender + recipient page)

This is one of three parallel plans for the same feature. This document covers everything that lives in the `hippius-desktop` repo: Tauri commands, the share keystore, the file-browser UI, and the "My Shares" page. The `hcfs` plan must ship its `hcfs-client::share` module before this can finish, but UI and Tauri scaffolding can be built against a stub in parallel.

---

## Goal

Right-click a synced file → "Share via link" → toast with a copyable URL that anyone can open in a browser to download the file. Server never sees plaintext. No re-typing, no account exchange.

## Non-goals (v1)

- Receiving shares in the desktop app (the recipient page lives in console)
- Folder shares
- Drag-to-share onto the dock icon (defer)
- Auto-revoke on file delete

---

## Shared wire contract

Identical to the contract in `hcfs/docs/plans/2026-04-28-file-sharing-design.md` § "Shared wire contract". Reproduced here so this plan stands alone.

```
URL: https://console.hippius.io/share/<share_token>#k=<base64url(share_key)>

POST   /v1/shares                      (multipart, ≤ 8 MiB single-shot)
POST   /v1/shares/init                 (chunked init, > 8 MiB)
PUT    /v1/shares/<token>/chunks/<n>
POST   /v1/shares/<token>/complete
GET    /v1/shares                      (list mine)
DELETE /v1/shares/<token>              (revoke)

All authenticated with existing Ed25519 X-Signature middleware.
```

Crypto: per-share random 32-byte XChaCha20-Poly1305 key. Filename AEAD-encrypted with the same key. URL fragment never sent to server.

---

## Tauri commands

New file `src-tauri/src/commands/shares.rs`, wired into the existing command registry.

```rust
// src-tauri/src/commands/shares.rs

#[derive(Serialize)]
pub struct ShareLink {
    pub share_token: String,
    pub share_url:   String,
    pub expires_at:  String,        // RFC 3339
}

#[derive(Serialize)]
pub struct ShareSummary {
    pub share_token:    String,
    pub filename:       String,
    pub plaintext_size: u64,
    pub mime_type:      String,
    pub created_at:     String,
    pub expires_at:     String,
    pub revoked_at:     Option<String>,
}

#[tauri::command]
pub async fn hcfs_create_share(
    state: tauri::State<'_, AppState>,
    folder_label: String,
    relative_path: String,
    on_progress: tauri::ipc::Channel<ShareProgress>,
) -> Result<ShareLink, String>;

#[tauri::command]
pub async fn hcfs_list_shares(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ShareSummary>, String>;

#[tauri::command]
pub async fn hcfs_revoke_share(
    state: tauri::State<'_, AppState>,
    share_token: String,
) -> Result<(), String>;

#[derive(Serialize, Clone)]
pub struct ShareProgress {
    pub bytes_done:  u64,
    pub bytes_total: u64,
    pub phase:       &'static str, // "encrypting" | "uploading" | "finalizing"
}
```

`hcfs_create_share` flow:

```
1. Resolve full local path from (folder_label, relative_path) via existing
   FolderRegistry. Reject if file is not in a synced folder.
2. Open the local plaintext file (tokio::fs::File). It is unencrypted on disk
   in synced folders, so no folder-key decryption is needed.
3. Stat plaintext_size. Sniff mime_type via `mime_guess` from the extension;
   fall back to "application/octet-stream".
4. Call hcfs_client::share::create_share(...), passing:
     - the file as AsyncRead
     - filename = basename of relative_path
     - the SqliteShareKeystore
     - a progress closure that forwards into the IPC Channel
5. Return ShareLink to the frontend.
```

`hcfs_list_shares` and `hcfs_revoke_share` are thin wrappers over the same `hcfs-client::share` functions.

---

## Share keystore

Persistent storage for `share_token → share_key`. Reuses the existing SQLx + encrypted-database pattern from `hippius-desktop` (the same DB that holds folder metadata).

### Schema

New SQLx migration `src-tauri/migrations/<next>_share_keystore.sql`:

```sql
CREATE TABLE IF NOT EXISTS share_keystore (
    share_token  TEXT PRIMARY KEY,
    share_key    BLOB NOT NULL CHECK (length(share_key) = 32),
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
```

The DB itself is already encrypted (SQLCipher or similar — match what desktop already uses). The plaintext key bytes inside the encrypted DB are acceptable; if there's a stronger pattern in the desktop already (e.g. sealing with a per-app keypair), use it.

### Implementation

```rust
// src-tauri/src/shares/keystore.rs

pub struct SqliteShareKeystore { pool: SqlitePool }

impl hcfs_client::share::ShareKeystore for SqliteShareKeystore {
    fn put(&self, token: &str, share_key: &[u8; 32]) -> Result<(), ShareError> { ... }
    fn get(&self, token: &str) -> Result<Option<[u8; 32]>, ShareError> { ... }
    fn forget(&self, token: &str) -> Result<(), ShareError> { ... }
}
```

The trait in `hcfs-client::share` is sync; if the existing DB calls in desktop are async, wrap with `tokio::task::block_in_place` plus `Handle::current().block_on(...)`, **or** lift the trait to async in the shared crate (coordinate with the hcfs plan if you take that route — it's a cheap change to make there).

---

## Frontend integration (Next.js)

### File browser context menu

Locate the existing file-row component in the synced-folder browser (likely `src/components/FileRow.tsx` or similar — search for the existing right-click menu). Add an item:

```
Share via link        ⇧⌘S
```

Hidden when:
- File is a directory
- Sync state is not `synced` (don't share files mid-upload)
- Capability check `shares: true` is missing on the connected server

### Share modal

New component `src/components/ShareFileModal.tsx`:

```
States:
  encrypting:   linear progress, "Encrypting <filename>"
  uploading:    linear progress, "Uploading <filename>"
  finalizing:   spinner, "Finishing up"
  done:         filename, expires-at countdown, big "Copy link" button
                + small "Open in browser" button
                + small "Revoke" button (calls hcfs_revoke_share, closes modal)
  error:        error string, "Try again" button

The IPC Channel pushes ShareProgress events; the component renders accordingly.
```

The "done" state shows the URL in a read-only textarea so the user can verify and copy. Auto-copy to clipboard on first render of the done state, but still show the URL — auto-copy alone has been a UX trap historically (focus loss, etc.).

### "My Shares" page

New route `src/app/shares/page.tsx`:

```
Header:        "My Shares"
Empty state:   "You haven't shared any files yet."
List item:     filename · size · created/expires relative time · [Copy link] [Revoke]
Auto-refresh:  every 30 s while page is open.
```

Filename comes back already decrypted from the Tauri command (the keystore + `hcfs-client::share::list_shares` resolves it).

If a row's `expires_at` is in the past, show "Expired" badge — the server will reap it shortly, but the client showing it as expired immediately gives correct UX without waiting.

---

## Capability gating

On app start (and on reconnect), call `GET /v1/capabilities`. Cache `{ shares: bool }` on the JS side. UI hides share buttons when `shares !== true`. This avoids breaking against an old server.

---

## Tests

### Rust integration (`src-tauri/tests/share_roundtrip.rs`)

Use the existing test harness pattern (`hippius_policy_harness.rs`-style):

1. **Happy path:** spin up a fake hcfs-server (or hit a real local one), create a share for a 50 MiB file via the Tauri command function (call it directly, not via IPC), verify the URL is valid, fetch via plain `reqwest` as anonymous client, decrypt with the share_key extracted from the URL fragment, assert plaintext bytes match.
2. **Revoke:** create → revoke → anonymous fetch returns 404, `hcfs_list_shares` no longer includes the row.
3. **Keystore loss:** create → wipe `share_keystore` table → `hcfs_list_shares` returns rows with `filename = "<unknown>"`, anonymous fetch on the link still works.
4. **Capability gating:** server returns `{ shares: false }` → `hcfs_create_share` returns a typed "feature unavailable" error.

### Frontend (Vitest)

- `ShareFileModal` state-machine tests with mocked IPC events (encrypting → uploading → finalizing → done).
- "My Shares" page renders empty state, populated state, expired badge.
- Right-click menu shows/hides correctly based on sync state and capability flag.

---

## File-by-file change list

| File | Action |
|------|--------|
| `src-tauri/migrations/<n>_share_keystore.sql` | new |
| `src-tauri/src/commands/shares.rs` | new |
| `src-tauri/src/commands/mod.rs` | export shares |
| `src-tauri/src/shares/mod.rs` | new |
| `src-tauri/src/shares/keystore.rs` | new |
| `src-tauri/src/lib.rs` (or `main.rs`) | register the 3 commands |
| `src-tauri/Cargo.toml` | add/bump `hcfs-client` dep to a version that exports `share` |
| `src-tauri/tests/share_roundtrip.rs` | new |
| `src/components/ShareFileModal.tsx` | new |
| `src/components/FileRow.tsx` (existing) | add menu item + handler |
| `src/app/shares/page.tsx` | new |
| `src/lib/tauri/shares.ts` | typed wrappers around the 3 commands |
| `src/lib/capabilities.ts` (existing or new) | add `shares` boolean |
| `src/components/__tests__/ShareFileModal.test.tsx` | new |

## Step order

1. SQLx migration + `SqliteShareKeystore` + unit tests.
2. `hcfs_create_share` Tauri command (single-shot path) + integration test #1.
3. Chunked path inside the same command (no new command — `hcfs-client::share` decides).
4. `hcfs_list_shares` + `hcfs_revoke_share` + integration tests #2, #3.
5. `ShareFileModal` component + Vitest.
6. `FileRow` context menu hook-up.
7. `/shares` page + Vitest.
8. Capability gating end-to-end.

Steps 5–8 can run in parallel with 1–4 against a mocked Tauri command surface.

## Dependency on hcfs plan

This plan **starts** before the hcfs plan finishes — the trait surface (`ShareKeystore`, `create_share`, `list_shares`, `revoke_share`) is fixed by the wire contract above and can be stubbed locally. Final integration test passes only after the hcfs server endpoints land.
