# Sharing a Folder Outside a Drive — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or
> superpowers:subagent-driven-development) to implement this plan task-by-task.
> Every subagent prompt must include: "Call `mcp__hippius-mem__recall` about the
> task before making changes, and `mcp__hippius-mem__remember` any durable
> decision/gotcha you discover." Load the `rust-style` skill before any Rust edit.
> Each part runs in its own worktree of its own repo.

**Goal:** Finder's "Share with Hippius" on a folder outside every synced drive
uploads a copy under the link's own key and mints a live folder link that
behaves exactly like an in-drive one, and the copy is deleted when the link
expires or is revoked.

**Architecture:** A `folder_shares` row gains `source = upload`, backed by its
own `folder_share_files` / `folder_share_chunks` instead of a drive's
`file_records`. Recipient `meta`/`browse`/`blob` keep their paths and wire
shapes and dispatch on `source`; the reaper deletes an upload link's storage.
hcfs-client gains `create_upload_folder_share`; the desktop routes outside
folders to it; the console labels the row. Design:
[`2026-10-02-outside-folder-share-design.md`](2026-10-02-outside-folder-share-design.md).

**Tech Stack:** Rust (axum, sqlx/Postgres in hcfs-server; Tauri + SQLite in the
desktop), hcfs-client, Next.js (console + desktop frontend), vitest, Playwright.

---

## Rollout order

1. **Part 1 — hcfs** (server + client), merged to hcfs `main` and deployed with
   capability `upload_folder_shares` on. Nothing user-visible changes until a
   client uses it.
2. **Part 2 — hippius-console** (base `dev`). Ships before or with the desktop;
   safe before the server deploy (it only reads `source`, defaulting to drive).
3. **Part 3 — hippius-desktop** (base `staging`, then beta → main). Pin bump to
   the Part 1 merge rev (`<HCFS_REV>`); run the live e2e lane before merging the
   bump PR.

## Cross-part decisions (these override anything below that disagrees)

- **Listing rows send `""`, never `null`, for `folder_hash` / `path_prefix` of an
  upload row.** Shipped desktop and console clients deserialize them as required
  strings; one `null` row would empty their whole folder-share list. Part 2's
  request for `null` is superseded; its parser accepts both.
- **Wire value of `source` is `"drive"` | `"upload"`**, absent = drive. The
  desktop maps it to its own FE enum (`"drive"` | `"uploadedCopy"`); the console
  reads the wire value directly.
- **The server mints the token on open** and returns `{share_token, token_hash}`;
  the client pushes the owner wrap after seal through the existing
  `PUT /v1/folder-shares/owner-wraps` (desktop: `owner_wrap::push_folder_for_account`).
- **Quota is held once, at open, for the declared total bytes**, so a quota
  refusal arrives before any file uploads. Part 3 must map that open-time
  refusal to `NotReady(StorageLimitReached)` (plans dialog), which closes Part 3's
  open risk about mid-upload quota errors showing a generic message.
- **Blob responses for upload links are `application/octet-stream`.** The
  console's public proxy re-encodes text types and would corrupt ciphertext.
- **Cancel is cooperative for the upload path only**: the cancel token goes into
  `create_upload_folder_share` so it can `DELETE` the half-built link; other
  Finder mints keep the drop-on-cancel behaviour (`dispatch::until_cancelled`).
- **Error variants Part 3 matches by name:** `FolderShareError::SourceChanged {
  relative_path }` and `FolderShareError::Cancelled`; the rest fall through to
  `AppError::Hcfs`. The desktop scan enforces the 50,000-entry and 5 GiB-per-file
  limits itself, so `TooManyItems` / `FileTooLarge` / `EmptyFolder` are backstops.

---


# Part 1 — hcfs (server + client)

## Outside-folder share, Part 1: hcfs server + hcfs-client Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. Load the `rust-style` skill before the first edit.

**Goal:** A folder link whose contents are an encrypted upload owned by the link
(`source = 'upload'`), not a view over a drive. It is served through the unchanged recipient
routes `/v1/folder-shares/{token}/meta|browse|blob`, and `hcfs-client` gains
`create_upload_folder_share`, which the desktop calls for a Finder folder outside every drive.

**Architecture:** `folder_shares` gets a `source` column, and upload rows name no drive.
Their files live in the new `folder_share_files` table and their ciphertext chunks in
`folder_share_chunks`. Six owner routes under `/v1/folder-shares/uploads` open, fill, seal
and abort a link, and they reuse the chunked file-share machinery: claim-before-store, the
8 MiB chunk cap, the Drive-rail quota hold and the share summary rows. The recipient routes
pick a row source through one small enum (`ShareListingSource`). Paging, sorting, totals and
wire formatting therefore stay a single code path for both sources, and parity tests seed one
tree on both sides and compare the results. The share reaper gains an upload sweep that
deletes the storage, releases billing and drops the row. On the client, the files are
planned first, then a fresh 32-byte key encrypts each file in drive framing, four files
upload at a time, and the link is sealed. Any error or cancellation aborts the link.

**Tech Stack:** Rust 2024, axum 0.8, sqlx 0.8 (runtime queries, Postgres), tokio,
`tokio_util::sync::CancellationToken`, `futures_util`, wiremock (client tests), serial_test.

**Repo:** `/Users/georgiosdelkos/Documents/GitHub/Bitensor/hcfs`. Line references are to
`origin/main` at `5be73913`. Every path below is relative to the worktree root
`/Users/georgiosdelkos/Documents/GitHub/Bitensor/hcfs-upload-folder-shares` (Task 0).

---

### Contract deviations

| # | Contract said | This plan does | Why |
|---|---|---|---|
| D1 | Open body carries `token_hash` (client-minted); response `{token_hash}` | The **server** mints the token, as `POST /v1/folder-shares` does (`folder_shares/routes.rs:1267`). The open response is `{share_token, token_hash}` | Keeps one minting path (256-bit CSPRNG, hash-at-rest). The plaintext token crosses the wire once, the same as a drive mint, and a client can never pick a weak or colliding token. Every later owner route is addressed by `token_hash`, as the contract asks |
| D2 | Open body has `owner_wrap?` | No `owner_wrap` on open. The client pushes it after seal through the existing `PUT /v1/folder-shares/owner-wraps` | The wrap route already exists and works on any row the caller minted. The row is not listable before seal anyway. One write path for wraps |
| D3 | `folder_share_files` storage refs mirror `file_shares` (`arion_hash`/`s3_hash` or `chunk_hashes[]`/`chunk_sizes[]`) | **Chunk-only storage.** Every file, a 0-byte one included, is ≥ 1 chunk in `folder_share_chunks(file_id, chunk_index, chunk_hash, chunk_size)`. Nothing is copied into arrays | One storage shape: no single-shot path and no finalize copy. Chunks are written under a per-file row lock, so no array update ever races. `BLOB_REFERENCE_SQL` gains one indexed arm |
| D4 | Column names `plaintext_size`, `uploaded_at` | `size_bytes` (plaintext), `created_at` / `updated_at` (unix seconds), `file_name`, `parent_dir`, `path_hash`, which are `file_records`' names | `resolve_browse_file_order` / `resolve_sort` / `HcfsStore::browse_order_by` emit those column names, so the upload SQL reuses the drive sort vocabulary unchanged ("search/filters/stats identical"). The recipient wire keeps `size_bytes` / `uploaded_at` |
| D5 | Billing: hold per chunk; usage += plaintext per file on file complete | **One hold at open** for the declared `total_bytes` (id `folder-share-upload:{token_hash}`, 24 h). **Seal** settles it into usage `(total_bytes, file_count)`. Abort and the reaper release the hold; the reaper releases the usage of a sealed link | Same shape as the chunked file share (`init` holds, `complete` settles). A link that never seals is never counted as usage. The reaper releases exactly what seal recorded, because seal asserts declared == received |
| D6 | `UploadFolderShareOptions { display_name: String, ttl, password }` | `UploadFolderShareOptions<'a> { display_name: &'a str, ttl: ShareTtl, password: Option<&'a str>, console_base_url: &'a str }` | Mirrors `FolderShareOptions<'a>` (`folder_share.rs:124`). The URL cannot be built without `console_base_url` (Part 3 deviation 1 agrees) |
| D7 | `keystore: &dyn <existing share keystore trait>`, error `...` | `&dyn crate::client::share::ShareKeystore`; error `FolderShareError` with new variants `EmptyFolder`, `TooManyItems { count, max }`, `FileTooLarge { relative_path, size }`, `SourceChanged { relative_path }`, `Cancelled` | Real names. Part 3 matches `SourceChanged` / `Cancelled` by name |
| D8 | "capabilities field on the existing capabilities struct" (client) | Server only: `Capabilities.upload_folder_shares` (`shares/types.rs:102`). `hcfs-client` has **no** capabilities struct | The desktop parses `/v1/capabilities` itself (Part 3 deviation 7) |
| D9 | Owner list: `folder_hash`/`path_prefix` NULL for upload rows (Part 2 asked for JSON `null`) | The listing serializes them as **`""`** (SQL `COALESCE`). The client `ListItemWire` also accepts `null` (`#[serde(default, deserialize_with)]`) | Shipped desktop (`ListItemWire`) and console parse both as required strings, so a `null` would drop every user's whole folder-share list once one upload row exists (Part 3 deviation 8). Part 2's parser accepts both, so `""` works for it |
| D10 | Stat re-check "before and after upload" | Re-check before reading the file and right after it has been read (encrypted), before sending | The bytes are captured at encryption. A change after that cannot corrupt what was sent, and a change during the read is exactly what must fail. The ciphertext-length check backs up the mtime check |
| D11 | Limits "≤ 50,000 files per link" | `MAX_UPLOAD_FOLDER_SHARE_FILES = 50_000` and `MAX_UPLOAD_FOLDER_SHARE_DIRS = 50_000` (open's `dirs` list), exported from `hcfs-shared`. The per-file cap is on **ciphertext** (`MAX_UPLOAD_FOLDER_SHARE_FILE_CIPHERTEXT = 5 GiB`) | The ciphertext is what is stored and what the chunked file share caps (`CHUNKED_TOTAL_CIPHERTEXT_MAX`). The client checks `predict_ciphertext_size` against the same constant |
| D12 | Recipient `sort_by=uploaded_at` (Part 2) | Not an alias, exactly as on drive links. `date` / `created_at` sort by upload time, and `date_from`/`date_to` filter on it | "Work identically" means the same `share_sort_by` allowlist for both sources |
| D13 | Abort `DELETE` "marks revoked" for any link | Abort only acts on links still `uploading`. A sealed link is revoked through the existing `DELETE /v1/folder-shares/by-hash/{token_hash}` | Seal is the commit point. The client's abort falls back to revoke-by-hash when abort answers 404 because the seal landed without its response reaching the client |
| D14 | Idle deadline: `last_activity_at` bumped per chunk | Bumped on open, file init, every chunk claim and file complete. The 60-minute idle check also runs *inside* those statements, so a link the reaper may take any moment refuses new work | Avoids storing bytes for a row the next sweep deletes |

---

### Conventions every task follows

- **Style gates** (global CLAUDE.md, rust-style skill): ≤ 100 lines per function, ≤ 5
  positional params (bundle into a struct otherwise), 100-char lines, absolute `crate::`
  imports, comments explain *why*, no emojis, `tracing` only (never `println!`).
- **Never log a plaintext folder-share token.** Log `token_hash` (or its 16-hex prefix in
  the client). `folder_shares/routes.rs` module docs explain the rule.
- **Blob deletes go through `storage::cleanup`**, never `storage.delete`, and only after the
  row is gone (`hcfs-server/CLAUDE.md` "Blob deletion").
- **No network inside a transaction** (5 s idle-in-transaction timeout).
- **No rate limiters or semaphores in the data path** (root `CLAUDE.md`). The per-link file
  cap is a validation limit, not a throughput cap.
- DB tests need `export TEST_DATABASE_URL=postgres://localhost/hcfs_test`. Run them with
  `--test-threads=1`: the folder-share DB tests are `#[serial]` and share one database.
- Commit after each task: subject in the imperative, ≤ 72 chars, the body says why, no
  `Co-Authored-By`. Before every commit: `cargo fmt --all` and
  `cargo clippy -p <crate> --all-targets -- -D warnings`.
- Before the first edit, call `mcp__hippius-mem__recall` with "folder share upload hcfs
  server reaper billing". After finishing, `remember` any new gotcha.

---

### Task 0: Worktree and baseline

**Step 1: Create the worktree on `origin/main`**

```bash
cd /Users/georgiosdelkos/Documents/GitHub/Bitensor/hcfs
git fetch origin
git worktree add ../hcfs-upload-folder-shares -b feat/upload-folder-shares origin/main
cd ../hcfs-upload-folder-shares
```

**Step 2: Baseline is green**

```bash
export TEST_DATABASE_URL=postgres://localhost/hcfs_test
cargo test -p hcfs-shared
cargo test -p hcfs-server folder_shares -- --test-threads=1
cargo test -p hcfs-client folder_share
```

Expected: all pass. If any fail on a clean `origin/main`, stop and report: do not build on a
red base.

---

### Task 1: Shared vocabulary: `FolderShareSource` and upload limits

**Files:**
- Modify: `hcfs-shared/src/shares.rs` (types after `ShareTtl`, line 83; tests module line 85)

**Step 1: Write the failing tests** (append inside `mod tests` in `hcfs-shared/src/shares.rs`)

```rust
    /// `source` crosses the wire on the owner listing to clients that are not
    /// redeployed with the server, and the database stores the same strings.
    #[test]
    fn folder_share_source_wire_values_are_stable() {
        for (source, wire) in [
            (FolderShareSource::Drive, "\"drive\""),
            (FolderShareSource::Upload, "\"upload\""),
        ] {
            assert_eq!(serde_json::to_string(&source).unwrap(), wire);
            assert_eq!(serde_json::from_str::<FolderShareSource>(wire).unwrap(), source);
            assert_eq!(format!("\"{}\"", source.as_str()), wire);
            assert_eq!(FolderShareSource::from_column(source.as_str()), Some(source));
        }
        assert_eq!(FolderShareSource::from_column("bogus"), None);
    }

    /// A listing row from a server that predates uploaded copies carries no
    /// `source`, and such a row can only be a drive link.
    #[test]
    fn absent_folder_share_source_means_drive() {
        #[derive(Deserialize)]
        struct Holder {
            #[serde(default)]
            source: FolderShareSource,
        }
        let parsed: Holder = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed.source, FolderShareSource::Drive);
        assert_eq!(FolderShareSource::default(), FolderShareSource::Drive);
    }

    /// The client refuses what the server would refuse, so the two must read
    /// the same numbers.
    #[test]
    fn upload_limits_are_the_documented_ones() {
        assert_eq!(MAX_UPLOAD_FOLDER_SHARE_FILES, 50_000);
        assert_eq!(MAX_UPLOAD_FOLDER_SHARE_DIRS, 50_000);
        assert_eq!(MAX_UPLOAD_FOLDER_SHARE_FILE_CIPHERTEXT, 5 * 1024 * 1024 * 1024);
    }
```

**Step 2: Run the tests and confirm they fail**

`cargo test -p hcfs-shared folder_share_source upload_limits`
Expected: compile error `cannot find type FolderShareSource`.

**Step 3: Implement** (insert after the `ShareTtl` enum, before `#[cfg(test)]`)

```rust
/// Most files one uploaded folder link may hold. Lives here so the desktop
/// refuses an oversized folder before it uploads a byte, by the same number
/// the server enforces.
pub const MAX_UPLOAD_FOLDER_SHARE_FILES: u32 = 50_000;

/// Most directory paths one open request may list. Only directories with no
/// file beneath them need listing (file paths imply the rest), so a real
/// folder never comes near this; it bounds the open transaction.
pub const MAX_UPLOAD_FOLDER_SHARE_DIRS: u32 = 50_000;

/// Largest ciphertext one file of an uploaded folder link may carry: the
/// same 5 GiB a chunked file share allows.
pub const MAX_UPLOAD_FOLDER_SHARE_FILE_CIPHERTEXT: u64 = 5 * 1024 * 1024 * 1024;

/// Where a folder link's contents come from.
///
/// The recipient page and the owner's link controls are identical for both;
/// only the owner listing shows the difference ("Uploaded copy"), and only
/// the server reads different tables. Absent on the wire means
/// [`FolderShareSource::Drive`]: every link minted before uploaded copies
/// existed is a drive link.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderShareSource {
    /// A live view over a drive subtree.
    #[default]
    Drive,
    /// A copy uploaded under the link's own key when the link was created.
    Upload,
}

impl FolderShareSource {
    /// The `folder_shares.source` column value, identical to the wire string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Drive => "drive",
            Self::Upload => "upload",
        }
    }

    /// Parse a `folder_shares.source` column value. `None` for anything the
    /// table CHECK would not admit, so a caller fails closed on drift.
    #[must_use]
    pub fn from_column(value: &str) -> Option<Self> {
        match value {
            "drive" => Some(Self::Drive),
            "upload" => Some(Self::Upload),
            _ => None,
        }
    }
}
```

Also update the module doc's first line from "Wire vocabulary for file shares." to "Wire
vocabulary for file and folder shares."

**Step 4: Run the tests and confirm they pass**

`cargo test -p hcfs-shared`. Expected: PASS.

**Step 5: Commit**

```bash
git add hcfs-shared/src/shares.rs
git commit -m "Add FolderShareSource and uploaded-folder limits to hcfs-shared" -m "Server, desktop client and console must agree on the 'drive'/'upload'
strings and on the 50,000-file / 5 GiB caps; one definition keeps them
from drifting, like ShareTtl."
```

---

### Task 2: Migration: `source` on `folder_shares`, `folder_share_files`, `folder_share_chunks`

**Files:**
- Create: `hcfs-server/migrations/20261002000000_upload_folder_shares.up.sql`
- Create: `hcfs-server/migrations/20261002000000_upload_folder_shares.down.sql`
- Modify: `hcfs-server/src/store/testing.rs:62-65` (TRUNCATE list). Without this, Postgres
  refuses the harness TRUNCATE of `folder_shares` once a table references it.
- Create: `hcfs-server/src/folder_shares/upload_test_support.rs`
- Create: `hcfs-server/src/folder_shares/upload_db.rs` (tests only in this task)
- Modify: `hcfs-server/src/folder_shares/mod.rs`

**Step 1: Write the test support module** (`hcfs-server/src/folder_shares/upload_test_support.rs`)

```rust
//! Fixtures shared by the uploaded-copy tests (`upload_db`, `upload_listing`,
//! `db`). Like `folder_shares::db`'s own tests these never truncate: every
//! test mints unique owners and tokens and is `#[serial]` with the other
//! folder-share database tests.

use std::sync::atomic::{AtomicU64, Ordering};

use chrono::Utc;

use crate::store::HcfsStore;

/// Unique-per-call string; pid + nanos keep it unique across reruns.
pub(crate) fn unique(tag: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let nanos = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    format!("fsup-{tag}-{}-{nanos}-{n}", std::process::id())
}

/// The test database, or `None` when `TEST_DATABASE_URL` is unset. A set
/// but unusable URL panics, so a broken database cannot pass as a skip.
pub(crate) async fn test_store() -> Option<HcfsStore> {
    let url = std::env::var("TEST_DATABASE_URL").ok()?;
    let store = HcfsStore::connect(&url)
        .await
        .unwrap_or_else(|e| panic!("TEST_DATABASE_URL is set but unusable: {e}"));
    Some(store)
}

/// An upload link row written straight through SQL, in `state`
/// (`uploading` or `complete`), with a 7-day preset and room for 100 files.
pub(crate) async fn insert_upload_row(store: &HcfsStore, token_hash: &str, owner: &str, state: &str) {
    sqlx::query(
        "INSERT INTO folder_shares \
            (token_hash, owner_ss58, minted_by_ss58, display_name, source, upload_state, \
             last_activity_at, upload_ttl, declared_file_count, declared_bytes) \
         VALUES ($1, $2, $2, 'Holiday', 'upload', $3, NOW(), '7d', 100, 1000000)",
    )
    .bind(token_hash)
    .bind(owner)
    .bind(state)
    .execute(store.pool())
    .await
    .expect("insert upload row");
}

/// One complete `folder_share_files` row (`kind` is `file` or `dir`).
/// Returns its `file_id`.
pub(crate) async fn insert_entry(
    store: &HcfsStore,
    token_hash: &str,
    kind: &str,
    path: &str,
    size_and_time: (i64, i64),
) -> i64 {
    let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
    let (size, created_at) = size_and_time;
    let chunks: i32 = if kind == "file" { 1 } else { 0 };
    let ciphertext: i64 = if kind == "file" { size + 48 } else { 0 };
    sqlx::query_scalar(
        "INSERT INTO folder_share_files \
            (token_hash, kind, relative_path, parent_dir, file_name, path_hash, size_bytes, \
             ciphertext_size, total_chunks, upload_state, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'complete', $10, $10) \
         RETURNING file_id",
    )
    .bind(token_hash)
    .bind(kind)
    .bind(path)
    .bind(parent)
    .bind(name)
    .bind(blake3::hash(path.as_bytes()).as_bytes().to_vec())
    .bind(size)
    .bind(ciphertext)
    .bind(chunks)
    .bind(created_at)
    .fetch_one(store.pool())
    .await
    .expect("insert folder_share_files row")
}

/// One stored chunk for `file_id`.
pub(crate) async fn insert_chunk(store: &HcfsStore, file_id: i64, index: i32, hash: &str) {
    sqlx::query(
        "INSERT INTO folder_share_chunks (file_id, chunk_index, chunk_hash, chunk_size) \
         VALUES ($1, $2, $3, 48)",
    )
    .bind(file_id)
    .bind(index)
    .bind(hash)
    .execute(store.pool())
    .await
    .expect("insert folder_share_chunks row");
}
```

Register it in `hcfs-server/src/folder_shares/mod.rs` (after `pub mod types;`):

```rust
pub mod upload_db;
#[cfg(test)]
mod upload_test_support;
```

**Step 2: Write the failing schema tests** (`hcfs-server/src/folder_shares/upload_db.rs`)

```rust
//! Persistence for uploaded-copy folder links: `folder_shares` rows with
//! `source = 'upload'`, their `folder_share_files` entries, and the
//! `folder_share_chunks` that hold each file's ciphertext.

#[cfg(test)]
mod tests {
    use serial_test::serial;

    use crate::folder_shares::upload_test_support::{
        insert_chunk, insert_entry, insert_upload_row, test_store, unique,
    };
    use crate::utils::hash_token;

    fn check_violation(err: &sqlx::Error) -> bool {
        err.as_database_error()
            .and_then(|db| db.code())
            .is_some_and(|code| code == "23514")
    }

    /// The shape CHECK is what keeps every drive-keyed path (FK cascade,
    /// member sweeps) away from upload rows and keeps drive rows whole.
    #[tokio::test]
    #[serial]
    async fn an_upload_row_names_no_drive_and_a_drive_row_must() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let owner = unique("owner");
        insert_upload_row(&store, &hash_token(&unique("tok")), &owner, "uploading").await;

        let named = sqlx::query(
            "INSERT INTO folder_shares \
                (token_hash, owner_ss58, display_name, source, upload_state, \
                 last_activity_at, upload_ttl, folder_hash, path_prefix) \
             VALUES ($1, $2, 'x', 'upload', 'uploading', NOW(), '7d', '0011223344556677', '')",
        )
        .bind(hash_token(&unique("tok")))
        .bind(&owner)
        .execute(store.pool())
        .await
        .expect_err("an upload row must not name a drive");
        assert!(check_violation(&named), "{named}");

        let driveless = sqlx::query(
            "INSERT INTO folder_shares (token_hash, owner_ss58, display_name) \
             VALUES ($1, $2, 'x')",
        )
        .bind(hash_token(&unique("tok")))
        .bind(&owner)
        .execute(store.pool())
        .await
        .expect_err("a drive row must name its drive");
        assert!(check_violation(&driveless), "{driveless}");
    }

    /// Deleting the link row is the whole reap: files and chunks must go
    /// with it, or the chunk table keeps naming blobs nobody can reach.
    #[tokio::test]
    #[serial]
    async fn deleting_an_upload_row_takes_its_files_and_chunks() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let token_hash = hash_token(&unique("tok"));
        insert_upload_row(&store, &token_hash, &unique("owner"), "complete").await;
        let file_id = insert_entry(&store, &token_hash, "file", "a.txt", (5, 1)).await;
        insert_chunk(&store, file_id, 0, &unique("chunk")).await;

        sqlx::query("DELETE FROM folder_shares WHERE token_hash = $1")
            .bind(&token_hash)
            .execute(store.pool())
            .await
            .unwrap();

        let files: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM folder_share_files WHERE token_hash = $1")
                .bind(&token_hash)
                .fetch_one(store.pool())
                .await
                .unwrap();
        let chunks: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM folder_share_chunks WHERE file_id = $1")
                .bind(file_id)
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!((files, chunks), (0, 0));
    }

    /// Two entries at one path would make browse and blob ambiguous.
    #[tokio::test]
    #[serial]
    async fn one_link_cannot_hold_two_entries_at_one_path() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let token_hash = hash_token(&unique("tok"));
        insert_upload_row(&store, &token_hash, &unique("owner"), "uploading").await;
        insert_entry(&store, &token_hash, "dir", "a", (0, 1)).await;
        let duplicate = sqlx::query(
            "INSERT INTO folder_share_files \
                (token_hash, kind, relative_path, parent_dir, file_name, path_hash, \
                 total_chunks, upload_state, created_at, updated_at) \
             VALUES ($1, 'file', 'a', '', 'a', $2, 1, 'uploading', 1, 1)",
        )
        .bind(&token_hash)
        .bind(blake3::hash(b"a").as_bytes().to_vec())
        .execute(store.pool())
        .await
        .expect_err("a file cannot sit where a directory is");
        let code = duplicate.as_database_error().and_then(|db| db.code().map(|c| c.to_string()));
        assert_eq!(code.as_deref(), Some("23505"), "{duplicate}");
    }
}
```

**Step 3: Run the tests and confirm they fail**

`cargo test -p hcfs-server folder_shares::upload_db -- --test-threads=1`
Expected: FAIL (`column "source" of relation "folder_shares" does not exist`).

**Step 4: Write the migration**

`hcfs-server/migrations/20261002000000_upload_folder_shares.up.sql`:

```sql
-- Uploaded-copy folder links: a folder share whose contents are the link's
-- own encrypted upload rather than a live view over a drive. Design:
-- hippius-desktop docs/plans/2026-10-02-outside-folder-share-design.md.
--
-- folder_shares.source: 'drive' rows are every row that existed before and
-- keep every invariant they had. 'upload' rows name no drive at all
-- (folder_hash and path_prefix NULL): the drive FK is MATCH SIMPLE, which
-- skips a row with any NULL key column, so no registry cascade, member
-- sweep or drive-keyed predicate can ever reach one. An upload row is
-- 'uploading' until sealed; recipients and the owner listing only ever see
-- 'complete' rows. last_activity_at drives the idle reap, upload_ttl is the
-- preset chosen at open and resolved at seal, declared_* are what the
-- open's quota hold covered and what seal checks arrived, reap_after is the
-- reaper's backoff for a row it could not settle.
--
-- folder_share_files mirrors file_records' column names (relative_path,
-- file_name, size_bytes = plaintext, created_at/updated_at = unix seconds,
-- path_hash) so the recipient listing reuses the drive listing's sort
-- vocabulary unchanged. parent_dir is stored, not derived, because only
-- one link's rows are ever scanned. kind = 'dir' rows are directories:
-- every ancestor of a file plus any empty directory the open listed.
--
-- folder_share_chunks holds each file's ciphertext chunks. Its chunk_hash
-- is a blob reference (HcfsStore::BLOB_REFERENCE_SQL), hence the index.
--
-- Boot-migration policy (2026-07-27 incident; enforced by
-- `migration_policy_bounds_boot_time_statements`): every ADD COLUMN has a
-- constant default or none (catalog-only), DROP NOT NULL is catalog-only,
-- the CHECKs validate tens of rows, and the new tables start empty.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE folder_shares
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'drive',
    ADD COLUMN IF NOT EXISTS upload_state TEXT NOT NULL DEFAULT 'complete',
    ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS upload_ttl TEXT,
    ADD COLUMN IF NOT EXISTS declared_file_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS declared_bytes BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reap_after TIMESTAMPTZ,
    ALTER COLUMN folder_hash DROP NOT NULL,
    ALTER COLUMN path_prefix DROP NOT NULL;

ALTER TABLE folder_shares
    ADD CONSTRAINT folder_shares_source_check
        CHECK (source IN ('drive', 'upload')),
    ADD CONSTRAINT folder_shares_upload_state_check
        CHECK (upload_state IN ('uploading', 'complete')),
    ADD CONSTRAINT folder_shares_upload_ttl_check
        CHECK (upload_ttl IN ('24h', '7d', '30d', 'never')),
    ADD CONSTRAINT folder_shares_declared_check
        CHECK (declared_file_count >= 0 AND declared_bytes >= 0),
    ADD CONSTRAINT folder_shares_source_shape_check CHECK (
        (source = 'drive'
            AND folder_hash IS NOT NULL AND path_prefix IS NOT NULL
            AND upload_state = 'complete')
        OR (source = 'upload'
            AND folder_hash IS NULL AND path_prefix IS NULL
            AND upload_ttl IS NOT NULL AND last_activity_at IS NOT NULL)
    );

-- Reaper arms for upload rows. The expired arm reuses
-- folder_shares_expires_idx (revoked_at IS NULL AND expires_at IS NOT NULL).
CREATE INDEX IF NOT EXISTS folder_shares_reap_upload_revoked
    ON folder_shares (revoked_at)
    WHERE source = 'upload' AND revoked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS folder_shares_reap_upload_idle
    ON folder_shares (last_activity_at)
    WHERE source = 'upload' AND upload_state = 'uploading' AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS folder_share_files (
    file_id         BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_hash      TEXT    NOT NULL REFERENCES folder_shares (token_hash) ON DELETE CASCADE,
    kind            TEXT    NOT NULL CHECK (kind IN ('file', 'dir')),
    relative_path   TEXT    NOT NULL
                    CHECK (relative_path <> '' AND relative_path !~ '^/' AND relative_path !~ '/$'),
    parent_dir      TEXT    NOT NULL,
    file_name       TEXT    NOT NULL,
    path_hash       BYTEA   NOT NULL CHECK (octet_length(path_hash) = 32),
    size_bytes      BIGINT  NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    ciphertext_size BIGINT  NOT NULL DEFAULT 0 CHECK (ciphertext_size >= 0),
    total_chunks    INTEGER NOT NULL DEFAULT 0 CHECK (total_chunks >= 0),
    upload_state    TEXT    NOT NULL CHECK (upload_state IN ('uploading', 'complete')),
    created_at      BIGINT  NOT NULL,
    updated_at      BIGINT  NOT NULL,
    CONSTRAINT folder_share_files_path_unique UNIQUE (token_hash, relative_path),
    -- A directory carries no bytes and is born complete; a file is at least
    -- one chunk (a 0-byte file still has its 48-byte framing).
    CONSTRAINT folder_share_files_kind_shape_check CHECK (
        (kind = 'dir' AND size_bytes = 0 AND ciphertext_size = 0 AND total_chunks = 0
            AND upload_state = 'complete')
        OR (kind = 'file' AND total_chunks >= 1)
    )
);

-- One-level directory listing of one link.
CREATE INDEX IF NOT EXISTS folder_share_files_parent_idx
    ON folder_share_files (token_hash, parent_dir);

CREATE TABLE IF NOT EXISTS folder_share_chunks (
    file_id     BIGINT      NOT NULL REFERENCES folder_share_files (file_id) ON DELETE CASCADE,
    chunk_index INTEGER     NOT NULL CHECK (chunk_index >= 0),
    chunk_hash  TEXT        NOT NULL,
    chunk_size  BIGINT      NOT NULL CHECK (chunk_size > 0),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_folder_share_chunks_chunk_hash
    ON folder_share_chunks (chunk_hash);
```

`hcfs-server/migrations/20261002000000_upload_folder_shares.down.sql`:

```sql
-- Development rollback only. Upload rows cannot exist without these
-- columns, and the blobs their chunks named are orphaned by this: nothing
-- else references them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

DROP TABLE IF EXISTS folder_share_chunks;
DROP TABLE IF EXISTS folder_share_files;
DELETE FROM folder_shares WHERE source = 'upload';
DROP INDEX IF EXISTS folder_shares_reap_upload_revoked;
DROP INDEX IF EXISTS folder_shares_reap_upload_idle;

ALTER TABLE folder_shares
    DROP CONSTRAINT IF EXISTS folder_shares_source_shape_check,
    DROP CONSTRAINT IF EXISTS folder_shares_declared_check,
    DROP CONSTRAINT IF EXISTS folder_shares_upload_ttl_check,
    DROP CONSTRAINT IF EXISTS folder_shares_upload_state_check,
    DROP CONSTRAINT IF EXISTS folder_shares_source_check,
    ALTER COLUMN folder_hash SET NOT NULL,
    ALTER COLUMN path_prefix SET NOT NULL,
    DROP COLUMN IF EXISTS reap_after,
    DROP COLUMN IF EXISTS declared_bytes,
    DROP COLUMN IF EXISTS declared_file_count,
    DROP COLUMN IF EXISTS upload_ttl,
    DROP COLUMN IF EXISTS last_activity_at,
    DROP COLUMN IF EXISTS upload_state,
    DROP COLUMN IF EXISTS source;
```

In `hcfs-server/src/store/testing.rs` (lines 62-65), add the two new tables to the TRUNCATE
list. Replace `drive_extra_seats, backups, devices",` with:

```rust
         drive_extra_seats, backups, devices, folder_share_chunks, folder_share_files",
```

**Step 5: Run the tests and confirm they pass**

```bash
cargo test -p hcfs-server folder_shares::upload_db -- --test-threads=1
cargo test -p hcfs-server migration_policy_bounds_boot_time_statements
cargo test -p hcfs-server store::browse -- --test-threads=1
```

Expected: PASS. The last command proves the harness TRUNCATE still runs.

**Step 6: Commit**

```bash
git add hcfs-server/migrations/20261002000000_upload_folder_shares.*.sql \
  hcfs-server/src/folder_shares/ hcfs-server/src/store/testing.rs
git commit -m "Add schema for folder links backed by an uploaded copy" -m "An outside folder has no drive rows to scope a link over, so its
contents live under the link: folder_share_files / folder_share_chunks.
Upload rows name no drive, so the MATCH SIMPLE drive FK and every
drive-keyed sweep cannot reach them, and the shape CHECK keeps drive
rows whole."
```

---

### Task 3: Teach existing `folder_shares` queries that upload rows exist

Without this task the existing queries would orphan blobs (the drive reaper and purge would
delete upload rows with a plain DELETE, and the cascade drops the chunk refs before anyone
reads them) and would leak half-uploaded links to recipients.

**Files:**
- Modify: `hcfs-server/src/folder_shares/db.rs`:
  - `FolderShareDbError` (l.74): add an `Inconsistent` variant
  - `FolderShareRow` (l.269) and `FolderShareOwnerRow` (l.289): add `source`
  - `get_live_share_by_token` (l.429), `list_owner_shares` (l.461), `update_ttl_by_hash`
    (l.599), `REAP_REVOKED_SQL` / `REAP_EXPIRED_SQL` (l.709/717), `delete_all_for_owner`
    (l.732), and the pinned tests at l.794 and l.1353

**Step 1: Write the failing tests** (append to `mod tests` in `folder_shares/db.rs`)

```rust
    use crate::folder_shares::upload_test_support::insert_upload_row;

    /// An upload link is invisible to recipients until sealed, and a sealed
    /// one reads like any other live link (empty drive scope, its source).
    #[tokio::test]
    #[serial]
    async fn recipients_see_an_upload_link_only_once_sealed() {
        let store = require_db!();
        let owner = unique("owner");
        let uploading = unique("tok");
        let sealed = unique("tok");
        insert_upload_row(&store, &hash_token(&uploading), &owner, "uploading").await;
        insert_upload_row(&store, &hash_token(&sealed), &owner, "complete").await;

        assert!(
            get_live_share_by_token(store.pool(), &uploading)
                .await
                .unwrap()
                .is_none()
        );
        let row = get_live_share_by_token(store.pool(), &sealed)
            .await
            .unwrap()
            .expect("a sealed upload link is live");
        assert_eq!(row.source, "upload");
        assert_eq!((row.folder_hash.as_str(), row.path_prefix.as_str()), ("", ""));
    }

    /// The owner listing hides links still uploading (a failed share must not
    /// flash a row) and serializes an upload link's drive scope as "".
    #[tokio::test]
    #[serial]
    async fn the_owner_listing_carries_source_and_hides_unsealed_uploads() {
        let store = require_db!();
        let owner = unique("owner");
        let uploading = hash_token(&unique("tok"));
        let sealed = hash_token(&unique("tok"));
        insert_upload_row(&store, &uploading, &owner, "uploading").await;
        insert_upload_row(&store, &sealed, &owner, "complete").await;

        let rows = list_owner_shares(store.pool(), &owner).await.unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].token_hash, sealed);
        assert_eq!(rows[0].source, "upload");
        assert_eq!(rows[0].folder_hash, "");
        assert_eq!(rows[0].path_prefix, "");
    }

    /// The metadata-only sweep and purge must never DELETE an upload row: the
    /// cascade would drop its chunk references before the upload reaper reads
    /// them, and those blobs would never be deleted.
    #[tokio::test]
    #[serial]
    async fn drive_sweeps_never_delete_an_upload_row() {
        let store = require_db!();
        let owner = unique("owner");
        let revoked = hash_token(&unique("tok"));
        insert_upload_row(&store, &revoked, &owner, "complete").await;
        sqlx::query(
            "UPDATE folder_shares SET revoked_at = NOW(), expires_at = NOW() - INTERVAL '1 hour' \
             WHERE token_hash = $1",
        )
        .bind(&revoked)
        .execute(store.pool())
        .await
        .unwrap();

        while reap_dead_folder_shares(store.pool(), 500).await.unwrap() > 0 {}
        delete_all_for_owner(store.pool(), &owner).await.unwrap();

        let left: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM folder_shares WHERE token_hash = $1")
                .bind(&revoked)
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(left, 1, "only the upload reaper may remove an upload row");
    }

    /// A link still uploading has no expiry to change: the seal sets it.
    #[tokio::test]
    #[serial]
    async fn an_unsealed_upload_link_cannot_be_re_expired() {
        let store = require_db!();
        let owner = unique("owner");
        let token_hash = hash_token(&unique("tok"));
        insert_upload_row(&store, &token_hash, &owner, "uploading").await;
        assert!(
            update_ttl_by_hash(store.pool(), ON, &owner, &token_hash, ShareTtl::Days30)
                .await
                .unwrap()
                .is_none()
        );
    }
```

**Step 2: Run the tests and confirm they fail**

`cargo test -p hcfs-server folder_shares::db -- --test-threads=1`
Expected: compile error (`no field source on FolderShareRow`).

**Step 3: Implement**

`FolderShareDbError` (l.74). Add:

```rust
    /// A row breaks an invariant the schema cannot express (an unknown
    /// `upload_ttl` preset that slipped past the CHECK, say). Maps to 500.
    #[error("folder share row is inconsistent: {0}")]
    Inconsistent(String),
```

`FolderShareRow` (l.269) and `FolderShareOwnerRow` (l.289). Add a field to each:

```rust
    /// `folder_shares.source` (`drive` | `upload`); parse with
    /// `FolderShareSource::from_column`. A string because sqlx cannot decode
    /// into a type of another crate, and the CHECK keeps it closed.
    pub source: String,
```

Extend the pinned destructure in `recipient_row_has_no_wrap_field` (l.794) with
`source: String::new(),` in the literal and `source: _,` in the pattern.

Add a doc paragraph above `get_live_share_by_token`, and an identical one above
`list_owner_shares`:

```rust
/// Upload rows have no drive scope; `COALESCE` reads them as `""` so the
/// `String` fields, and the wire every shipped client parses as required
/// strings, keep their type.
```

`get_live_share_by_token` (l.429). Replace the SQL with:

```rust
        "SELECT token_hash, owner_ss58, COALESCE(folder_hash, '') AS folder_hash, \
                COALESCE(path_prefix, '') AS path_prefix, display_name, created_at, \
                expires_at, revoked_at, source \
         FROM folder_shares \
         WHERE token_hash = $1 \
           AND upload_state = 'complete' \
           AND revoked_at IS NULL \
           AND (expires_at IS NULL OR expires_at > NOW())",
```

`list_owner_shares` (l.461). Replace the format string with:

```rust
        "SELECT token_hash, owner_ss58, minted_by_ss58, \
                COALESCE(folder_hash, '') AS folder_hash, \
                COALESCE(path_prefix, '') AS path_prefix, \
                display_name, created_at, expires_at, revoked_at, source, {WRAP_SQL} \
         FROM folder_shares \
         WHERE {CONTROLS} AND upload_state = 'complete' \
         ORDER BY created_at DESC"
```

Also update the module doc's "## Liveness" section: "There is no `upload_state` dimension"
becomes "Drive rows are always `complete`; an upload row is live only once sealed
(`upload_state = 'complete'`)."

`update_ttl_by_hash` (l.599). Add `AND upload_state = 'complete' \` after
`AND revoked_at IS NULL \`.

`REAP_REVOKED_SQL` / `REAP_EXPIRED_SQL` (l.709/717). Add `AND source = 'drive'` inside each
subquery's `WHERE`:

```rust
const REAP_REVOKED_SQL: &str = "DELETE FROM folder_shares \
     WHERE token_hash IN ( \
         SELECT token_hash FROM folder_shares \
         WHERE revoked_at IS NOT NULL \
           AND source = 'drive' \
         FOR UPDATE SKIP LOCKED \
         LIMIT $1 \
     )";

const REAP_EXPIRED_SQL: &str = "DELETE FROM folder_shares \
     WHERE token_hash IN ( \
         SELECT token_hash FROM folder_shares \
         WHERE revoked_at IS NULL \
           AND expires_at IS NOT NULL \
           AND expires_at < NOW() \
           AND source = 'drive' \
         FOR UPDATE SKIP LOCKED \
         LIMIT $1 \
     )";
```

Put the same two literals into `reap_sql_is_pinned_to_the_partial_index_contract` (l.1353).
Add one comment line above the consts: "`source = 'drive'`: an upload row owns blobs, so only
`upload_reaper` may delete it (it reads the chunk list first)."

`delete_all_for_owner` (l.732). Change the SQL to
`"DELETE FROM folder_shares WHERE owner_ss58 = $1 AND source = 'drive'"` and extend its doc
comment: "Upload links are not deleted here: their blobs and billing go through
`upload_reaper::purge_owner_upload_shares`, which account purge calls first (Task 11)."

**Step 4: Run the tests and confirm they pass**

`cargo test -p hcfs-server folder_shares -- --test-threads=1`. Expected: PASS, including every
pre-existing folder-share test.

**Step 5: Commit**

```bash
git add hcfs-server/src/folder_shares/db.rs
git commit -m "Keep drive-only folder-share queries off uploaded-copy rows" -m "Recipients and the owner listing must not see a link still uploading,
and the metadata-only reaper and purge must never DELETE an upload row:
the cascade would drop its chunk references before anything deleted the
blobs. Upload rows read their missing drive scope as '' so every shipped
client keeps parsing the listing."
```

---

### Task 4: `upload_db`: path helpers, open, file init, chunk claim, file complete, seal, abort

**Files:**
- Modify: `hcfs-server/src/folder_shares/upload_db.rs`

#### 4a: Pure helpers

**Step 1: Write the failing tests** (in `upload_db.rs` `mod tests`)

```rust
    use super::*;

    #[test]
    fn a_path_splits_into_parent_and_name() {
        assert_eq!(split_relative_path("a.txt"), ("", "a.txt"));
        assert_eq!(split_relative_path("docs/deep/c.pdf"), ("docs/deep", "c.pdf"));
    }

    #[test]
    fn ancestors_run_shallowest_first_and_exclude_the_path() {
        assert_eq!(ancestor_dirs("a.txt"), Vec::<&str>::new());
        assert_eq!(ancestor_dirs("a/b/c.txt"), vec!["a", "a/b"]);
    }

    /// The open's directory list is closed under "parent of", so a deep
    /// empty directory still shows every folder on its way down.
    #[test]
    fn the_dir_closure_adds_every_ancestor_once() {
        let closure = dir_closure(["x/y/z", "x/w", "x/y"]);
        assert_eq!(closure, vec!["x", "x/w", "x/y", "x/y/z"]);
    }

    /// The stored preset must be the wire string, so a value written by one
    /// build parses in another.
    #[test]
    fn ttl_column_values_match_the_wire_strings() {
        for ttl in [ShareTtl::Hours24, ShareTtl::Days7, ShareTtl::Days30, ShareTtl::Never] {
            let wire = serde_json::to_string(&ttl).unwrap();
            assert_eq!(format!("\"{}\"", ttl_column(ttl)), wire);
            assert_eq!(ttl_from_column(ttl_column(ttl)), Some(ttl));
        }
        assert_eq!(ttl_from_column("48h"), None);
    }
```

**Step 2:** `cargo test -p hcfs-server folder_shares::upload_db::tests::a_path`
Expected: compile error (functions missing).

**Step 3: Implement** (top of `upload_db.rs`, after the module doc)

Extend the module doc:

```rust
//! Persistence for uploaded-copy folder links: `folder_shares` rows with
//! `source = 'upload'`, their `folder_share_files` entries, and the
//! `folder_share_chunks` that hold each file's ciphertext.
//!
//! ## Lifecycle
//!
//! open (`uploading`, quota held) → file init / chunk claim / file complete,
//! any number of times → seal (`complete`, `expires_at` set) → recipients.
//! Abort, revoke, expiry and 60 minutes without activity all end with the
//! upload reaper ([`claim_dead_upload_shares`] / [`settle_dead_upload_share`]).
//!
//! ## Locks
//!
//! Every write takes the link row `FOR UPDATE` first, then (for chunk claim
//! and file complete) the file row. One order everywhere, so the four
//! concurrent file uploads of one link serialize briefly on the link row
//! and never deadlock. No statement here waits on the network.
//!
//! ## Ownership
//!
//! Every function takes the caller and matches `owner_ss58` in SQL; a link
//! someone else owns is indistinguishable from a missing one. Upload links
//! are never delegated, so owner == minter always.
//!
//! ## Idle deadline
//!
//! A link `uploading` with `last_activity_at` older than
//! [`UPLOAD_IDLE_DEADLINE_MINUTES`] is the reaper's. Writes check the same
//! predicate under the link lock and refuse, so nothing is stored for a row
//! the next sweep deletes.

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};

use crate::folder_shares::db::FolderShareDbError;
use crate::folder_shares::types::ShareTtl;
use crate::shares::db::resolve_expiry;
use crate::utils::{hash_token, unix_now};

/// Minutes an `uploading` link may go without a request before the reaper
/// takes it. Measured from the last activity rather than from open (the
/// file-share rule), because a large folder legitimately uploads for hours.
pub const UPLOAD_IDLE_DEADLINE_MINUTES: i32 = 60;

type Tx<'c> = Transaction<'c, Postgres>;

// =============================================================================
// Path helpers
// =============================================================================

/// `(parent_dir, file_name)` of a validated relative path; a top-level
/// entry's parent is `""`, the same key the drive listing uses for root.
pub(crate) fn split_relative_path(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or(("", path))
}

/// Every proper ancestor directory of `path`, shallowest first.
pub(crate) fn ancestor_dirs(path: &str) -> Vec<&str> {
    path.match_indices('/').map(|(at, _)| &path[..at]).collect()
}

/// `dirs` closed under "parent of", sorted and deduplicated.
pub(crate) fn dir_closure<'a>(dirs: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let mut all = BTreeSet::new();
    for dir in dirs {
        all.extend(ancestor_dirs(dir));
        all.insert(dir);
    }
    all.into_iter().collect()
}

/// The listing tiebreak key, named and shaped like `file_records.path_hash`.
fn path_hash(path: &str) -> Vec<u8> {
    blake3::hash(path.as_bytes()).as_bytes().to_vec()
}

/// `folder_shares.upload_ttl` value for a preset: the wire string.
pub(crate) fn ttl_column(ttl: ShareTtl) -> &'static str {
    match ttl {
        ShareTtl::Hours24 => "24h",
        ShareTtl::Days7 => "7d",
        ShareTtl::Days30 => "30d",
        ShareTtl::Never => "never",
    }
}

/// Inverse of [`ttl_column`]; `None` for anything the CHECK would refuse.
pub(crate) fn ttl_from_column(value: &str) -> Option<ShareTtl> {
    match value {
        "24h" => Some(ShareTtl::Hours24),
        "7d" => Some(ShareTtl::Days7),
        "30d" => Some(ShareTtl::Days30),
        "never" => Some(ShareTtl::Never),
        _ => None,
    }
}
```

**Step 4:** `cargo test -p hcfs-server folder_shares::upload_db -- --test-threads=1`. Expected: PASS.

#### 4b: Open, link lock, directory rows

**Step 1: Failing test**

```rust
    use crate::folder_shares::upload_test_support::unique as unique_tag;

    async fn open_for(store: &HcfsStore, owner: &str, dirs: &[String]) -> (String, String) {
        let token = unique_tag("tok");
        let token_hash = open_upload_share(
            store.pool(),
            &NewUploadShare {
                share_token: &token,
                owner_ss58: owner,
                display_name: "Holiday",
                ttl: ShareTtl::Days7,
                file_count: 2,
                total_bytes: 100,
                dirs,
            },
        )
        .await
        .expect("open");
        (token, token_hash)
    }

    async fn dir_paths(store: &HcfsStore, token_hash: &str) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT relative_path FROM folder_share_files \
             WHERE token_hash = $1 AND kind = 'dir' ORDER BY relative_path",
        )
        .bind(token_hash)
        .fetch_all(store.pool())
        .await
        .unwrap()
    }

    #[tokio::test]
    #[serial]
    async fn open_stores_the_hash_and_every_listed_directory_with_its_ancestors() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let owner = unique_tag("owner");
        let (token, token_hash) =
            open_for(&store, &owner, &["Trips/2026/empty".to_string()]).await;

        assert_eq!(token_hash, hash_token(&token), "only the hash is stored");
        assert_eq!(dir_paths(&store, &token_hash).await, ["Trips", "Trips/2026", "Trips/2026/empty"]);
        let (state, ttl, files): (String, String, i32) = sqlx::query_as(
            "SELECT upload_state, upload_ttl, declared_file_count FROM folder_shares \
             WHERE token_hash = $1",
        )
        .bind(&token_hash)
        .fetch_one(store.pool())
        .await
        .unwrap();
        assert_eq!((state.as_str(), ttl.as_str(), files), ("uploading", "7d", 2));
    }
```

(`use crate::store::HcfsStore;` at the top of `mod tests`.)

**Step 2:** Run it and confirm it fails to compile.

**Step 3: Implement**

```rust
// =============================================================================
// Open
// =============================================================================

/// What [`open_upload_share`] writes. Bundled so the route builds it once
/// from its validated request.
#[derive(Clone, Debug)]
pub struct NewUploadShare<'a> {
    /// Plaintext token from the route's CSPRNG; only its hash is stored.
    pub share_token: &'a str,
    pub owner_ss58: &'a str,
    pub display_name: &'a str,
    /// Resolved at seal, not here: a slow upload must not shorten the link.
    pub ttl: ShareTtl,
    /// What the quota hold covers and what seal checks arrived.
    pub file_count: u32,
    pub total_bytes: u64,
    /// Empty directories to keep. Validated by the route.
    pub dirs: &'a [String],
}

/// Insert an `uploading` link and its listed directories (closed under
/// "parent of") in one transaction. Returns the stored `token_hash`.
pub async fn open_upload_share(
    pool: &PgPool,
    share: &NewUploadShare<'_>,
) -> Result<String, FolderShareDbError> {
    let token_hash = hash_token(share.share_token);
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO folder_shares \
            (token_hash, owner_ss58, minted_by_ss58, folder_hash, path_prefix, display_name, \
             source, upload_state, last_activity_at, upload_ttl, declared_file_count, \
             declared_bytes) \
         VALUES ($1, $2, $2, NULL, NULL, $3, 'upload', 'uploading', NOW(), $4, $5, $6)",
    )
    .bind(&token_hash)
    .bind(share.owner_ss58)
    .bind(share.display_name)
    .bind(ttl_column(share.ttl))
    .bind(i32::try_from(share.file_count).unwrap_or(i32::MAX))
    .bind(i64::try_from(share.total_bytes).unwrap_or(i64::MAX))
    .execute(&mut *tx)
    .await?;
    let dirs = dir_closure(share.dirs.iter().map(String::as_str));
    insert_dir_rows(&mut tx, &token_hash, &dirs).await?;
    tx.commit().await?;
    Ok(token_hash)
}

/// Insert `dirs` as complete `kind = 'dir'` rows, skipping paths already
/// present. A file already at one of these paths is the caller's to detect
/// (see [`init_upload_file`]).
async fn insert_dir_rows(
    tx: &mut Tx<'_>,
    token_hash: &str,
    dirs: &[&str],
) -> Result<(), FolderShareDbError> {
    if dirs.is_empty() {
        return Ok(());
    }
    let (parents, names): (Vec<&str>, Vec<&str>) =
        dirs.iter().map(|dir| split_relative_path(dir)).unzip();
    let hashes: Vec<Vec<u8>> = dirs.iter().map(|dir| path_hash(dir)).collect();
    let hash_refs: Vec<&[u8]> = hashes.iter().map(Vec::as_slice).collect();
    sqlx::query(
        "INSERT INTO folder_share_files \
            (token_hash, kind, relative_path, parent_dir, file_name, path_hash, \
             upload_state, created_at, updated_at) \
         SELECT $1, 'dir', v.path, v.parent, v.name, v.hash, 'complete', $6, $6 \
         FROM unnest($2::text[], $3::text[], $4::text[], $5::bytea[]) \
              AS v(path, parent, name, hash) \
         ON CONFLICT (token_hash, relative_path) DO NOTHING",
    )
    .bind(token_hash)
    .bind(dirs)
    .bind(&parents)
    .bind(&names)
    .bind(&hash_refs)
    .bind(unix_now())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

// =============================================================================
// Link lock
// =============================================================================

/// The caller's link as its row lock found it.
enum LinkLock {
    /// Still accepting files, with what open declared.
    Uploading { declared_files: i64, declared_bytes: i64 },
    /// Sealed: nothing may be added.
    Sealed,
    /// Missing, someone else's, revoked, or idle past the deadline.
    Gone,
}

/// Lock the caller's link row `FOR UPDATE` and classify it.
async fn lock_link(
    tx: &mut Tx<'_>,
    owner: &str,
    token_hash: &str,
) -> Result<LinkLock, FolderShareDbError> {
    let row: Option<(String, i32, i64, bool)> = sqlx::query_as(
        "SELECT upload_state, declared_file_count, declared_bytes, \
                (upload_state = 'uploading' \
                 AND last_activity_at < NOW() - make_interval(mins => $3)) AS idle \
         FROM folder_shares \
         WHERE token_hash = $1 AND owner_ss58 = $2 AND source = 'upload' \
           AND revoked_at IS NULL \
         FOR UPDATE",
    )
    .bind(token_hash)
    .bind(owner)
    .bind(UPLOAD_IDLE_DEADLINE_MINUTES)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(match row {
        None | Some((_, _, _, true)) => LinkLock::Gone,
        Some((state, _, _, false)) if state != "uploading" => LinkLock::Sealed,
        Some((_, files, bytes, false)) => LinkLock::Uploading {
            declared_files: i64::from(files),
            declared_bytes: bytes,
        },
    })
}

/// Record activity so the idle reaper leaves the link alone.
async fn touch_link(tx: &mut Tx<'_>, token_hash: &str) -> Result<(), FolderShareDbError> {
    sqlx::query("UPDATE folder_shares SET last_activity_at = NOW() WHERE token_hash = $1")
        .bind(token_hash)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
```

**Step 4:** Run it and confirm it passes.

#### 4c: File init

**Step 1: Failing tests**

```rust
    fn file<'a>(owner: &'a str, token_hash: &'a str, path: &'a str) -> NewUploadFile<'a> {
        NewUploadFile {
            owner_ss58: owner,
            token_hash,
            relative_path: path,
            plaintext_size: 10,
            ciphertext_size: 58,
            total_chunks: 1,
        }
    }

    #[tokio::test]
    #[serial]
    async fn file_init_creates_ancestors_and_refuses_collisions_and_strangers() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let owner = unique_tag("owner");
        let (_, token_hash) = open_for(&store, &owner, &[]).await;

        let created = init_upload_file(store.pool(), &file(&owner, &token_hash, "a/b.txt"))
            .await
            .unwrap();
        assert!(matches!(created, InitFileOutcome::Created(_)), "{created:?}");
        assert_eq!(dir_paths(&store, &token_hash).await, ["a"]);

        // Same path again; a file where a directory is; a directory under a file.
        for path in ["a/b.txt", "a", "a/b.txt/c"] {
            let outcome = init_upload_file(store.pool(), &file(&owner, &token_hash, path))
                .await
                .unwrap();
            assert!(matches!(outcome, InitFileOutcome::PathConflict), "{path}: {outcome:?}");
        }

        let stranger = unique_tag("stranger");
        let outcome = init_upload_file(store.pool(), &file(&stranger, &token_hash, "x.txt"))
            .await
            .unwrap();
        assert!(matches!(outcome, InitFileOutcome::Unavailable), "{outcome:?}");
    }

    /// Open declared 2 files / 100 bytes and the hold covers exactly that; a
    /// third file or a byte past it must not be stored unbilled.
    #[tokio::test]
    #[serial]
    async fn file_init_refuses_more_than_open_declared() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let owner = unique_tag("owner");
        let (_, token_hash) = open_for(&store, &owner, &[]).await;
        let mut big = file(&owner, &token_hash, "big.bin");
        big.plaintext_size = 101;
        let outcome = init_upload_file(store.pool(), &big).await.unwrap();
        assert!(matches!(outcome, InitFileOutcome::OverDeclared), "{outcome:?}");

        for path in ["one.txt", "two.txt"] {
            let outcome = init_upload_file(store.pool(), &file(&owner, &token_hash, path))
                .await
                .unwrap();
            assert!(matches!(outcome, InitFileOutcome::Created(_)), "{outcome:?}");
        }
        let third = init_upload_file(store.pool(), &file(&owner, &token_hash, "three.txt"))
            .await
            .unwrap();
        assert!(matches!(third, InitFileOutcome::OverDeclared), "{third:?}");
    }

    /// A link silent past the idle deadline is the reaper's: no new work.
    #[tokio::test]
    #[serial]
    async fn an_idle_link_accepts_nothing() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let owner = unique_tag("owner");
        let (_, token_hash) = open_for(&store, &owner, &[]).await;
        sqlx::query(
            "UPDATE folder_shares SET last_activity_at = NOW() - INTERVAL '2 hours' \
             WHERE token_hash = $1",
        )
        .bind(&token_hash)
        .execute(store.pool())
        .await
        .unwrap();
        let outcome = init_upload_file(store.pool(), &file(&owner, &token_hash, "a.txt"))
            .await
            .unwrap();
        assert!(matches!(outcome, InitFileOutcome::Unavailable), "{outcome:?}");
    }
```

**Step 2:** Run it and confirm it fails to compile.

**Step 3: Implement**

```rust
// =============================================================================
// File init
// =============================================================================

/// One file the client is about to upload. Sizes are validated by the route.
#[derive(Clone, Debug)]
pub struct NewUploadFile<'a> {
    pub owner_ss58: &'a str,
    pub token_hash: &'a str,
    pub relative_path: &'a str,
    pub plaintext_size: i64,
    pub ciphertext_size: i64,
    pub total_chunks: i32,
}

/// [`init_upload_file`] outcome.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InitFileOutcome {
    Created(i64),
    /// Missing, someone else's, revoked, or idle.
    Unavailable,
    Sealed,
    /// The path, or one of its ancestors, is already taken by an entry of
    /// the other kind (or the same file twice).
    PathConflict,
    /// The file would take the link past what open declared and held.
    OverDeclared,
}

/// Declare one file: its ancestors become directory rows, and the file row
/// starts `uploading`. Everything under the link lock, so the declared
/// budget check and the inserts cannot interleave with a sibling file's.
pub async fn init_upload_file(
    pool: &PgPool,
    file: &NewUploadFile<'_>,
) -> Result<InitFileOutcome, FolderShareDbError> {
    let mut tx = pool.begin().await?;
    let (declared_files, declared_bytes) =
        match lock_link(&mut tx, file.owner_ss58, file.token_hash).await? {
            LinkLock::Gone => return Ok(InitFileOutcome::Unavailable),
            LinkLock::Sealed => return Ok(InitFileOutcome::Sealed),
            LinkLock::Uploading { declared_files, declared_bytes } => {
                (declared_files, declared_bytes)
            }
        };
    let (files, bytes): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*)::BIGINT, COALESCE(SUM(size_bytes), 0)::BIGINT \
         FROM folder_share_files WHERE token_hash = $1 AND kind = 'file'",
    )
    .bind(file.token_hash)
    .fetch_one(&mut *tx)
    .await?;
    if files + 1 > declared_files || bytes.saturating_add(file.plaintext_size) > declared_bytes {
        return Ok(InitFileOutcome::OverDeclared);
    }

    let ancestors = ancestor_dirs(file.relative_path);
    insert_dir_rows(&mut tx, file.token_hash, &ancestors).await?;
    if a_file_occupies(&mut tx, file.token_hash, &ancestors).await? {
        return Ok(InitFileOutcome::PathConflict);
    }
    let Some(file_id) = insert_file_row(&mut tx, file).await? else {
        return Ok(InitFileOutcome::PathConflict);
    };
    touch_link(&mut tx, file.token_hash).await?;
    tx.commit().await?;
    Ok(InitFileOutcome::Created(file_id))
}

/// Whether any of `paths` is already a file of this link: a file cannot
/// also be a directory on another file's way down.
async fn a_file_occupies(
    tx: &mut Tx<'_>,
    token_hash: &str,
    paths: &[&str],
) -> Result<bool, FolderShareDbError> {
    if paths.is_empty() {
        return Ok(false);
    }
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM folder_share_files \
                        WHERE token_hash = $1 AND kind = 'file' \
                          AND relative_path = ANY($2::text[]))",
    )
    .bind(token_hash)
    .bind(paths)
    .fetch_one(&mut **tx)
    .await?;
    Ok(taken)
}

/// Insert the file row; `None` when its path is already taken (by the same
/// file twice, or by a directory: the unique key covers both kinds).
async fn insert_file_row(
    tx: &mut Tx<'_>,
    file: &NewUploadFile<'_>,
) -> Result<Option<i64>, FolderShareDbError> {
    let (parent, name) = split_relative_path(file.relative_path);
    let file_id = sqlx::query_scalar(
        "INSERT INTO folder_share_files \
            (token_hash, kind, relative_path, parent_dir, file_name, path_hash, size_bytes, \
             ciphertext_size, total_chunks, upload_state, created_at, updated_at) \
         VALUES ($1, 'file', $2, $3, $4, $5, $6, $7, $8, 'uploading', $9, $9) \
         ON CONFLICT (token_hash, relative_path) DO NOTHING \
         RETURNING file_id",
    )
    .bind(file.token_hash)
    .bind(file.relative_path)
    .bind(parent)
    .bind(name)
    .bind(path_hash(file.relative_path))
    .bind(file.plaintext_size)
    .bind(file.ciphertext_size)
    .bind(file.total_chunks)
    .bind(unix_now())
    .fetch_optional(&mut **tx)
    .await?;
    Ok(file_id)
}
```

`a/b.txt/c` conflicts because its ancestor `a/b.txt` is a file. `a` conflicts because the
directory row `a` already holds the path, so the INSERT's `ON CONFLICT` returns no row.

**Step 4:** Run it and confirm it passes.

#### 4d: Chunk claim, unclaim, still-named check

**Step 1: Failing test**

```rust
    async fn one_file(store: &HcfsStore, owner: &str) -> (String, i64) {
        let (_, token_hash) = open_for(store, owner, &[]).await;
        let mut f = file(owner, &token_hash, "a.bin");
        f.ciphertext_size = 10;
        f.total_chunks = 2;
        let InitFileOutcome::Created(file_id) = init_upload_file(store.pool(), &f).await.unwrap()
        else {
            panic!("file init must succeed");
        };
        (token_hash, file_id)
    }

    fn chunk<'a>(owner: &'a str, token_hash: &'a str, file_id: i64, at: (i32, &'a str, i64)) -> UploadChunk<'a> {
        UploadChunk {
            owner_ss58: owner,
            token_hash,
            file_id,
            chunk_index: at.0,
            chunk_hash: at.1,
            chunk_size: at.2,
        }
    }

    /// Claim `(index, hash, size)` for the owner's file.
    async fn claim_at(store: &HcfsStore, owner: &str, token_hash: &str, file_id: i64, at: (i32, &str, i64)) -> UploadChunkClaim {
        claim_upload_chunk(store.pool(), &chunk(owner, token_hash, file_id, at))
            .await
            .unwrap()
    }

    #[tokio::test]
    #[serial]
    async fn chunk_claims_are_idempotent_bounded_and_owner_scoped() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let owner = unique_tag("owner");
        let (token_hash, file_id) = one_file(&store, &owner).await;
        let h0 = unique_tag("h0");
        let (o, t) = (owner.as_str(), token_hash.as_str());

        assert_eq!(claim_at(&store, o, t, file_id, (0, &h0, 6)).await, UploadChunkClaim::Inserted);
        assert_eq!(claim_at(&store, o, t, file_id, (0, &h0, 6)).await, UploadChunkClaim::Idempotent);
        assert_eq!(claim_at(&store, o, t, file_id, (0, "other", 6)).await, UploadChunkClaim::Conflict);
        assert_eq!(
            claim_at(&store, o, t, file_id, (2, "x", 1)).await,
            UploadChunkClaim::OutOfRange { total_chunks: 2 }
        );
        assert_eq!(
            claim_at(&store, o, t, file_id, (1, "x", 5)).await,
            UploadChunkClaim::ExceedsDeclaredSize { claimed: 6, declared: 10 }
        );
        let stranger = unique_tag("stranger");
        let foreign = claim_upload_chunk(
            store.pool(),
            &chunk(&stranger, &token_hash, file_id, (1, "x", 4)),
        )
        .await
        .unwrap();
        assert_eq!(foreign, UploadChunkClaim::Unavailable);

        let named = chunk(&owner, &token_hash, file_id, (0, &h0, 6));
        assert!(upload_chunk_still_named(store.pool(), &named).await.unwrap());
        unclaim_upload_chunk(store.pool(), &named).await.unwrap();
        assert!(!upload_chunk_still_named(store.pool(), &named).await.unwrap());
    }
```

**Step 2:** Run it and confirm it fails to compile.

**Step 3: Implement**

```rust
// =============================================================================
// Chunks
// =============================================================================

/// One chunk PUT. `chunk_hash` is the BLAKE3 the route computed over the body.
#[derive(Clone, Copy, Debug)]
pub struct UploadChunk<'a> {
    pub owner_ss58: &'a str,
    pub token_hash: &'a str,
    pub file_id: i64,
    pub chunk_index: i32,
    pub chunk_hash: &'a str,
    pub chunk_size: i64,
}

/// [`claim_upload_chunk`] outcome; same meanings as `shares::db::ChunkClaim`,
/// plus the index bound this table checks itself.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UploadChunkClaim {
    /// Slot taken for this hash: store the bytes, unclaim on failure.
    Inserted,
    /// The same bytes already landed: answer success, store nothing.
    Idempotent,
    /// Different bytes already hold this slot.
    Conflict,
    OutOfRange { total_chunks: i32 },
    /// This chunk would take the file past its declared ciphertext size.
    ExceedsDeclaredSize { claimed: i64, declared: i64 },
    /// Link or file missing, someone else's, revoked, or idle.
    Unavailable,
    /// The file (or the whole link) is complete.
    NotAccepting,
}

#[derive(sqlx::FromRow)]
struct LockedFile {
    upload_state: String,
    ciphertext_size: i64,
    total_chunks: i32,
}

/// Lock one file row of the link `FOR UPDATE`, after the link row.
async fn lock_file(
    tx: &mut Tx<'_>,
    token_hash: &str,
    file_id: i64,
) -> Result<Option<LockedFile>, FolderShareDbError> {
    let file = sqlx::query_as::<_, LockedFile>(
        "SELECT upload_state, ciphertext_size, total_chunks FROM folder_share_files \
         WHERE file_id = $1 AND token_hash = $2 AND kind = 'file' \
         FOR UPDATE",
    )
    .bind(file_id)
    .bind(token_hash)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(file)
}

/// Claim a chunk slot before its bytes are stored, so storage never holds
/// bytes no row will name (the file-share rule, `shares::db::claim_chunk`).
/// The per-file byte budget stops a file storing more than its declared
/// ciphertext, which is what the open's quota hold was sized from.
pub async fn claim_upload_chunk(
    pool: &PgPool,
    chunk: &UploadChunk<'_>,
) -> Result<UploadChunkClaim, FolderShareDbError> {
    let mut tx = pool.begin().await?;
    match lock_link(&mut tx, chunk.owner_ss58, chunk.token_hash).await? {
        LinkLock::Gone => return Ok(UploadChunkClaim::Unavailable),
        LinkLock::Sealed => return Ok(UploadChunkClaim::NotAccepting),
        LinkLock::Uploading { .. } => {}
    }
    let Some(file) = lock_file(&mut tx, chunk.token_hash, chunk.file_id).await? else {
        return Ok(UploadChunkClaim::Unavailable);
    };
    if file.upload_state != "uploading" {
        return Ok(UploadChunkClaim::NotAccepting);
    }
    if chunk.chunk_index >= file.total_chunks {
        return Ok(UploadChunkClaim::OutOfRange {
            total_chunks: file.total_chunks,
        });
    }
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT chunk_hash FROM folder_share_chunks WHERE file_id = $1 AND chunk_index = $2",
    )
    .bind(chunk.file_id)
    .bind(chunk.chunk_index)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(existing) = existing {
        return Ok(if existing == chunk.chunk_hash {
            UploadChunkClaim::Idempotent
        } else {
            UploadChunkClaim::Conflict
        });
    }
    let claimed: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(chunk_size), 0)::BIGINT FROM folder_share_chunks WHERE file_id = $1",
    )
    .bind(chunk.file_id)
    .fetch_one(&mut *tx)
    .await?;
    if claimed.saturating_add(chunk.chunk_size) > file.ciphertext_size {
        return Ok(UploadChunkClaim::ExceedsDeclaredSize {
            claimed,
            declared: file.ciphertext_size,
        });
    }
    // The file lock serializes claims for this file, so the slot is free.
    sqlx::query(
        "INSERT INTO folder_share_chunks (file_id, chunk_index, chunk_hash, chunk_size) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(chunk.file_id)
    .bind(chunk.chunk_index)
    .bind(chunk.chunk_hash)
    .bind(chunk.chunk_size)
    .execute(&mut *tx)
    .await?;
    touch_link(&mut tx, chunk.token_hash).await?;
    tx.commit().await?;
    Ok(UploadChunkClaim::Inserted)
}

/// Release a claim whose storage write failed, so a retry can take the
/// slot. Hash-scoped, like `shares::db::unclaim_chunk`.
pub async fn unclaim_upload_chunk(
    pool: &PgPool,
    chunk: &UploadChunk<'_>,
) -> Result<(), FolderShareDbError> {
    sqlx::query(
        "DELETE FROM folder_share_chunks \
         WHERE file_id = $1 AND chunk_index = $2 AND chunk_hash = $3",
    )
    .bind(chunk.file_id)
    .bind(chunk.chunk_index)
    .bind(chunk.chunk_hash)
    .execute(pool)
    .await?;
    Ok(())
}

/// Whether the claim for a chunk still exists after its storage write. A
/// plain SELECT, so it runs on the read pool. `false` only when the link was
/// reaped while the bytes were in flight (the claim cascaded away).
pub async fn upload_chunk_still_named(
    pool: &PgPool,
    chunk: &UploadChunk<'_>,
) -> Result<bool, FolderShareDbError> {
    let named: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM folder_share_chunks \
                        WHERE file_id = $1 AND chunk_index = $2 AND chunk_hash = $3)",
    )
    .bind(chunk.file_id)
    .bind(chunk.chunk_index)
    .bind(chunk.chunk_hash)
    .fetch_one(pool)
    .await?;
    Ok(named)
}
```

**Step 4:** Run it and confirm it passes.

#### 4e: File complete

**Step 1: Failing test**

```rust
    #[tokio::test]
    #[serial]
    async fn a_file_completes_only_with_every_declared_byte() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let owner = unique_tag("owner");
        let (token_hash, file_id) = one_file(&store, &owner).await;
        claim_at(&store, &owner, &token_hash, file_id, (0, "c0", 6)).await;

        let early = complete_upload_file(store.pool(), &owner, &token_hash, file_id).await.unwrap();
        assert_eq!(
            early,
            CompleteFileOutcome::Incomplete { received_chunks: 1, total_chunks: 2, received_bytes: 6, declared_bytes: 10 }
        );
        claim_at(&store, &owner, &token_hash, file_id, (1, "c1", 4)).await;
        let done = complete_upload_file(store.pool(), &owner, &token_hash, file_id).await.unwrap();
        assert_eq!(done, CompleteFileOutcome::Completed);
        let again = complete_upload_file(store.pool(), &owner, &token_hash, file_id).await.unwrap();
        assert_eq!(again, CompleteFileOutcome::AlreadyComplete);
        assert_eq!(
            claim_at(&store, &owner, &token_hash, file_id, (1, "c1", 4)).await,
            UploadChunkClaim::NotAccepting
        );
    }
```

**Step 2:** Run it and confirm it fails to compile.

**Step 3: Implement**

```rust
// =============================================================================
// File complete
// =============================================================================

/// [`complete_upload_file`] outcome.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompleteFileOutcome {
    Completed,
    /// A retry after a lost response: nothing to do.
    AlreadyComplete,
    Unavailable,
    Sealed,
    Incomplete {
        received_chunks: i64,
        total_chunks: i32,
        received_bytes: i64,
        declared_bytes: i64,
    },
}

/// Mark a file complete once every declared chunk and byte has arrived.
/// Claims bound each index below `total_chunks` and the primary key makes
/// indices unique, so a full count is a contiguous `0..N`.
pub async fn complete_upload_file(
    pool: &PgPool,
    owner: &str,
    token_hash: &str,
    file_id: i64,
) -> Result<CompleteFileOutcome, FolderShareDbError> {
    let mut tx = pool.begin().await?;
    match lock_link(&mut tx, owner, token_hash).await? {
        LinkLock::Gone => return Ok(CompleteFileOutcome::Unavailable),
        LinkLock::Sealed => return Ok(CompleteFileOutcome::Sealed),
        LinkLock::Uploading { .. } => {}
    }
    let Some(file) = lock_file(&mut tx, token_hash, file_id).await? else {
        return Ok(CompleteFileOutcome::Unavailable);
    };
    if file.upload_state == "complete" {
        return Ok(CompleteFileOutcome::AlreadyComplete);
    }
    let (chunks, bytes): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*)::BIGINT, COALESCE(SUM(chunk_size), 0)::BIGINT \
         FROM folder_share_chunks WHERE file_id = $1",
    )
    .bind(file_id)
    .fetch_one(&mut *tx)
    .await?;
    if chunks != i64::from(file.total_chunks) || bytes != file.ciphertext_size {
        return Ok(CompleteFileOutcome::Incomplete {
            received_chunks: chunks,
            total_chunks: file.total_chunks,
            received_bytes: bytes,
            declared_bytes: file.ciphertext_size,
        });
    }
    sqlx::query(
        "UPDATE folder_share_files SET upload_state = 'complete', updated_at = $2 \
         WHERE file_id = $1",
    )
    .bind(file_id)
    .bind(unix_now())
    .execute(&mut *tx)
    .await?;
    touch_link(&mut tx, token_hash).await?;
    tx.commit().await?;
    Ok(CompleteFileOutcome::Completed)
}
```

**Step 4:** Run it and confirm it passes.

#### 4f: Seal preflight, seal, abort, recipient chunk lookup

**Step 1: Failing tests**

```rust
    /// Upload one declared file of `one_file`'s link fully.
    async fn finish_file(store: &HcfsStore, owner: &str, token_hash: &str, file_id: i64) {
        for at in [(0, "c0", 6), (1, "c1", 4)] {
            claim_at(store, owner, token_hash, file_id, at).await;
        }
        complete_upload_file(store.pool(), owner, token_hash, file_id).await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn seal_needs_every_declared_file_then_is_idempotent() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let owner = unique_tag("owner");
        let (token_hash, file_id) = one_file(&store, &owner).await;
        finish_file(&store, &owner, &token_hash, file_id).await;

        // Open declared 2 files / 100 bytes; only 1 file / 10 bytes arrived.
        let missing = seal_upload_share(store.pool(), &owner, &token_hash).await.unwrap();
        assert_eq!(
            missing,
            SealOutcome::Missing { complete_files: 1, declared_files: 2, complete_bytes: 10, declared_bytes: 100 }
        );

        sqlx::query(
            "UPDATE folder_shares SET declared_file_count = 1, declared_bytes = 10 \
             WHERE token_hash = $1",
        )
        .bind(&token_hash)
        .execute(store.pool())
        .await
        .unwrap();
        let before = Utc::now();
        let SealOutcome::Sealed { expires_at, newly_sealed: true, files: 1, bytes: 10 } =
            seal_upload_share(store.pool(), &owner, &token_hash).await.unwrap()
        else {
            panic!("the first complete seal is new");
        };
        let expires_at = expires_at.expect("7d preset expires");
        assert!(expires_at > before + chrono::Duration::days(6), "expiry runs from seal");

        let again = seal_upload_share(store.pool(), &owner, &token_hash).await.unwrap();
        assert_eq!(
            again,
            SealOutcome::Sealed { expires_at: Some(expires_at), newly_sealed: false, files: 1, bytes: 10 }
        );
        assert_eq!(seal_preflight(store.pool(), &owner, &token_hash).await.unwrap(), Some((10, true)));
        let chunks = upload_file_chunks(store.pool(), &token_hash, "a.bin").await.unwrap();
        assert_eq!(chunks, vec![("c0".to_string(), 6), ("c1".to_string(), 4)]);
        assert!(!abort_upload_share(store.pool(), &owner, &token_hash).await.unwrap(), "sealed links are revoked, not aborted");
    }

    #[tokio::test]
    #[serial]
    async fn abort_revokes_an_uploading_link_once_and_only_for_its_owner() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let owner = unique_tag("owner");
        let (_, token_hash) = open_for(&store, &owner, &[]).await;
        assert!(!abort_upload_share(store.pool(), &unique_tag("x"), &token_hash).await.unwrap());
        assert!(abort_upload_share(store.pool(), &owner, &token_hash).await.unwrap());
        assert!(!abort_upload_share(store.pool(), &owner, &token_hash).await.unwrap());
        assert_eq!(seal_preflight(store.pool(), &owner, &token_hash).await.unwrap(), None);
    }
```

**Step 2:** Run it and confirm it fails to compile.

**Step 3: Implement**

```rust
// =============================================================================
// Seal, abort
// =============================================================================

/// [`seal_upload_share`] outcome.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SealOutcome {
    /// Live. `newly_sealed` is false for a retried seal: the route counts
    /// usage only on the call that sealed, or a retry would bill twice.
    /// `files` / `bytes` are what the link holds (equal to the declaration).
    Sealed {
        expires_at: Option<DateTime<Utc>>,
        newly_sealed: bool,
        files: i64,
        bytes: i64,
    },
    Unavailable,
    /// Some declared file has not completed (or an undeclared one is open).
    Missing {
        complete_files: i64,
        declared_files: i64,
        complete_bytes: i64,
        declared_bytes: i64,
    },
}

/// `(declared_bytes, sealed)` for the caller's live link, or `None`. The
/// seal route reads it before touching the quota hold, so a retried seal
/// never takes a fresh hold that nothing would settle.
pub async fn seal_preflight(
    pool: &PgPool,
    owner: &str,
    token_hash: &str,
) -> Result<Option<(i64, bool)>, FolderShareDbError> {
    let row = sqlx::query_as(
        "SELECT declared_bytes, upload_state = 'complete' FROM folder_shares \
         WHERE token_hash = $1 AND owner_ss58 = $2 AND source = 'upload' \
           AND revoked_at IS NULL",
    )
    .bind(token_hash)
    .bind(owner)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

#[derive(sqlx::FromRow)]
struct SealLock {
    upload_state: String,
    upload_ttl: String,
    expires_at: Option<DateTime<Utc>>,
    declared_file_count: i32,
    declared_bytes: i64,
    idle: bool,
}

/// Seal: every declared file complete, nothing else open; then the link
/// goes live and `expires_at` is resolved from the open's preset against
/// the server clock NOW, so a slow upload does not shorten the link.
pub async fn seal_upload_share(
    pool: &PgPool,
    owner: &str,
    token_hash: &str,
) -> Result<SealOutcome, FolderShareDbError> {
    let mut tx = pool.begin().await?;
    let row: Option<SealLock> = sqlx::query_as(
        "SELECT upload_state, upload_ttl, expires_at, declared_file_count, declared_bytes, \
                (upload_state = 'uploading' \
                 AND last_activity_at < NOW() - make_interval(mins => $3)) AS idle \
         FROM folder_shares \
         WHERE token_hash = $1 AND owner_ss58 = $2 AND source = 'upload' \
           AND revoked_at IS NULL \
         FOR UPDATE",
    )
    .bind(token_hash)
    .bind(owner)
    .bind(UPLOAD_IDLE_DEADLINE_MINUTES)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(link) = row.filter(|link| !link.idle) else {
        return Ok(SealOutcome::Unavailable);
    };
    let declared_files = i64::from(link.declared_file_count);
    if link.upload_state == "complete" {
        return Ok(SealOutcome::Sealed {
            expires_at: link.expires_at,
            newly_sealed: false,
            files: declared_files,
            bytes: link.declared_bytes,
        });
    }
    let (complete_files, complete_bytes, all_files): (i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*) FILTER (WHERE upload_state = 'complete')::BIGINT, \
                COALESCE(SUM(size_bytes) FILTER (WHERE upload_state = 'complete'), 0)::BIGINT, \
                COUNT(*)::BIGINT \
         FROM folder_share_files WHERE token_hash = $1 AND kind = 'file'",
    )
    .bind(token_hash)
    .fetch_one(&mut *tx)
    .await?;
    if complete_files != declared_files
        || complete_bytes != link.declared_bytes
        || all_files != complete_files
    {
        return Ok(SealOutcome::Missing {
            complete_files,
            declared_files,
            complete_bytes,
            declared_bytes: link.declared_bytes,
        });
    }
    let ttl = ttl_from_column(&link.upload_ttl).ok_or_else(|| {
        FolderShareDbError::Inconsistent(format!("unknown upload_ttl {:?}", link.upload_ttl))
    })?;
    let expires_at: Option<DateTime<Utc>> = sqlx::query_scalar(
        "UPDATE folder_shares \
         SET upload_state = 'complete', expires_at = $2, last_activity_at = NOW() \
         WHERE token_hash = $1 \
         RETURNING expires_at",
    )
    .bind(token_hash)
    .bind(resolve_expiry(ttl, Utc::now()))
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(SealOutcome::Sealed {
        expires_at,
        newly_sealed: true,
        files: complete_files,
        bytes: complete_bytes,
    })
}

/// Abort a link that is still uploading: revoked now, reaped (storage,
/// hold) on the next sweep. `false` for anything else, sealed included.
pub async fn abort_upload_share(
    pool: &PgPool,
    owner: &str,
    token_hash: &str,
) -> Result<bool, FolderShareDbError> {
    let rows = sqlx::query(
        "UPDATE folder_shares SET revoked_at = NOW() \
         WHERE token_hash = $1 AND owner_ss58 = $2 AND source = 'upload' \
           AND upload_state = 'uploading' AND revoked_at IS NULL",
    )
    .bind(token_hash)
    .bind(owner)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(rows > 0)
}

/// `(chunk_hash, chunk_size)` of one complete file, in order, for the
/// recipient blob route. Empty when the path names no complete file (every
/// complete file has at least one chunk). Pass the read pool.
pub async fn upload_file_chunks(
    pool: &PgPool,
    token_hash: &str,
    relative_path: &str,
) -> Result<Vec<(String, i64)>, FolderShareDbError> {
    let chunks = sqlx::query_as(
        "SELECT c.chunk_hash, c.chunk_size \
         FROM folder_share_files f \
         JOIN folder_share_chunks c ON c.file_id = f.file_id \
         WHERE f.token_hash = $1 AND f.relative_path = $2 \
           AND f.kind = 'file' AND f.upload_state = 'complete' \
         ORDER BY c.chunk_index",
    )
    .bind(token_hash)
    .bind(relative_path)
    .fetch_all(pool)
    .await?;
    Ok(chunks)
}
```

**Step 4:** `cargo test -p hcfs-server folder_shares::upload_db -- --test-threads=1`. Expected: PASS.

**Step 5: Commit**

```bash
git add hcfs-server/src/folder_shares/upload_db.rs
git commit -m "Persist uploaded-copy folder links: open, files, chunks, seal" -m "Writes lock the link row then the file row, check the 60-minute idle
deadline under that lock, and claim chunk slots before storage sees a
byte, so nothing is stored that no row names. Seal refuses a link with
any declared file missing and resolves the expiry from the open's preset
at seal time, so a slow upload does not shorten the link."
```

---

### Task 5: Error variants and wire types for the upload routes

**Files:**
- Modify: `hcfs-server/src/folder_shares/errors.rs` (enum at l.31, `IntoResponse` at l.73,
  module doc l.15-16)
- Modify: `hcfs-server/src/folder_shares/types.rs` (append types; the list item is in
  Task 10)
- Modify: `hcfs-server/src/http/handlers/helpers.rs` (`QuotaHold`, after `for_share` at l.256)

**Step 1: Failing tests**

In `errors.rs` `mod tests`:

```rust
    /// Owner upload routes branch on these: a conflict (sealed link, taken
    /// path, missing files) is not retryable and must not look like a 400.
    #[tokio::test]
    async fn conflict_and_too_large_render_their_own_statuses() {
        let response = FolderShareError::Conflict("link is sealed".into()).into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = axum::body::to_bytes(response.into_body(), 1024).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["error"], "conflict");
        assert_eq!(parsed["message"], "link is sealed");

        let response = FolderShareError::PayloadTooLarge.into_response();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
```

In `types.rs` `mod tests`:

```rust
    /// The desktop client sends and parses these exact keys; the client's
    /// own pins (hcfs-client `folder_share::upload`) hold the same literals.
    #[test]
    fn upload_open_request_field_names_are_stable() {
        let parsed: OpenUploadFolderShareRequest = serde_json::from_value(json!({
            "display_name": "Holiday",
            "ttl": "7d",
            "file_count": 2,
            "total_bytes": 100,
            "dirs": ["Empty"],
        }))
        .unwrap();
        assert_eq!(parsed.display_name, "Holiday");
        assert_eq!(parsed.ttl, ShareTtl::Days7);
        assert_eq!((parsed.file_count, parsed.total_bytes), (2, 100));
        assert_eq!(parsed.dirs, ["Empty"]);

        let minimal: OpenUploadFolderShareRequest = serde_json::from_value(json!({
            "display_name": "x", "file_count": 1, "total_bytes": 0,
        }))
        .unwrap();
        assert_eq!(minimal.ttl, ShareTtl::Hours24);
        assert!(minimal.dirs.is_empty());
    }

    #[test]
    fn upload_responses_and_file_request_field_names_are_stable() {
        assert_eq!(
            serde_json::to_value(OpenUploadFolderShareResponse {
                share_token: "tok".into(),
                token_hash: "ab".repeat(32),
            })
            .unwrap(),
            json!({ "share_token": "tok", "token_hash": "ab".repeat(32) }),
        );
        assert_eq!(
            serde_json::to_value(InitUploadFileResponse { file_id: 7 }).unwrap(),
            json!({ "file_id": 7 }),
        );
        assert_eq!(
            serde_json::to_value(SealUploadFolderShareResponse { expires_at: None }).unwrap(),
            json!({ "expires_at": null }),
        );
        let file: InitUploadFileRequest = serde_json::from_value(json!({
            "relative_path": "a/b.txt",
            "plaintext_size": 5,
            "ciphertext_size": 53,
            "total_chunks": 1,
        }))
        .unwrap();
        assert_eq!(file.relative_path, "a/b.txt");
        assert_eq!((file.plaintext_size, file.ciphertext_size, file.total_chunks), (5, 53, 1));
    }
```

In `helpers.rs`, inside the existing `#[cfg(test)] mod tests` (or add one at the file end
if it has none):

```rust
    /// The hold id is how seal finds open's hold and how abort and the reaper
    /// release it; it must not collide with a file share's `share:` ids.
    #[test]
    fn folder_share_upload_holds_have_their_own_namespace() {
        let hold = QuotaHold::for_folder_share_upload("abc", 10);
        assert_eq!(hold.id(), "folder-share-upload:abc");
        assert_ne!(hold.id(), QuotaHold::for_share("abc", 10).id());
    }
```

**Step 2:** `cargo test -p hcfs-server folder_shares::errors folder_shares::types folder_share_upload_holds`
Expected: compile errors.

**Step 3: Implement**

`errors.rs`. Replace module-doc lines 15-16 ("Folder shares have no upload path, so there is no
`PayloadTooLarge` here.") with: "Uploaded-copy links add `Conflict` (409) and
`PayloadTooLarge` (413), owner-route only." Then add the variants after `BadRequest`:

```rust
    /// Owner upload routes: the request is well-formed but the link's state
    /// refuses it (sealed, path taken, declared files missing). Not retryable.
    #[error("conflict: {0}")]
    Conflict(String),

    /// A chunk body over the 8 MiB cap, or a file over the per-file cap.
    #[error("payload too large")]
    PayloadTooLarge,
```

Add these arms to `into_response`:

```rust
            FolderShareError::Conflict(msg) => (
                StatusCode::CONFLICT,
                Json(ErrorBody {
                    error: "conflict",
                    message: &msg,
                }),
            )
                .into_response(),

            FolderShareError::PayloadTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(ErrorBody {
                    error: "payload_too_large",
                    message: "chunk or file exceeds the upload size cap",
                }),
            )
                .into_response(),
```

`types.rs`. Append before `#[cfg(test)]`:

```rust
// =============================================================================
// Uploaded-copy links (`/v1/folder-shares/uploads`)
// =============================================================================

/// Body of `POST /v1/folder-shares/uploads`: everything the link will hold,
/// declared up front so the quota hold covers it and seal can prove it all
/// arrived.
#[derive(Clone, Debug, Deserialize)]
pub struct OpenUploadFolderShareRequest {
    /// Plaintext folder name for the recipient header (same rule and cap as
    /// [`CreateFolderShareRequest::display_name`]).
    pub display_name: String,
    /// Resolved at SEAL, not here. Absent means 24h, as everywhere.
    #[serde(default)]
    pub ttl: ShareTtl,
    pub file_count: u32,
    /// Sum of every file's plaintext size: what the quota hold holds.
    pub total_bytes: u64,
    /// Directories with no file beneath them; the rest are implied by file
    /// paths. Absent means none.
    #[serde(default)]
    pub dirs: Vec<String>,
}

/// Response of the open. `share_token` is the plaintext capability and
/// this is the only time it exists outside the client; every later owner
/// route is addressed by `token_hash`.
#[derive(Clone, Debug, Serialize)]
pub struct OpenUploadFolderShareResponse {
    pub share_token: String,
    pub token_hash: String,
}

/// Body of `POST /v1/folder-shares/uploads/{token_hash}/files`.
#[derive(Clone, Debug, Deserialize)]
pub struct InitUploadFileRequest {
    /// Link-relative path, validated like every stored `relative_path`.
    pub relative_path: String,
    pub plaintext_size: u64,
    /// Exact length of the encrypted file the chunks will add up to.
    pub ciphertext_size: u64,
    pub total_chunks: u32,
}

/// Response of a file init: the id the chunk and complete routes address.
#[derive(Clone, Debug, Serialize)]
pub struct InitUploadFileResponse {
    pub file_id: i64,
}

/// Response of a seal. RFC 3339; `null` for a never-expiring link.
#[derive(Clone, Debug, Serialize)]
pub struct SealUploadFolderShareResponse {
    pub expires_at: Option<String>,
}
```

`helpers.rs`. In `impl QuotaHold`, after `for_share` (l.256):

```rust
    /// An uploaded-copy folder link, open to seal; seal settles it by the
    /// same id, abort and the reaper release it. Keyed by the token HASH:
    /// a quota_reservations row must never hold a live capability.
    pub fn for_folder_share_upload(token_hash: &str, expires_at: i64) -> Self {
        Self {
            id: format!("folder-share-upload:{token_hash}"),
            expires_at: expires_at.max(unix_now() + MIN_HOLD_SECS),
            supersedes: None,
        }
    }
```

Check how `for_share` applies `MIN_HOLD_SECS` (l.256-264) and copy its exact clamp
expression. The intent is "never shorter than the minimum".

**Step 4:** Run the same three test filters. Expected: PASS.

**Step 5: Commit**

```bash
git add hcfs-server/src/folder_shares/errors.rs hcfs-server/src/folder_shares/types.rs \
  hcfs-server/src/http/handlers/helpers.rs
git commit -m "Add wire types, errors and quota hold for folder link uploads" -m "Pins the exact JSON keys the hcfs-client upload path sends and reads,
gives a sealed link / taken path its own 409 instead of a generic 400,
and gives the open-to-seal quota hold an id namespace of its own so seal,
abort and the reaper can find it."
```

---

### Task 6: Owner upload routes

**Files:**
- Create: `hcfs-server/src/folder_shares/upload_routes.rs`
- Modify: `hcfs-server/src/folder_shares/mod.rs` (add `pub mod upload_routes;` and update the
  module docs to list it)
- Modify: `hcfs-server/src/folder_shares/routes.rs`:
  - `router()` (l.138): add `.merge(crate::folder_shares::upload_routes::router())`
  - `authenticate_owner` (l.941), `enforce_folder_share_owner` (l.955),
    `validate_display_name` (l.1249), `generate_folder_share_token` (l.1267): change `fn` to
    `pub(super) fn`
- Modify: `hcfs-server/src/http/route_catalog.rs` (6 rows after
  `PATCH /v1/folder-shares/by-hash/{token_hash}`)
- Modify: `hcfs-server/src/http/middleware.rs` (`route_label` arms before l.143, and
  `loggable_path` before the generic loop at l.219)
- Modify: `hcfs-server/tests/router_oneshot.rs` (`owner_write_requests` l.7962; new tests
  section)
- Modify: `hcfs-server/tests/shared_drives_lifecycle.rs` (`GRANT_MATRIX_EXCLUDED`
  l.10034)

**Step 1: Write the failing route tests** (`tests/router_oneshot.rs`, a new section near
the other folder-share tests, around l.9890)

```rust
// =============================================================================
// Uploaded-copy folder links (`/v1/folder-shares/uploads`)
// =============================================================================

/// Well-formed hash naming no row: the account guard answers first.
const MATRIX_TOKEN_HASH: &str =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn upload_open_body(files: u32, bytes: u64, dirs: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "display_name": "Holiday",
        "ttl": "7d",
        "file_count": files,
        "total_bytes": bytes,
        "dirs": dirs,
    })
}

/// One-chunk file whose ciphertext is exactly `MOCK_CIPHERTEXT`, so the
/// Arion mock serves back what was "stored" when the blob is read.
fn upload_file_body(path: &str, plaintext: u64) -> serde_json::Value {
    serde_json::json!({
        "relative_path": path,
        "plaintext_size": plaintext,
        "ciphertext_size": MOCK_CIPHERTEXT.len(),
        "total_chunks": 1,
    })
}

fn uploads_path(token_hash: &str, rest: &str) -> String {
    format!("/v1/folder-shares/uploads/{token_hash}{rest}")
}

fn upload_chunk_request(ss58: &str, token_hash: &str, file_id: i64, body: &[u8]) -> Request<Body> {
    Request::builder()
        .method(Method::PUT)
        .uri(uploads_path(token_hash, &format!("/files/{file_id}/chunks/0")))
        .header("Authorization", Auth::user(ss58).header())
        .header("X-Billing-Bypass", BYPASS_TOKEN)
        .header("Content-Type", "application/octet-stream")
        .body(Body::from(body.to_vec()))
        .expect("build upload chunk request")
}

/// Open a link; returns `(share_token, token_hash)`.
async fn open_upload_link(app: &TestApp, ss58: &str, files: u32, bytes: u64, dirs: &[&str]) -> (String, String) {
    let response = app
        .oneshot(owner_json(
            Method::POST,
            ss58,
            "/v1/folder-shares/uploads",
            &upload_open_body(files, bytes, dirs),
        ))
        .await;
    let status = response.status();
    let body = body_json(response).await;
    assert_eq!(status, StatusCode::CREATED, "open: {body}");
    let token = body["share_token"].as_str().expect("share_token").to_string();
    let hash = body["token_hash"].as_str().expect("token_hash").to_string();
    assert_eq!(hash, blake3::hash(token.as_bytes()).to_hex().to_string());
    (token, hash)
}

/// Declare, fill and complete one file. Returns its `file_id`.
async fn upload_one_file(app: &TestApp, ss58: &str, token_hash: &str, path: &str, plaintext: u64) -> i64 {
    let response = app
        .oneshot(owner_json(
            Method::POST,
            ss58,
            &uploads_path(token_hash, "/files"),
            &upload_file_body(path, plaintext),
        ))
        .await;
    let status = response.status();
    let body = body_json(response).await;
    assert_eq!(status, StatusCode::CREATED, "file init {path}: {body}");
    let file_id = body["file_id"].as_i64().expect("file_id");
    let chunk = app.oneshot(upload_chunk_request(ss58, token_hash, file_id, MOCK_CIPHERTEXT)).await;
    assert_eq!(chunk.status(), StatusCode::NO_CONTENT, "chunk {path}");
    let done = app
        .oneshot(owner_request(Method::POST, ss58, &uploads_path(token_hash, &format!("/files/{file_id}/complete"))))
        .await;
    assert_eq!(done.status(), StatusCode::NO_CONTENT, "complete {path}");
    file_id
}

async fn seal_link(app: &TestApp, ss58: &str, token_hash: &str) -> (StatusCode, String) {
    status_and_body(app, owner_request(Method::POST, ss58, &uploads_path(token_hash, "/complete"))).await
}

#[tokio::test]
async fn an_upload_link_is_hidden_until_sealed() {
    let app = TestApp::new().await;
    let ss58 = unique_ss58("UpHidden");
    let (token, hash) = open_upload_link(&app, &ss58, 1, 5, &[]).await;

    let meta = app.oneshot(anon_get(&format!("/v1/folder-shares/{token}/meta"))).await;
    assert_eq!(meta.status(), StatusCode::NOT_FOUND);
    let listing = body_json(app.oneshot(owner_request(Method::GET, &ss58, "/v1/folder-shares")).await).await;
    assert!(
        !listing.to_string().contains(&hash),
        "an unsealed link must not be listed: {listing}"
    );
}

#[tokio::test]
async fn seal_refuses_a_link_missing_a_declared_file() {
    let app = TestApp::new().await;
    let ss58 = unique_ss58("UpMissing");
    let (token, hash) = open_upload_link(&app, &ss58, 2, 10, &[]).await;
    upload_one_file(&app, &ss58, &hash, "a.txt", 5).await;

    let (status, body) = seal_link(&app, &ss58, &hash).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(body.contains("1 of 2 files"), "{body}");
    let meta = app.oneshot(anon_get(&format!("/v1/folder-shares/{token}/meta"))).await;
    assert_eq!(meta.status(), StatusCode::NOT_FOUND, "still not live");
}

#[tokio::test]
async fn nothing_can_be_added_to_a_sealed_link() {
    let app = TestApp::new().await;
    let ss58 = unique_ss58("UpSealed");
    let (_, hash) = open_upload_link(&app, &ss58, 1, 5, &[]).await;
    let file_id = upload_one_file(&app, &ss58, &hash, "a.txt", 5).await;
    let (status, body) = seal_link(&app, &ss58, &hash).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, body) = status_and_body(
        &app,
        owner_json(Method::POST, &ss58, &uploads_path(&hash, "/files"), &upload_file_body("b.txt", 1)),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let chunk = app.oneshot(upload_chunk_request(&ss58, &hash, file_id, b"late")).await;
    assert_eq!(chunk.status(), StatusCode::CONFLICT);
    let abort = app.oneshot(owner_request(Method::DELETE, &ss58, &uploads_path(&hash, ""))).await;
    assert_eq!(abort.status(), StatusCode::NOT_FOUND, "a sealed link is revoked, not aborted");
}

/// Every route answers a non-owner exactly like a missing link.
#[tokio::test]
async fn upload_routes_answer_only_the_links_owner() {
    let app = TestApp::new().await;
    let ss58 = unique_ss58("UpOwner");
    let stranger = unique_ss58("UpStranger");
    let (_, hash) = open_upload_link(&app, &ss58, 1, 5, &[]).await;
    let file_id = {
        let response = app
            .oneshot(owner_json(Method::POST, &ss58, &uploads_path(&hash, "/files"), &upload_file_body("a.txt", 5)))
            .await;
        body_json(response).await["file_id"].as_i64().expect("file_id")
    };

    let probes = [
        owner_json(Method::POST, &stranger, &uploads_path(&hash, "/files"), &upload_file_body("b.txt", 1)),
        upload_chunk_request(&stranger, &hash, file_id, MOCK_CIPHERTEXT),
        owner_request(Method::POST, &stranger, &uploads_path(&hash, &format!("/files/{file_id}/complete"))),
        owner_request(Method::POST, &stranger, &uploads_path(&hash, "/complete")),
        owner_request(Method::DELETE, &stranger, &uploads_path(&hash, "")),
    ];
    for probe in probes {
        let uri = probe.uri().to_string();
        let (status, body) = status_and_body(&app, probe).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}: {body}");
        assert!(body.is_empty(), "{uri}: the 404 must be bodiless");
    }
}

#[tokio::test]
async fn abort_cuts_off_an_uploading_link() {
    let app = TestApp::new().await;
    let ss58 = unique_ss58("UpAbort");
    let (_, hash) = open_upload_link(&app, &ss58, 1, 5, &[]).await;
    let abort = app.oneshot(owner_request(Method::DELETE, &ss58, &uploads_path(&hash, ""))).await;
    assert_eq!(abort.status(), StatusCode::NO_CONTENT);
    let again = app.oneshot(owner_request(Method::DELETE, &ss58, &uploads_path(&hash, ""))).await;
    assert_eq!(again.status(), StatusCode::NOT_FOUND);
    let (status, _) = status_and_body(
        &app,
        owner_json(Method::POST, &ss58, &uploads_path(&hash, "/files"), &upload_file_body("a.txt", 5)),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn file_init_validates_paths_sizes_and_the_declaration() {
    let app = TestApp::new().await;
    let ss58 = unique_ss58("UpValidate");
    let (_, hash) = open_upload_link(&app, &ss58, 2, 10, &[]).await;
    upload_one_file(&app, &ss58, &hash, "a/b.txt", 5).await;

    let cases = [
        (upload_file_body("a/b.txt", 1), StatusCode::CONFLICT),
        (upload_file_body("a", 1), StatusCode::CONFLICT),
        (upload_file_body("../x", 1), StatusCode::BAD_REQUEST),
        (upload_file_body("big.bin", 6), StatusCode::BAD_REQUEST),
        (
            serde_json::json!({
                "relative_path": "huge.bin",
                "plaintext_size": 1,
                "ciphertext_size": hcfs_shared::shares::MAX_UPLOAD_FOLDER_SHARE_FILE_CIPHERTEXT + 1,
                "total_chunks": 1,
            }),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ];
    for (body, expected) in cases {
        let (status, text) = status_and_body(
            &app,
            owner_json(Method::POST, &ss58, &uploads_path(&hash, "/files"), &body),
        )
        .await;
        assert_eq!(status, expected, "{body}: {text}");
    }
}

#[tokio::test]
async fn open_validates_its_declaration() {
    let app = TestApp::new().await;
    let ss58 = unique_ss58("UpOpenBad");
    let too_many = hcfs_shared::shares::MAX_UPLOAD_FOLDER_SHARE_FILES + 1;
    for body in [
        upload_open_body(0, 0, &[]),
        upload_open_body(too_many, 1, &[]),
        upload_open_body(1, 1, &["/abs"]),
        serde_json::json!({ "display_name": "", "file_count": 1, "total_bytes": 1 }),
    ] {
        let (status, text) =
            status_and_body(&app, owner_json(Method::POST, &ss58, "/v1/folder-shares/uploads", &body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {text}");
    }
}
```

Add the six rows to `owner_write_requests` (l.7962), after the
`"PATCH /v1/folder-shares/by-hash/{token_hash}"` tuple:

```rust
        (
            "POST /v1/folder-shares/uploads",
            owner_json(Method::POST, ss58, "/v1/folder-shares/uploads", &upload_open_body(1, 4, &[])),
        ),
        (
            "DELETE /v1/folder-shares/uploads/{token_hash}",
            owner_request(Method::DELETE, ss58, &uploads_path(MATRIX_TOKEN_HASH, "")),
        ),
        (
            "POST /v1/folder-shares/uploads/{token_hash}/files",
            owner_json(
                Method::POST,
                ss58,
                &uploads_path(MATRIX_TOKEN_HASH, "/files"),
                &upload_file_body("a.txt", 4),
            ),
        ),
        (
            "PUT /v1/folder-shares/uploads/{token_hash}/files/{file_id}/chunks/{chunk_index}",
            upload_chunk_request(ss58, MATRIX_TOKEN_HASH, 1, b"data"),
        ),
        (
            "POST /v1/folder-shares/uploads/{token_hash}/files/{file_id}/complete",
            owner_request(Method::POST, ss58, &uploads_path(MATRIX_TOKEN_HASH, "/files/1/complete")),
        ),
        (
            "POST /v1/folder-shares/uploads/{token_hash}/complete",
            owner_request(Method::POST, ss58, &uploads_path(MATRIX_TOKEN_HASH, "/complete")),
        ),
```

Add to `GRANT_MATRIX_EXCLUDED` in `tests/shared_drives_lifecycle.rs` (l.10034), next to
the folder-share owner rows:

```rust
    ("POST /v1/folder-shares/uploads", "caller's own uploaded folder links"),
    (
        "DELETE /v1/folder-shares/uploads/{token_hash}",
        "caller's own uploaded folder links",
    ),
    (
        "POST /v1/folder-shares/uploads/{token_hash}/files",
        "caller's own uploaded folder links",
    ),
    (
        "PUT /v1/folder-shares/uploads/{token_hash}/files/{file_id}/chunks/{chunk_index}",
        "caller's own uploaded folder links",
    ),
    (
        "POST /v1/folder-shares/uploads/{token_hash}/files/{file_id}/complete",
        "caller's own uploaded folder links",
    ),
    (
        "POST /v1/folder-shares/uploads/{token_hash}/complete",
        "caller's own uploaded folder links",
    ),
```

Middleware unit tests (`http/middleware.rs` `mod tests`, next to the existing
`loggable_path` assertions around l.440):

```rust
    /// The segment after `uploads` is a token HASH (readable, like by-hash),
    /// but only when it has a hash's shape: a plaintext token put there must
    /// still be masked, or the route launders capabilities into the logs.
    #[test]
    fn upload_paths_keep_a_hash_and_mask_anything_else() {
        let hash = "ab".repeat(32);
        let path = format!("/v1/folder-shares/uploads/{hash}/files/3/chunks/0");
        assert_eq!(loggable_path(&path), path);
        assert_eq!(loggable_path("/v1/folder-shares/uploads"), "/v1/folder-shares/uploads");
        let token = "A".repeat(43);
        let masked = loggable_path(&format!("/v1/folder-shares/uploads/{token}/complete"));
        assert!(!masked.contains(&token), "{masked}");
        assert_eq!(masked, "/v1/folder-shares/uploads/{…}/complete");
        // A token that merely starts with "uploads" is a token, not this route.
        let lookalike = loggable_path("/v1/folder-shares/uploadsXYZ/meta");
        assert!(!lookalike.contains("uploadsXYZ"), "{lookalike}");
    }
```

**Step 2: Run the tests and confirm they fail**

```bash
cargo test -p hcfs-server --test router_oneshot upload -- --nocapture
cargo test -p hcfs-server http::
```

Expected: the route tests get 404/405 (no routes), and the catalog/matrix tests
(`owner_matrix_ids_match_oneshot_owner_catalog`, `catalog_method_paths_match_source_route_macros`)
fail.

**Step 3: Implement `upload_routes.rs`**

```rust
//! Owner routes that build an uploaded-copy folder link (see
//! `upload_db` for the lifecycle):
//!
//! - `POST   /v1/folder-shares/uploads`                       open (JSON)
//! - `POST   /v1/folder-shares/uploads/{token_hash}/files`    declare a file
//! - `PUT    /v1/folder-shares/uploads/{token_hash}/files/{file_id}/chunks/{chunk_index}`
//! - `POST   /v1/folder-shares/uploads/{token_hash}/files/{file_id}/complete`
//! - `POST   /v1/folder-shares/uploads/{token_hash}/complete` seal
//! - `DELETE /v1/folder-shares/uploads/{token_hash}`          abort
//!
//! Addressed by `token_hash`. The server mints the token at open exactly
//! as `POST /v1/folder-shares` does, and the plaintext crosses the wire
//! once, in that response.
//!
//! Every route runs the account guard before it reads the row, so a
//! suspended or listed account gets the guard's 403 whatever it names (the
//! owner matrices in `tests/router_oneshot.rs` depend on that order). After
//! the guard, every "not yours / not there / revoked / gone idle" is the
//! same bodiless 404. Admin bearers get that 404 too: an uploaded copy is
//! billed to an account, and the literal `"admin"` owner has none.
//!
//! Billing is the chunked file share's: open holds `total_bytes` on the
//! Drive rail, seal settles the hold into usage (`{ss58}_hcfs_shares` plus
//! the bare row), abort and the reaper give it back. A link that never
//! seals is never counted as usage.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, post, put};
use bytes::Bytes;
use tracing::{info, warn};

use crate::auth::account_guard::Access;
use crate::billing::reservation::Reservation;
use crate::folder_shares::db::FolderShareDbError;
use crate::folder_shares::errors::FolderShareError;
use crate::folder_shares::routes::{
    authenticate_owner, enforce_folder_share_owner, generate_folder_share_token,
    validate_display_name,
};
use crate::folder_shares::types::{
    InitUploadFileRequest, InitUploadFileResponse, OpenUploadFolderShareRequest,
    OpenUploadFolderShareResponse, SealUploadFolderShareResponse,
};
use crate::folder_shares::upload_db::{
    self, CompleteFileOutcome, InitFileOutcome, NewUploadFile, NewUploadShare, SealOutcome,
    UploadChunk, UploadChunkClaim,
};
use crate::http::handlers::helpers::{
    BillingSubject, QuotaHold, ciphertext_within_envelope, record_share_summary_delta_settling,
    release_quota_hold, settle_quota_hold, size_mismatch_message, validate_billing,
};
use crate::http::handlers::session::upload_chunk_to_backends;
use crate::path_validator;
use crate::shares::routes::{CHUNKED_MAX_CHUNK_SIZE, CHUNKED_MAX_TOTAL_CHUNKS};
use crate::state::AppState;
use crate::storage::cleanup::spawn_chunk_cleanup;
use crate::utils::{hash_token, is_token_hash, unix_now};
use hcfs_shared::shares::{
    MAX_UPLOAD_FOLDER_SHARE_DIRS, MAX_UPLOAD_FOLDER_SHARE_FILE_CIPHERTEXT,
    MAX_UPLOAD_FOLDER_SHARE_FILES,
};

/// Body cap for the file-init JSON.
const JSON_BODY_LIMIT: usize = 16 * 1024;

/// Body cap for the open. It carries only directories with no file beneath
/// them, which a real folder has few of; 8 MiB is thousands of deep paths.
const OPEN_BODY_LIMIT: usize = 8 * 1024 * 1024;

/// Chunk body cap: one 8 MiB chunk plus framing, as for file shares.
const CHUNK_BODY_LIMIT: usize = 9 * 1024 * 1024;

/// Life of the open-to-seal quota hold. A large folder uploads for hours;
/// seal re-checks the quota if the hold lapsed, and the idle reaper (60 min
/// of silence) releases it on abandonment long before this.
const UPLOAD_HOLD_TTL_SECS: i64 = 24 * 3600;

pub(crate) fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/v1/folder-shares/uploads",
            post(open_upload).layer(DefaultBodyLimit::max(OPEN_BODY_LIMIT)),
        )
        .route("/v1/folder-shares/uploads/{token_hash}", delete(abort_upload))
        .route(
            "/v1/folder-shares/uploads/{token_hash}/files",
            post(init_file).layer(DefaultBodyLimit::max(JSON_BODY_LIMIT)),
        )
        .route(
            "/v1/folder-shares/uploads/{token_hash}/files/{file_id}/chunks/{chunk_index}",
            put(put_chunk).layer(DefaultBodyLimit::max(CHUNK_BODY_LIMIT)),
        )
        .route(
            "/v1/folder-shares/uploads/{token_hash}/files/{file_id}/complete",
            post(complete_file),
        )
        .route("/v1/folder-shares/uploads/{token_hash}/complete", post(seal_upload))
}

/// The quota hold of one link, open to seal.
pub(crate) fn upload_hold(token_hash: &str) -> QuotaHold {
    QuotaHold::for_folder_share_upload(token_hash, unix_now() + UPLOAD_HOLD_TTL_SECS)
}

/// The authenticated, guard-checked caller of an upload route.
async fn upload_caller(state: &AppState, headers: &HeaderMap) -> Result<String, FolderShareError> {
    let caller = authenticate_owner(headers).await?;
    if caller == "admin" {
        return Err(FolderShareError::NotFound);
    }
    enforce_folder_share_owner(&state.db, &state.exempt_accounts, &caller, Access::Write).await?;
    Ok(caller)
}

/// [`upload_caller`] for a route that names a link. A malformed hash is the
/// same 404 as an unknown one; checked after the guard (see module docs).
async fn link_caller(
    state: &AppState,
    headers: &HeaderMap,
    token_hash: &str,
) -> Result<String, FolderShareError> {
    let caller = upload_caller(state, headers).await?;
    if !is_token_hash(token_hash) {
        return Err(FolderShareError::NotFound);
    }
    Ok(caller)
}

// =============================================================================
// Open
// =============================================================================

async fn open_upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<OpenUploadFolderShareRequest>,
) -> Result<Response, FolderShareError> {
    let owner = upload_caller(&state, &headers).await?;
    validate_open_request(&req)?;

    // Never log the token; the hash is the row key and is not a capability.
    let share_token = generate_folder_share_token();
    let token_hash = hash_token(&share_token);
    let subject = BillingSubject::share(&owner).with_guard_enforced();
    let hold = match validate_billing(&state, &headers, subject, req.total_bytes, upload_hold(&token_hash))
        .await
    {
        Ok(hold) => hold,
        Err(denied) => return Ok(denied),
    };

    upload_db::open_upload_share(
        state.db.pool(),
        &NewUploadShare {
            share_token: &share_token,
            owner_ss58: &owner,
            display_name: &req.display_name,
            ttl: req.ttl,
            file_count: req.file_count,
            total_bytes: req.total_bytes,
            dirs: &req.dirs,
        },
    )
    .await?;
    // Kept past this request: seal settles it by the same id, abort and the
    // reaper release it. An error above drops it, which gives the room back.
    if let Some(hold) = hold {
        hold.keep();
    }

    info!(
        owner = %owner,
        token_hash = %token_hash,
        files = req.file_count,
        bytes = req.total_bytes,
        "folder share upload opened",
    );
    Ok((
        StatusCode::CREATED,
        Json(OpenUploadFolderShareResponse {
            share_token,
            token_hash,
        }),
    )
        .into_response())
}

fn validate_open_request(req: &OpenUploadFolderShareRequest) -> Result<(), FolderShareError> {
    validate_display_name(&req.display_name)?;
    if req.file_count == 0 {
        return Err(FolderShareError::BadRequest(
            "file_count must be at least 1; an empty folder has nothing to share".into(),
        ));
    }
    if req.file_count > MAX_UPLOAD_FOLDER_SHARE_FILES {
        return Err(FolderShareError::BadRequest(format!(
            "file_count exceeds the {MAX_UPLOAD_FOLDER_SHARE_FILES}-file limit of one link",
        )));
    }
    if i64::try_from(req.total_bytes).is_err() {
        return Err(FolderShareError::BadRequest("total_bytes is out of range".into()));
    }
    if req.dirs.len() > MAX_UPLOAD_FOLDER_SHARE_DIRS as usize {
        return Err(FolderShareError::BadRequest(format!(
            "dirs exceeds the {MAX_UPLOAD_FOLDER_SHARE_DIRS}-entry limit",
        )));
    }
    for dir in &req.dirs {
        path_validator::validate(dir)
            .map_err(|e| FolderShareError::BadRequest(format!("invalid directory path: {e}")))?;
    }
    Ok(())
}

// =============================================================================
// File init
// =============================================================================

async fn init_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(token_hash): Path<String>,
    Json(req): Json<InitUploadFileRequest>,
) -> Result<Response, FolderShareError> {
    let owner = link_caller(&state, &headers, &token_hash).await?;
    let (plaintext_size, ciphertext_size) = validate_file_request(&req)?;
    let outcome = upload_db::init_upload_file(
        state.db.pool(),
        &NewUploadFile {
            owner_ss58: &owner,
            token_hash: &token_hash,
            relative_path: &req.relative_path,
            plaintext_size,
            ciphertext_size,
            total_chunks: i32::try_from(req.total_chunks).unwrap_or(i32::MAX),
        },
    )
    .await?;
    match outcome {
        InitFileOutcome::Created(file_id) => Ok((
            StatusCode::CREATED,
            Json(InitUploadFileResponse { file_id }),
        )
            .into_response()),
        InitFileOutcome::Unavailable => Err(FolderShareError::NotFound),
        InitFileOutcome::Sealed => Err(FolderShareError::Conflict(
            "this link is sealed; no file can be added".into(),
        )),
        InitFileOutcome::PathConflict => Err(FolderShareError::Conflict(format!(
            "{} collides with an entry already in this link",
            req.relative_path
        ))),
        InitFileOutcome::OverDeclared => Err(FolderShareError::BadRequest(
            "this file would take the link past the file_count or total_bytes declared at open"
                .into(),
        )),
    }
}

/// Field checks for a file init; returns the sizes as the columns' type.
fn validate_file_request(req: &InitUploadFileRequest) -> Result<(i64, i64), FolderShareError> {
    path_validator::validate(&req.relative_path)
        .map_err(|e| FolderShareError::BadRequest(format!("invalid relative_path: {e}")))?;
    if req.ciphertext_size > MAX_UPLOAD_FOLDER_SHARE_FILE_CIPHERTEXT {
        return Err(FolderShareError::PayloadTooLarge);
    }
    if req.total_chunks == 0 || req.total_chunks > CHUNKED_MAX_TOTAL_CHUNKS {
        return Err(FolderShareError::BadRequest(format!(
            "total_chunks must be between 1 and {CHUNKED_MAX_TOTAL_CHUNKS}",
        )));
    }
    // Every chunk is at least one byte, so more chunks than bytes can never
    // complete (same rule as the chunked file-share init).
    if u64::from(req.total_chunks) > req.ciphertext_size {
        return Err(FolderShareError::BadRequest(
            "total_chunks exceeds ciphertext_size".into(),
        ));
    }
    // Usage is billed on the declared plaintext; the stored ciphertext must
    // not be able to outgrow it by more than the framing envelope.
    if !ciphertext_within_envelope(req.plaintext_size, req.ciphertext_size) {
        return Err(FolderShareError::BadRequest(size_mismatch_message(
            req.plaintext_size,
            req.ciphertext_size,
        )));
    }
    let plaintext = i64::try_from(req.plaintext_size)
        .map_err(|_| FolderShareError::BadRequest("plaintext_size is out of range".into()))?;
    let ciphertext = i64::try_from(req.ciphertext_size).unwrap_or(i64::MAX);
    Ok((plaintext, ciphertext))
}

// =============================================================================
// Chunk
// =============================================================================

async fn put_chunk(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((token_hash, file_id, chunk_index)): Path<(String, i64, u32)>,
    body: Bytes,
) -> Result<Response, FolderShareError> {
    let owner = link_caller(&state, &headers, &token_hash).await?;
    if body.is_empty() {
        return Err(FolderShareError::BadRequest("chunk body is empty".into()));
    }
    if body.len() > CHUNKED_MAX_CHUNK_SIZE {
        return Err(FolderShareError::PayloadTooLarge);
    }
    let chunk_hash = blake3::hash(&body).to_hex().to_string();
    let chunk = UploadChunk {
        owner_ss58: &owner,
        token_hash: &token_hash,
        file_id,
        chunk_index: i32::try_from(chunk_index)
            .map_err(|_| FolderShareError::BadRequest("chunk_index is out of range".into()))?,
        chunk_hash: &chunk_hash,
        chunk_size: i64::try_from(body.len()).unwrap_or(i64::MAX),
    };
    match upload_db::claim_upload_chunk(state.db.pool(), &chunk).await? {
        UploadChunkClaim::Inserted => {}
        UploadChunkClaim::Idempotent => return Ok(StatusCode::NO_CONTENT.into_response()),
        UploadChunkClaim::Conflict => {
            return Err(FolderShareError::Conflict(format!(
                "chunk {chunk_index} was already uploaded with different content",
            )));
        }
        UploadChunkClaim::OutOfRange { total_chunks } => {
            return Err(FolderShareError::BadRequest(format!(
                "chunk_index {chunk_index} out of bounds (total_chunks={total_chunks})",
            )));
        }
        UploadChunkClaim::ExceedsDeclaredSize { claimed, declared } => {
            return Err(FolderShareError::BadRequest(format!(
                "chunk {chunk_index} would exceed the declared ciphertext_size: \
                 {claimed} of {declared} bytes already received",
            )));
        }
        UploadChunkClaim::Unavailable => return Err(FolderShareError::NotFound),
        UploadChunkClaim::NotAccepting => {
            return Err(FolderShareError::Conflict(
                "this file is no longer accepting chunks".into(),
            ));
        }
    }
    store_claimed_chunk(&state, &chunk, body).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Write a claimed chunk to storage. A failed write releases the claim so a
/// retry can take the slot. A write that lands after the link was reaped
/// names nothing and is handed to blob cleanup, the same race
/// `shares::routes::reclaim_chunk_if_orphaned` closes for file shares.
async fn store_claimed_chunk(
    state: &Arc<AppState>,
    chunk: &UploadChunk<'_>,
    body: Bytes,
) -> Result<(), FolderShareError> {
    let index = u32::try_from(chunk.chunk_index).unwrap_or(0);
    // The id argument only labels log lines: pass the hash, never a token.
    if upload_chunk_to_backends(state, chunk.token_hash, index, body, chunk.chunk_hash)
        .await
        .is_err()
    {
        if let Err(e) = upload_db::unclaim_upload_chunk(state.db.pool(), chunk).await {
            warn!(
                token_hash = %chunk.token_hash,
                file_id = chunk.file_id,
                chunk_index = index,
                error = %e,
                "unclaim after a failed chunk write failed; the reaper reclaims it with the link",
            );
        }
        warn!(
            token_hash = %chunk.token_hash,
            file_id = chunk.file_id,
            chunk_index = index,
            "folder share chunk upload to backend failed",
        );
        return Err(FolderShareError::Internal("chunk upload to backend failed".into()));
    }
    match upload_db::upload_chunk_still_named(state.db.read_pool(), chunk).await {
        Ok(true) => {}
        Ok(false) => {
            warn!(
                token_hash = %chunk.token_hash,
                file_id = chunk.file_id,
                chunk_index = index,
                "folder share chunk stored after its link was reaped; reclaiming it",
            );
            spawn_chunk_cleanup(state, vec![chunk.chunk_hash.to_string()]);
        }
        Err(e) => warn!(
            token_hash = %chunk.token_hash,
            error = %e,
            "could not re-check a folder share chunk claim after its storage write",
        ),
    }
    Ok(())
}

// =============================================================================
// File complete
// =============================================================================

async fn complete_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((token_hash, file_id)): Path<(String, i64)>,
) -> Result<Response, FolderShareError> {
    let owner = link_caller(&state, &headers, &token_hash).await?;
    match upload_db::complete_upload_file(state.db.pool(), &owner, &token_hash, file_id).await? {
        CompleteFileOutcome::Completed | CompleteFileOutcome::AlreadyComplete => {
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        CompleteFileOutcome::Unavailable => Err(FolderShareError::NotFound),
        CompleteFileOutcome::Sealed => Err(FolderShareError::Conflict(
            "this link is sealed".into(),
        )),
        CompleteFileOutcome::Incomplete {
            received_chunks,
            total_chunks,
            received_bytes,
            declared_bytes,
        } => Err(FolderShareError::BadRequest(format!(
            "file incomplete: {received_chunks} of {total_chunks} chunks, \
             {received_bytes} of {declared_bytes} bytes",
        ))),
    }
}

// =============================================================================
// Seal
// =============================================================================

async fn seal_upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(token_hash): Path<String>,
) -> Result<Response, FolderShareError> {
    let owner = link_caller(&state, &headers, &token_hash).await?;
    let (declared_bytes, sealed) = upload_db::seal_preflight(state.db.pool(), &owner, &token_hash)
        .await?
        .ok_or(FolderShareError::NotFound)?;
    // A retried seal must not take a fresh hold: nothing would settle it.
    let hold = if sealed {
        None
    } else {
        let subject = BillingSubject::share(&owner).with_guard_enforced();
        let growth = u64::try_from(declared_bytes).unwrap_or(0);
        match settle_quota_hold(&state, &headers, subject, growth, upload_hold(&token_hash)).await {
            Ok(hold) => hold,
            Err(denied) => return Ok(denied),
        }
    };
    match commit_seal(&state, &owner, &token_hash, hold).await? {
        SealOutcome::Sealed { expires_at, .. } => {
            info!(owner = %owner, token_hash = %token_hash, "folder share upload sealed");
            Ok((
                StatusCode::OK,
                Json(SealUploadFolderShareResponse {
                    expires_at: expires_at.map(|e| e.to_rfc3339()),
                }),
            )
                .into_response())
        }
        SealOutcome::Unavailable => Err(FolderShareError::NotFound),
        SealOutcome::Missing {
            complete_files,
            declared_files,
            complete_bytes,
            declared_bytes,
        } => Err(FolderShareError::Conflict(format!(
            "{complete_files} of {declared_files} files ({complete_bytes} of {declared_bytes} \
             bytes) have arrived; complete every declared file before sealing",
        ))),
    }
}

/// Seal in a spawned task the handler awaits, and record the usage once the
/// seal commits. A handler dropped mid-commit (client gone) would otherwise
/// leave a live link whose bytes were never counted, while the reaper later
/// releases them. Same reason as `shares::routes::commit_then_record`.
async fn commit_seal(
    state: &Arc<AppState>,
    owner: &str,
    token_hash: &str,
    hold: Option<Reservation>,
) -> Result<SealOutcome, FolderShareError> {
    let state = Arc::clone(state);
    let owner = owner.to_string();
    let token_hash = token_hash.to_string();
    let joined = tokio::spawn(async move {
        let outcome = upload_db::seal_upload_share(state.db.pool(), &owner, &token_hash).await?;
        if let SealOutcome::Sealed {
            newly_sealed: true,
            files,
            bytes,
            ..
        } = outcome
        {
            record_share_summary_delta_settling(&state, &owner, (bytes, files), hold);
        }
        Ok::<_, FolderShareDbError>(outcome)
    })
    .await
    .map_err(|e| FolderShareError::Internal(format!("seal task failed: {e}")))?;
    Ok(joined?)
}

// =============================================================================
// Abort
// =============================================================================

async fn abort_upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(token_hash): Path<String>,
) -> Result<Response, FolderShareError> {
    let owner = link_caller(&state, &headers, &token_hash).await?;
    if !upload_db::abort_upload_share(state.db.pool(), &owner, &token_hash).await? {
        return Err(FolderShareError::NotFound);
    }
    // The link can no longer seal, so its room is free now; the reaper
    // deletes the stored chunks on its next sweep.
    release_quota_hold(&state, &upload_hold(&token_hash)).await;
    info!(owner = %owner, token_hash = %token_hash, "folder share upload aborted");
    Ok(StatusCode::NO_CONTENT.into_response())
}
```

`joined?` converts through the existing `From<FolderShareDbError> for FolderShareError`.

The recipient blob helper (`upload_blob`) is added to this file in Task 7, together with its
only caller, so this commit carries no dead code.

**Middleware** (`http/middleware.rs`). Add these `route_label` arms before the
`["v1", "folder-shares", "owner-wraps"]` arm (l.143). They must precede the
`{token}/meta|browse|blob` arms, because `uploads/meta` must label as an upload route:

```rust
        ["v1", "folder-shares", "uploads"] => "/v1/folder-shares/uploads",
        ["v1", "folder-shares", "uploads", _] => "/v1/folder-shares/uploads/{token_hash}",
        ["v1", "folder-shares", "uploads", _, "files"] => {
            "/v1/folder-shares/uploads/{token_hash}/files"
        }
        ["v1", "folder-shares", "uploads", _, "complete"] => {
            "/v1/folder-shares/uploads/{token_hash}/complete"
        }
        ["v1", "folder-shares", "uploads", _, "files", _, "complete"] => {
            "/v1/folder-shares/uploads/{token_hash}/files/{file_id}/complete"
        }
        ["v1", "folder-shares", "uploads", _, "files", _, "chunks", _] => {
            "/v1/folder-shares/uploads/{token_hash}/files/{file_id}/chunks/{index}"
        }
```

In `loggable_path`, add this before `for prefix in [...]` (l.219), with this comment:

```rust
    // `/v1/folder-shares/uploads/{token_hash}/...`: same shape rule as the
    // by-hash route above. A hash stays readable; anything else in that slot
    // (a plaintext token, say) is masked. The bare `uploads` collection path
    // is a static route. A token that merely starts with "uploads" has no
    // slash after it and falls through to the generic masking below.
    if path == "/v1/folder-shares/uploads" {
        return Cow::Borrowed(path);
    }
    if let Some(rest) = path.strip_prefix("/v1/folder-shares/uploads/") {
        let (slot, suffix) = rest.split_once('/').map_or((rest, None), |(s, t)| (s, Some(t)));
        if is_token_hash(slot) {
            return Cow::Borrowed(path);
        }
        return Cow::Owned(match suffix {
            Some(suffix) => format!("/v1/folder-shares/uploads/{{…}}/{suffix}"),
            None => "/v1/folder-shares/uploads/{…}".to_string(),
        });
    }
```

**Route catalog** (`http/route_catalog.rs`). Add these after the
`PATCH /v1/folder-shares/by-hash/{token_hash}` row:

```rust
    // Uploaded-copy folder links: addressed by token_hash, owner-only.
    Route {
        id: "POST /v1/folder-shares/uploads",
        method: "POST",
        axum_path: "/v1/folder-shares/uploads",
        label: "/v1/folder-shares/uploads",
        sample: "/v1/folder-shares/uploads",
        class: RouteClass::OwnerWrite,
    },
    Route {
        id: "DELETE /v1/folder-shares/uploads/{token_hash}",
        method: "DELETE",
        axum_path: "/v1/folder-shares/uploads/{token_hash}",
        label: "/v1/folder-shares/uploads/{token_hash}",
        sample: "/v1/folder-shares/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        class: RouteClass::OwnerWrite,
    },
    Route {
        id: "POST /v1/folder-shares/uploads/{token_hash}/files",
        method: "POST",
        axum_path: "/v1/folder-shares/uploads/{token_hash}/files",
        label: "/v1/folder-shares/uploads/{token_hash}/files",
        sample: "/v1/folder-shares/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/files",
        class: RouteClass::OwnerWrite,
    },
    Route {
        id: "PUT /v1/folder-shares/uploads/{token_hash}/files/{file_id}/chunks/{chunk_index}",
        method: "PUT",
        axum_path: "/v1/folder-shares/uploads/{token_hash}/files/{file_id}/chunks/{chunk_index}",
        label: "/v1/folder-shares/uploads/{token_hash}/files/{file_id}/chunks/{index}",
        sample: "/v1/folder-shares/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/files/1/chunks/0",
        class: RouteClass::OwnerWrite,
    },
    Route {
        id: "POST /v1/folder-shares/uploads/{token_hash}/files/{file_id}/complete",
        method: "POST",
        axum_path: "/v1/folder-shares/uploads/{token_hash}/files/{file_id}/complete",
        label: "/v1/folder-shares/uploads/{token_hash}/files/{file_id}/complete",
        sample: "/v1/folder-shares/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/files/1/complete",
        class: RouteClass::OwnerWrite,
    },
    Route {
        id: "POST /v1/folder-shares/uploads/{token_hash}/complete",
        method: "POST",
        axum_path: "/v1/folder-shares/uploads/{token_hash}/complete",
        label: "/v1/folder-shares/uploads/{token_hash}/complete",
        sample: "/v1/folder-shares/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/complete",
        class: RouteClass::OwnerWrite,
    },
```

The `sample` lines exceed 100 characters exactly as the existing by-hash samples do
(l.650). rustfmt leaves string literals alone, and the style limit allows literals that
cannot be split. If clippy or a local lint complains, use the
`concat!("/v1/folder-shares/uploads/", "aaaa…")` form, provided the catalog test accepts a
`&'static str` constant expression.

**Step 4: Run the tests and confirm they pass**

```bash
cargo test -p hcfs-server --test router_oneshot upload
cargo test -p hcfs-server --test router_oneshot -- owner_matrix full_suspension exempt_account read_only_blocks
cargo test -p hcfs-server http::
cargo test -p hcfs-server --test shared_drives_lifecycle grant_matrix_covers_every_catalog_route
```

Expected: all PASS. The suspension/exempt/read-only matrices now cover the six routes.

**Step 5: Commit**

```bash
git add hcfs-server/src hcfs-server/tests
git commit -m "Add owner routes to upload, seal and abort a folder link copy" -m "Six routes under /v1/folder-shares/uploads, addressed by token_hash,
reusing the chunked file share's claim-before-store chunks, 8 MiB cap
and Drive-rail quota hold. The account guard runs before any row read so
the suspension matrices cover them, the seal records usage in a task the
handler cannot drop, and log lines keep a plaintext token out of the
uploads path slot."
```

---

### Task 7: Recipient `meta` / `browse` / `blob` dispatch on `source`

**Files:**
- Create: `hcfs-server/src/folder_shares/listing_source.rs`
- Create: `hcfs-server/src/folder_shares/upload_listing.rs`
- Modify: `hcfs-server/src/folder_shares/mod.rs` (`pub mod listing_source; pub mod upload_listing;`)
- Modify: `hcfs-server/src/folder_shares/routes.rs`: `browse_folder_share` (l.580-620),
  `directory_listing` (l.659), `search_listing` (l.758), `get_folder_share_blob`
  (l.861-900)
- Modify: `hcfs-server/src/store/browse.rs`: `exact_total_from_final_page` (l.18) →
  `pub(crate)`; `SEARCH_COUNT_CAP` (l.378), `sort_nulls_clause` (l.871),
  `browse_order_by` (l.920) → `pub(crate)`
- Modify: `hcfs-server/src/store/mod.rs`: add
  `pub(crate) use browse::exact_total_from_final_page;` next to the other `pub use`s
- Modify: `hcfs-server/src/shares/routes.rs:1099` (`stream_share_chunks`: `fn` →
  `pub(crate) fn`, reused for the upload blob)
- Modify: `hcfs-server/src/folder_shares/upload_routes.rs` (append `upload_blob`)

#### 7a: Upload listing SQL with parity tests

**Step 1: Failing parity tests** (`upload_listing.rs` `mod tests`)

```rust
#[cfg(test)]
mod tests {
    use serial_test::serial;

    use super::*;
    use crate::folder_shares::upload_test_support::{insert_entry, insert_upload_row, test_store, unique};
    use crate::http::handlers::browse::resolve_browse_file_order;
    use crate::http::handlers::search::resolve_sort;
    use crate::store::testing::seed_browse_file;
    use crate::store::types::folder_counts;
    use crate::utils::{composite_key, hash_token};

    /// `(path, plaintext size, created_at)`. No two share a size, a name, an
    /// extension within one directory, or a timestamp, so every sort has one
    /// right answer and the sources' different tiebreak keys decide nothing.
    const TREE: &[(&str, i64, i64)] = &[
        ("a.txt", 10, 1_700_000_001),
        ("Beta.md", 20, 1_700_000_002),
        ("docs/c.pdf", 30, 1_700_000_003),
        ("docs/deep/d.jpg", 40, 1_700_000_004),
        ("docs/deep/E.png", 50, 1_700_000_005),
        ("music/f.mp3", 60, 1_700_000_006),
    ];

    /// The same tree as a drive and as an upload link. Directory rows are
    /// dated after every file so `MIN(created_at)` picks a file, as on the
    /// drive side, whose aggregate is file-derived.
    async fn seed_both(store: &HcfsStore) -> (String, String) {
        let owner = unique("parity");
        let user_id = composite_key(&owner, "0011223344556677");
        let token_hash = hash_token(&unique("tok"));
        insert_upload_row(store, &token_hash, &owner, "complete").await;
        for (tag, (path, size, created)) in TREE.iter().enumerate() {
            seed_browse_file(store, &user_id, u8::try_from(tag + 1).unwrap(), path, *size).await;
            sqlx::query(
                "UPDATE file_records SET created_at = $3, updated_at = $3 \
                 WHERE user_id = $1 AND relative_path = $2",
            )
            .bind(&user_id)
            .bind(path)
            .bind(created)
            .execute(store.pool())
            .await
            .unwrap();
            insert_entry(store, &token_hash, "file", path, (*size, *created)).await;
        }
        for dir in ["docs", "docs/deep", "music"] {
            insert_entry(store, &token_hash, "dir", dir, (0, 1_800_000_000)).await;
        }
        (user_id, token_hash)
    }

    fn paths(rows: Vec<ShareBrowseRow>) -> Vec<String> {
        rows.into_iter().map(|row| row.relative_path).collect()
    }

    #[tokio::test]
    #[serial]
    async fn directory_aggregates_and_totals_match_the_drive_listing() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let (user_id, token_hash) = seed_both(&store).await;
        for prefix in ["", "docs/", "docs/deep/", "music/", "nope/"] {
            let drive = store.browse_folder_aggregates(&user_id, prefix).await.unwrap();
            let upload = folder_aggregates(store.read_pool(), &token_hash, prefix).await.unwrap();
            assert_eq!(folder_counts(&upload), folder_counts(&drive), "aggregates at {prefix:?}");

            let drive_totals = store.browse_subtree_totals(&user_id, prefix, &drive).await.unwrap();
            let upload_totals = subtree_totals(store.read_pool(), &token_hash, prefix).await.unwrap();
            assert_eq!(upload_totals, drive_totals, "totals at {prefix:?}");
        }
        let root = folder_aggregates(store.read_pool(), &token_hash, "").await.unwrap();
        let docs = root.iter().find(|row| row.name == "docs").expect("docs");
        assert_eq!(docs.created_at, Some(1_700_000_003), "a folder is as old as its oldest file");
    }

    #[tokio::test]
    #[serial]
    async fn file_pages_match_the_drive_listing_for_every_sort() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let (user_id, token_hash) = seed_both(&store).await;
        let sorts = [None, Some("file_name"), Some("size_bytes"), Some("created_at"), Some("updated_at"), Some("extension")];
        for prefix in ["", "docs/", "docs/deep/"] {
            for sort_by in sorts {
                for order in [Some("asc"), Some("desc")] {
                    let (order_column, order_direction) = resolve_browse_file_order(sort_by, order);
                    for (limit, offset) in [(50, 0), (1, 0), (1, 1)] {
                        let page = ShareDirPage { order_column, order_direction, limit, offset };
                        let drive = paths(store.browse_share_entries(&user_id, prefix, &page).await.unwrap());
                        let upload = paths(file_page(store.read_pool(), &token_hash, prefix, &page).await.unwrap());
                        assert_eq!(upload, drive, "{prefix:?} {sort_by:?} {order:?} {limit}/{offset}");
                    }
                }
            }
        }
    }

    fn search_page(q: Option<&str>, sort_by: Option<&str>, limit: u32, offset: u32) -> ShareSearchPage {
        let (sort_column, sort_direction) = resolve_sort(sort_by, Some("asc"));
        ShareSearchPage {
            q: q.map(str::to_string),
            extensions: None,
            size_min: None,
            size_max: None,
            date_from: None,
            date_to: None,
            sort_column,
            sort_direction,
            offset,
            limit,
        }
    }

    #[tokio::test]
    #[serial]
    async fn search_matches_the_drive_search_for_every_filter() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let (user_id, token_hash) = seed_both(&store).await;
        let mut cases = vec![
            search_page(None, None, 50, 0),
            search_page(Some("deep"), Some("file_name"), 50, 0),
            search_page(Some("txt"), None, 50, 0),
            search_page(Some("ab"), None, 50, 0),
            search_page(None, Some("size_bytes"), 2, 0),
            search_page(None, Some("size_bytes"), 2, 2),
        ];
        let mut images = search_page(None, Some("created_at"), 50, 0);
        images.extensions = Some(vec![".jpg".into(), ".png".into()]);
        let mut sized = search_page(None, Some("size_bytes"), 50, 0);
        (sized.size_min, sized.size_max) = (Some(25), Some(45));
        let mut dated = search_page(None, Some("updated_at"), 50, 0);
        (dated.date_from, dated.date_to) = (Some(1_700_000_003), Some(1_700_000_005));
        cases.extend([images, sized, dated]);

        for prefix in ["", "docs/"] {
            for page in &cases {
                let (drive_rows, drive_total, drive_more) =
                    store.search_share_entries(&user_id, prefix, page).await.unwrap();
                let (upload_rows, upload_total, upload_more) =
                    search(store.read_pool(), &token_hash, prefix, page).await.unwrap();
                assert_eq!(paths(upload_rows), paths(drive_rows), "{prefix:?} {page:?}");
                assert_eq!((upload_total, upload_more), (drive_total, drive_more), "{prefix:?} {page:?}");
            }
        }
    }

    /// An empty directory has no drive twin to compare against (that is
    /// `folder_entries`), so pin it on its own: listed, with nothing in it.
    #[tokio::test]
    #[serial]
    async fn an_empty_directory_is_listed_with_nothing_in_it() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let token_hash = hash_token(&unique("tok"));
        insert_upload_row(&store, &token_hash, &unique("owner"), "complete").await;
        insert_entry(&store, &token_hash, "dir", "Empty", (0, 5)).await;
        let rows = folder_aggregates(store.read_pool(), &token_hash, "").await.unwrap();
        assert_eq!(folder_counts(&rows), vec![("Empty".to_string(), 0, 0)]);
    }

    /// Like `store/browse.rs`: read-only by construction.
    #[test]
    fn this_module_never_names_the_write_pool() {
        let src = include_str!("upload_listing.rs");
        let body = &src[..src.find("#[cfg(test)]").expect("tests module")];
        assert!(!body.contains(".pool()"), "upload listing reads use the read pool");
    }
}
```

Check that `folder_counts` is `pub(crate)` under `cfg(test)` in `store/types.rs:480`, and
that `ShareSearchPage` derives `Debug` (it does, at l.516). `SubtreeTotals` derives
`PartialEq`.

**Step 2:** `cargo test -p hcfs-server folder_shares::upload_listing -- --test-threads=1`
Expected: compile error (functions missing).

**Step 3: Implement** (`upload_listing.rs`)

```rust
//! Recipient listing queries over an uploaded copy's `folder_share_files`.
//!
//! Each function answers the question its drive twin in `store/browse.rs`
//! answers, over one link's rows, and returns the same row type. That is
//! what lets `folder_shares::routes` page, total and format both sources
//! through one code path ([`crate::folder_shares::listing_source`]), and
//! what the parity tests below compare.
//!
//! Read-only, on the read pool, like `store/browse.rs`. Every statement is
//! scoped by `token_hash` first (`folder_share_files_path_unique`,
//! `folder_share_files_parent_idx`), and a link holds at most
//! `MAX_UPLOAD_FOLDER_SHARE_FILES` files plus their directories, so the
//! `LIKE` prefix filters scan one link, never the table. `relative_path`
//! keeps the default collation on purpose: directory names sort by
//! `LOWER(name)` exactly as the drive listing's do.

use sqlx::PgPool;

use crate::folder_shares::db::FolderShareDbError;
use crate::store::{
    FolderAggregate, HcfsStore, ShareBrowseRow, ShareDirPage, ShareSearchPage, SubtreeTotals,
    effective_search_term, escape_like, exact_total_from_final_page,
};

/// `prefix` is `""` (link root) or `"dir/"`, the shape the route builds;
/// this is the LIKE pattern for everything under it.
fn descendant_pattern(prefix: &str) -> String {
    format!("{}%", escape_like(prefix))
}

/// Direct-child directories of `prefix` with recursive counts, the twin of
/// `HcfsStore::browse_folder_aggregates`. Directory rows contribute their
/// name at any depth (as `folder_entries` does) and nothing to the counts;
/// file rows count toward the child they sit under, never toward `prefix`
/// itself. `HAVING name <> ''` and the `LOWER(name), name` order are the
/// drive query's, for the same reasons.
const AGGREGATES_SQL: &str = r#"SELECT
        name,
        SUM(file_count)::BIGINT AS file_count,
        SUM(total_bytes)::BIGINT AS total_bytes,
        MIN(created_at)::BIGINT AS created_at
    FROM (
        SELECT
            split_part(substring(relative_path FROM ($2::int + 1)), '/', 1) AS name,
            (CASE WHEN kind = 'file' THEN 1 ELSE 0 END)::BIGINT AS file_count,
            (CASE WHEN kind = 'file' THEN size_bytes ELSE 0 END)::BIGINT AS total_bytes,
            created_at
        FROM folder_share_files
        WHERE token_hash = $1
          AND relative_path LIKE $3 ESCAPE '\'
          AND (kind = 'dir' OR strpos(substring(relative_path FROM ($2::int + 1)), '/') > 0)
    ) AS children
    GROUP BY name
    HAVING name <> ''
    ORDER BY LOWER(name), name"#;

pub async fn folder_aggregates(
    pool: &PgPool,
    token_hash: &str,
    prefix: &str,
) -> Result<Vec<FolderAggregate>, FolderShareDbError> {
    // `substring` counts characters, not bytes (see the drive query).
    let prefix_chars = i32::try_from(prefix.chars().count()).unwrap_or(i32::MAX);
    let rows = sqlx::query_as::<_, FolderAggregate>(AGGREGATES_SQL)
        .bind(token_hash)
        .bind(prefix_chars)
        .bind(descendant_pattern(prefix))
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// Recursive file count and plaintext bytes under `prefix`.
pub async fn subtree_totals(
    pool: &PgPool,
    token_hash: &str,
    prefix: &str,
) -> Result<SubtreeTotals, FolderShareDbError> {
    let totals = sqlx::query_as::<_, SubtreeTotals>(
        r#"SELECT COUNT(*)::BIGINT AS file_count,
                  COALESCE(SUM(size_bytes), 0)::BIGINT AS total_bytes
             FROM folder_share_files
            WHERE token_hash = $1 AND kind = 'file' AND relative_path LIKE $2 ESCAPE '\'"#,
    )
    .bind(token_hash)
    .bind(descendant_pattern(prefix))
    .fetch_one(pool)
    .await?;
    Ok(totals)
}

/// The drive sort resolvers can name `uploaded_by_ss58`, which an uploaded
/// copy does not have. `share_sort_by` maps that alias away before it gets
/// here, so this is a backstop: each falls to its resolver's own default
/// rather than failing the statement.
fn browse_column(column: &'static str) -> &'static str {
    if column == "uploaded_by_ss58" { "LOWER(file_name)" } else { column }
}

fn search_column(column: &'static str) -> &'static str {
    if column == "uploaded_by_ss58" { "created_at" } else { column }
}

/// Files directly in `prefix`, the twin of `HcfsStore::browse_share_entries`.
/// Same `ORDER BY` builder, so every sort and tiebreak direction matches.
pub async fn file_page(
    pool: &PgPool,
    token_hash: &str,
    prefix: &str,
    page: &ShareDirPage,
) -> Result<Vec<ShareBrowseRow>, FolderShareDbError> {
    let parent_dir = prefix.strip_suffix('/').unwrap_or(prefix);
    let order = HcfsStore::browse_order_by(browse_column(page.order_column), page.order_direction);
    let sql = format!(
        "SELECT relative_path, size_bytes, created_at FROM folder_share_files \
         WHERE token_hash = $1 AND kind = 'file' AND parent_dir = $2 \
         ORDER BY {order} LIMIT $3 OFFSET $4"
    );
    let rows = sqlx::query_as::<_, ShareBrowseRow>(&sql)
        .bind(token_hash)
        .bind(parent_dir)
        .bind(i64::from(page.limit))
        .bind(i64::from(page.offset))
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// Filter block shared by the search page and count, binding `$2..$8` the
/// way `share_search_filter_sql` binds `$2..$7` (plus the prefix as `$8`).
/// The `q` arm is emitted only with a term, as on the drive side.
fn search_filter_sql(has_q: bool) -> String {
    let q_arm = if has_q {
        "AND (f.file_name ILIKE $2::text OR f.relative_path ILIKE $2::text)"
    } else {
        "AND $2::text IS NULL"
    };
    format!(
        r#" AND f.kind = 'file'
            {q_arm}
            AND ($3::text[] IS NULL
                 OR EXISTS (
                     SELECT 1 FROM unnest($3::text[]) ext
                     WHERE LOWER(COALESCE(f.file_name, f.relative_path, ''))
                           LIKE '%' || ext ESCAPE '\'
                 ))
            AND ($4::bigint IS NULL OR f.size_bytes >= $4)
            AND ($5::bigint IS NULL OR f.size_bytes <= $5)
            AND ($6::bigint IS NULL OR f.created_at >= $6)
            AND ($7::bigint IS NULL OR f.created_at <= $7)
            AND f.relative_path LIKE $8 ESCAPE '\'"#
    )
}

/// Recursive file search under `prefix`, the twin of
/// `HcfsStore::search_share_entries`: same filters, same over-fetch for
/// `has_more`, same capped count, same "never below what was handed out".
pub async fn search(
    pool: &PgPool,
    token_hash: &str,
    prefix: &str,
    page: &ShareSearchPage,
) -> Result<(Vec<ShareBrowseRow>, i64, bool), FolderShareDbError> {
    let q = effective_search_term(page.q.as_deref()).map(|term| format!("%{}%", escape_like(term)));
    let extensions: Option<Vec<String>> = page
        .extensions
        .as_ref()
        .filter(|v| !v.is_empty())
        .map(|v| v.iter().map(|e| escape_like(e)).collect());
    let filters = search_filter_sql(q.is_some());
    let column = search_column(page.sort_column);
    let direction = page.sort_direction;
    let nulls = HcfsStore::sort_nulls_clause(column);
    let page_sql = format!(
        "SELECT f.relative_path, f.size_bytes, f.created_at FROM folder_share_files f \
         WHERE f.token_hash = $1{filters} \
         ORDER BY f.{column} {direction}{nulls}, f.path_hash {direction} \
         LIMIT $9 OFFSET $10"
    );
    let pattern = descendant_pattern(prefix);
    let mut rows = sqlx::query_as::<_, ShareBrowseRow>(&page_sql)
        .bind(token_hash)
        .bind(q.as_deref())
        .bind(extensions.as_deref())
        .bind(page.size_min)
        .bind(page.size_max)
        .bind(page.date_from)
        .bind(page.date_to)
        .bind(&pattern)
        .bind(i64::from(page.limit).saturating_add(1))
        .bind(i64::from(page.offset))
        .fetch_all(pool)
        .await?;
    let has_more = rows.len() > page.limit as usize;
    rows.truncate(page.limit as usize);
    if let Some(total) = exact_total_from_final_page(page.offset, rows.len(), has_more) {
        return Ok((rows, total, has_more));
    }
    let count_sql = format!(
        "SELECT COUNT(*)::BIGINT FROM ( \
             SELECT 1 FROM folder_share_files f WHERE f.token_hash = $1{filters} LIMIT $9 \
         ) capped"
    );
    let counted: i64 = sqlx::query_scalar(&count_sql)
        .bind(token_hash)
        .bind(q.as_deref())
        .bind(extensions.as_deref())
        .bind(page.size_min)
        .bind(page.size_max)
        .bind(page.date_from)
        .bind(page.date_to)
        .bind(&pattern)
        .bind(HcfsStore::SEARCH_COUNT_CAP)
        .fetch_one(pool)
        .await?;
    let total = counted.max(i64::from(page.offset) + rows.len() as i64);
    Ok((rows, total, has_more))
}
```

`search` is about 60 lines, which is under the limit. If clippy flags `too_many_lines`, pull
the count statement into `async fn capped_count(...)`.

Make the four `store/browse.rs` items `pub(crate)` and re-export
`exact_total_from_final_page` from `store/mod.rs` (Files list above). Also check that
`escape_like` and `effective_search_term` are reachable as `crate::store::...` (both are
`pub(crate)` in `store/mod.rs`), and that `FolderAggregate`, `SubtreeTotals`,
`ShareBrowseRow`, `ShareDirPage`, `ShareSearchPage` are re-exported from `store` (routes.rs
l.114 already imports three of them that way). Add the missing ones to the `pub use types::{…}`
list if needed.

**Step 4:** `cargo test -p hcfs-server folder_shares::upload_listing store::browse -- --test-threads=1`
Expected: PASS, with the browse pins untouched.

#### 7b: One listing code path for both sources

**Step 1: Failing route test** (`tests/router_oneshot.rs`, in the uploads section)

```rust
/// The whole recipient surface over an uploaded copy, through the same
/// routes and wire shapes as a drive link.
#[tokio::test]
async fn a_sealed_upload_link_browses_searches_and_serves_blobs() {
    let app = TestApp::new().await;
    let ss58 = unique_ss58("UpServe");
    let (token, hash) = open_upload_link(&app, &ss58, 2, 10, &["Empty"]).await;
    upload_one_file(&app, &ss58, &hash, "a.txt", 4).await;
    upload_one_file(&app, &ss58, &hash, "sub/b.txt", 6).await;
    let (status, body) = seal_link(&app, &ss58, &hash).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let sealed: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(sealed["expires_at"].is_string(), "7d preset: {sealed}");

    let meta = body_json(app.oneshot(anon_get(&format!("/v1/folder-shares/{token}/meta"))).await).await;
    assert_eq!(meta["display_name"], "Holiday");

    let root = body_json(app.oneshot(anon_get(&format!("/v1/folder-shares/{token}/browse"))).await).await;
    let dirs: Vec<(&str, u64)> = root["directories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (d["name"].as_str().unwrap(), d["file_count"].as_u64().unwrap()))
        .collect();
    assert_eq!(dirs, vec![("Empty", 0), ("sub", 1)], "{root}");
    assert_eq!(root["files"][0]["path"], "a.txt");
    assert_eq!(root["recursive_file_count"], 2);
    assert_eq!(root["recursive_bytes"], 10);

    let sub = body_json(app.oneshot(anon_get(&format!("/v1/folder-shares/{token}/browse?path=sub"))).await).await;
    assert_eq!(sub["files"][0]["path"], "sub/b.txt", "{sub}");

    let hits = body_json(app.oneshot(anon_get(&format!("/v1/folder-shares/{token}/browse?q=b.t"))).await).await;
    let hit_paths: Vec<&str> = hits["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(hit_paths, vec!["sub/b.txt"], "{hits}");
    assert!(hits["recursive_file_count"].is_null(), "search mode reports no subtree totals");

    let blob = app.oneshot(anon_get(&format!("/v1/folder-shares/{token}/blob?path=sub/b.txt"))).await;
    assert_eq!(blob.status(), StatusCode::OK);
    assert_eq!(blob.headers()[header::CONTENT_TYPE], "application/octet-stream");
    assert_eq!(blob.headers()[header::CONTENT_LENGTH], MOCK_CIPHERTEXT.len().to_string());
    let bytes = blob.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], MOCK_CIPHERTEXT);

    for missing in ["blob?path=nope.txt", "blob?path=sub", "blob?path=Empty"] {
        let response = app.oneshot(anon_get(&format!("/v1/folder-shares/{token}/{missing}"))).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{missing}");
    }
}
```

The test needs `use axum::http::header;` in `router_oneshot.rs`. If the binary does not
import it already, add it to the existing `axum::http::{...}` import.

**Step 2:** `cargo test -p hcfs-server --test router_oneshot a_sealed_upload_link`
Expected: FAIL. Browse queries `file_records` under the composite key of an empty
`folder_hash` and returns an empty listing; blob 404s.

**Step 3: Implement**

`listing_source.rs`:

```rust
//! Where an anonymous folder-share listing reads its rows from.
//!
//! The recipient routes (`folder_shares::routes`) own paging, sorting
//! resolution, subtree totals and the wire format. Only the five row reads
//! differ by source, and they live here, so a drive link and an uploaded
//! copy are listed by literally the same handler code.

use crate::folder_shares::errors::FolderShareError;
use crate::folder_shares::upload_listing;
use crate::store::{
    FolderAggregate, HcfsStore, ShareBrowseRow, ShareDirPage, ShareSearchPage, SubtreeTotals,
};

pub(crate) enum ShareListingSource<'a> {
    /// A drive link: the owner's `file_records` under the composite key.
    Drive { user_id: String },
    /// An uploaded copy: the link's own `folder_share_files`.
    Upload { token_hash: &'a str },
}

fn internal(context: &str, err: impl std::fmt::Display) -> FolderShareError {
    FolderShareError::Internal(format!("{context}: {err}"))
}

impl ShareListingSource<'_> {
    /// Maintained recursive totals, when a counter row can answer. An
    /// uploaded copy keeps none: its totals are computed live, which one
    /// bounded link affords.
    pub(crate) async fn counter_totals(
        &self,
        db: &HcfsStore,
        prefix: &str,
    ) -> Result<Option<SubtreeTotals>, FolderShareError> {
        match self {
            Self::Drive { user_id } => db
                .browse_subtree_counter_totals(user_id, prefix)
                .await
                .map_err(|e| internal("share browse totals failed", e)),
            Self::Upload { .. } => Ok(None),
        }
    }

    pub(crate) async fn folder_aggregates(
        &self,
        db: &HcfsStore,
        prefix: &str,
    ) -> Result<Vec<FolderAggregate>, FolderShareError> {
        match self {
            Self::Drive { user_id } => db
                .browse_folder_aggregates(user_id, prefix)
                .await
                .map_err(|e| internal("share browse aggregates failed", e)),
            Self::Upload { token_hash } => {
                upload_listing::folder_aggregates(db.read_pool(), token_hash, prefix)
                    .await
                    .map_err(|e| internal("share browse aggregates failed", e))
            }
        }
    }

    /// Recursive totals when no counter row answered.
    pub(crate) async fn subtree_totals(
        &self,
        db: &HcfsStore,
        prefix: &str,
        aggregates: &[FolderAggregate],
    ) -> Result<SubtreeTotals, FolderShareError> {
        match self {
            Self::Drive { user_id } => db
                .browse_subtree_totals(user_id, prefix, aggregates)
                .await
                .map_err(|e| internal("share browse totals failed", e)),
            Self::Upload { token_hash } => {
                upload_listing::subtree_totals(db.read_pool(), token_hash, prefix)
                    .await
                    .map_err(|e| internal("share browse totals failed", e))
            }
        }
    }

    pub(crate) async fn file_page(
        &self,
        db: &HcfsStore,
        prefix: &str,
        page: &ShareDirPage,
    ) -> Result<Vec<ShareBrowseRow>, FolderShareError> {
        match self {
            Self::Drive { user_id } => db
                .browse_share_entries(user_id, prefix, page)
                .await
                .map_err(|e| internal("share browse entries failed", e)),
            Self::Upload { token_hash } => {
                upload_listing::file_page(db.read_pool(), token_hash, prefix, page)
                    .await
                    .map_err(|e| internal("share browse entries failed", e))
            }
        }
    }

    pub(crate) async fn search(
        &self,
        db: &HcfsStore,
        prefix: &str,
        page: &ShareSearchPage,
    ) -> Result<(Vec<ShareBrowseRow>, i64, bool), FolderShareError> {
        match self {
            Self::Drive { user_id } => db
                .search_share_entries(user_id, prefix, page)
                .await
                .map_err(|e| internal("share search failed", e)),
            Self::Upload { token_hash } => {
                upload_listing::search(db.read_pool(), token_hash, prefix, page)
                    .await
                    .map_err(|e| internal("share search failed", e))
            }
        }
    }
}
```

`routes.rs` changes:

1. Imports. Add `use crate::folder_shares::listing_source::ShareListingSource;` and
   `use hcfs_shared::shares::FolderShareSource;`.
2. Add these helpers to the Helpers section:

```rust
/// Parse the row's `source`. The CHECK keeps it closed, so anything else is
/// drift, and a 500 beats serving a link from the wrong tables.
fn share_source(source: &str) -> Result<FolderShareSource, FolderShareError> {
    FolderShareSource::from_column(source)
        .ok_or_else(|| FolderShareError::Internal(format!("unknown folder share source {source:?}")))
}

/// Which rows a recipient listing of `share` reads.
fn listing_source(share: &FolderShareRow) -> Result<ShareListingSource<'_>, FolderShareError> {
    Ok(match share_source(&share.source)? {
        FolderShareSource::Drive => ShareListingSource::Drive {
            user_id: composite_key(&share.owner_ss58, &share.folder_hash),
        },
        FolderShareSource::Upload => ShareListingSource::Upload {
            token_hash: &share.token_hash,
        },
    })
}
```

3. `browse_folder_share` (l.600-620). Replace the line
   `let user_id = composite_key(&share.owner_ss58, &share.folder_hash);` with
   `let source = listing_source(&share)?;`, and pass `&source` instead of `&user_id` to both
   calls. An upload row has `path_prefix = ""`, so `join_share_path` and
   `share_relative_path` behave exactly as for a whole-drive link.
4. `directory_listing(state, user_id: &str, …)` becomes
   `directory_listing(state, source: &ShareListingSource<'_>, …)`. Replace the four store
   calls:
   - `state.db.browse_subtree_counter_totals(user_id, query_prefix).await.map_err(…)?` →
     `source.counter_totals(&state.db, query_prefix).await?`
   - `state.db.browse_folder_aggregates(user_id, query_prefix).await.map_err(…)?` →
     `source.folder_aggregates(&state.db, query_prefix).await?`
   - `state.db.browse_subtree_totals(user_id, query_prefix, &aggregates).await.map_err(…)?`
     → `source.subtree_totals(&state.db, query_prefix, &aggregates).await?`
   - `state.db.browse_share_entries(user_id, query_prefix, &page).await.map_err(…)?` →
     `source.file_page(&state.db, query_prefix, &page).await?`
5. In `search_listing(state, user_id: &str, …)`, the same parameter swaps to
   `source: &ShareListingSource<'_>`, and
   `state.db.search_share_entries(user_id, query_prefix, &page)…` becomes
   `source.search(&state.db, query_prefix, &page).await?`.
6. `get_folder_share_blob`. Right after `let share = live_share_for_recipient(...)?;`:

```rust
    // An uploaded copy's files are its own chunk rows, not drive records.
    // Same response posture either way (see `upload_routes::upload_blob`).
    if share_source(&share.source)? == FolderShareSource::Upload {
        return crate::folder_shares::upload_routes::upload_blob(&state, &share.token_hash, &rel_path)
            .await;
    }
```

7. Append `upload_blob` to `upload_routes.rs`. Add `use axum::body::Body;`, `header` to the
   `axum::http` import, and `stream_share_chunks` to the `crate::shares::routes` import:

```rust
// =============================================================================
// Recipient blob (called by `routes::get_folder_share_blob`)
// =============================================================================

/// Stream one complete file of a sealed link with the drive blob's posture:
/// `application/octet-stream`, `Content-Length` = ciphertext length, no
/// `X-*` metadata, Range not honoured. Any miss is the bodiless 404.
pub(crate) async fn upload_blob(
    state: &AppState,
    token_hash: &str,
    relative_path: &str,
) -> Result<Response, FolderShareError> {
    let chunks = upload_db::upload_file_chunks(state.db.read_pool(), token_hash, relative_path).await?;
    if chunks.is_empty() {
        return Err(FolderShareError::NotFound);
    }
    let total: u64 = chunks
        .iter()
        .map(|(_, size)| u64::try_from(*size).unwrap_or(0))
        .sum();
    let hashes = chunks.into_iter().map(|(hash, _)| hash).collect();
    let body: Body =
        stream_share_chunks(state.storage.clone(), state.metrics.clone(), hashes, total);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, total)
        .body(body)
        .map_err(|_| FolderShareError::Internal("blob response build failed".into()))
}
```

   `stream_share_chunks` takes `StorageBackend` / `Metrics` by value, and
   `AppState.storage` / `.metrics` are `Clone` (as `shares/routes.rs:806` uses them).
8. Update the module doc's recipient section with one line: "Each recipient route serves a
   drive link from `file_records` and an uploaded copy from `folder_share_files`;
   `listing_source` is the only place the two differ."

**Step 4: Run the tests and confirm they pass**

```bash
cargo test -p hcfs-server --test router_oneshot folder_share
cargo test -p hcfs-server --test router_oneshot upload
cargo test -p hcfs-server folder_shares -- --test-threads=1
```

Expected: PASS. Every existing drive-link recipient test still passes, which shows the drive
arm is unchanged.

**Step 5: Commit**

```bash
git add hcfs-server/src hcfs-server/tests
git commit -m "Serve uploaded-copy folder links through the recipient routes" -m "meta, browse and blob keep their paths and wire shapes; only the five
row reads dispatch on source, behind ShareListingSource, so paging,
sorting, totals and search filters are one code path for both kinds of
link. Parity tests seed one tree as a drive and as a link and compare
every sort and filter."
```

---

### Task 8: Owner listing carries `source`

**Files:**
- Modify: `hcfs-server/src/folder_shares/types.rs` (`FolderShareListItem` l.172; pin
  `list_item_field_names_are_stable` l.407)
- Modify: `hcfs-server/src/folder_shares/routes.rs` (`list_my_folder_shares` l.261-290)

**Step 1: Failing tests**

In `list_item_field_names_are_stable`, add `source: FolderShareSource::Drive,` to the
literal and `"source": "drive",` to the expected JSON. Add:

```rust
    #[test]
    fn an_uploaded_copy_lists_with_an_empty_drive_scope() {
        let item = FolderShareListItem {
            token_hash: "ab".repeat(32),
            owner_ss58: "5GOwner".to_string(),
            minted_by_ss58: "5GOwner".to_string(),
            folder_hash: String::new(),
            path_prefix: String::new(),
            display_name: "T2-KD".to_string(),
            created_at: "2026-10-02T00:00:00+00:00".to_string(),
            expires_at: None,
            revoked_at: None,
            owner_wrap: None,
            source: FolderShareSource::Upload,
        };
        let value = serde_json::to_value(&item).unwrap();
        assert_eq!(value["source"], "upload");
        // "" and not null: shipped clients parse both fields as required strings.
        assert_eq!(value["folder_hash"], "");
        assert_eq!(value["path_prefix"], "");
    }
```

Route test (`router_oneshot.rs`, uploads section):

```rust
#[tokio::test]
async fn the_owner_listing_labels_an_uploaded_copy() {
    let app = TestApp::new().await;
    let ss58 = unique_ss58("UpList");
    let (_, hash) = open_upload_link(&app, &ss58, 1, 4, &[]).await;
    upload_one_file(&app, &ss58, &hash, "a.txt", 4).await;
    assert_eq!(seal_link(&app, &ss58, &hash).await.0, StatusCode::OK);

    let listing = body_json(app.oneshot(owner_request(Method::GET, &ss58, "/v1/folder-shares")).await).await;
    let row = listing
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["token_hash"] == hash.as_str())
        .unwrap_or_else(|| panic!("sealed link listed: {listing}"));
    assert_eq!(row["source"], "upload");
    assert_eq!(row["folder_hash"], "");
    assert_eq!(row["path_prefix"], "");
    assert_eq!(row["minted_by_ss58"], ss58.as_str());
}
```

**Step 2:** Run both tests and confirm they fail to compile or fail.

**Step 3: Implement**

`types.rs`: add `pub use hcfs_shared::shares::FolderShareSource;` beside the `ShareTtl`
re-export, and append this field to `FolderShareListItem`:

```rust
    /// `drive` (a live view over `folder_hash`/`path_prefix`) or `upload` (a
    /// copy uploaded with the link; `folder_hash` and `path_prefix` are
    /// `""`). Clients label the row from this; absent on older servers.
    pub source: FolderShareSource,
```

In `routes.rs::list_my_folder_shares`, the `.map(|row| …)` closure must now be fallible.
Rewrite it as:

```rust
    let items = rows
        .into_iter()
        .map(|row| {
            Ok(FolderShareListItem {
                source: share_source(&row.source)?,
                token_hash: row.token_hash,
                minted_by_ss58: row.minted_by_ss58.unwrap_or_else(|| row.owner_ss58.clone()),
                owner_ss58: row.owner_ss58,
                folder_hash: row.folder_hash,
                path_prefix: row.path_prefix,
                display_name: row.display_name,
                created_at: row.created_at.to_rfc3339(),
                expires_at: row.expires_at.map(|e| e.to_rfc3339()),
                revoked_at: row.revoked_at.map(|e| e.to_rfc3339()),
                owner_wrap: row.owner_wrap.map(|bytes| STANDARD.encode(bytes)),
            })
        })
        .collect::<Result<Vec<_>, FolderShareError>>()?;
```

Keep the existing comment about `minted_by_ss58`.

**Step 4:** `cargo test -p hcfs-server folder_shares::types` and
`cargo test -p hcfs-server --test router_oneshot listing`. Expected: PASS.

**Step 5: Commit**

```bash
git add hcfs-server/src/folder_shares hcfs-server/tests/router_oneshot.rs
git commit -m "List uploaded-copy folder links with source = upload" -m "The desktop and console label these rows 'Uploaded copy'. folder_hash
and path_prefix stay \"\" rather than null because every shipped client
parses them as required strings, and one upload row would otherwise
fail the whole listing."
```

---

### Task 9: Blob references know about `folder_share_chunks`

Do this before the reaper. If any reaper or cleanup runs first, `delete_blob_if_unreferenced`
would delete a chunk that a live upload link still names.

**Files:**
- Modify: `hcfs-server/src/store/files.rs`: `BLOB_REFERENCE_SQL` (l.1640-1654), its doc
  ("Every column a stored blob hash can live in"), and
  `blob_reference_generic_plan_uses_every_index` (l.2337)
- Modify: `hcfs-server/CLAUDE.md` "Blob deletion": add `folder_share_chunks` to the
  list of tables the probe keeps

**Step 1: Failing test** (`store/files.rs` tests)

```rust
    /// A chunk of a live uploaded folder link is a reference: deleting it
    /// would cut a file out of a link the recipient can still open.
    #[tokio::test]
    #[serial]
    async fn a_folder_link_chunk_keeps_its_blob() {
        let store = require_db!();
        let hash = format!("{:064x}", rand::random::<u128>());
        let token_hash = blake3::hash(hash.as_bytes()).to_hex().to_string();
        sqlx::query(
            "INSERT INTO folder_shares (token_hash, owner_ss58, minted_by_ss58, display_name, \
                 source, upload_state, last_activity_at, upload_ttl) \
             VALUES ($1, '5BlobRefOwner', '5BlobRefOwner', 'x', 'upload', 'uploading', NOW(), '7d')",
        )
        .bind(&token_hash)
        .execute(store.pool())
        .await
        .unwrap();
        let file_id: i64 = sqlx::query_scalar(
            "INSERT INTO folder_share_files (token_hash, kind, relative_path, parent_dir, \
                 file_name, path_hash, ciphertext_size, total_chunks, upload_state, \
                 created_at, updated_at) \
             VALUES ($1, 'file', 'a', '', 'a', $2, 48, 1, 'uploading', 1, 1) RETURNING file_id",
        )
        .bind(&token_hash)
        .bind(vec![7u8; 32])
        .fetch_one(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO folder_share_chunks (file_id, chunk_index, chunk_hash, chunk_size) \
             VALUES ($1, 0, $2, 48)",
        )
        .bind(file_id)
        .bind(&hash)
        .execute(store.pool())
        .await
        .unwrap();

        assert!(store.blob_hash_is_referenced(&hash).await.unwrap());
        sqlx::query("DELETE FROM folder_shares WHERE token_hash = $1")
            .bind(&token_hash)
            .execute(store.pool())
            .await
            .unwrap();
        assert!(!store.blob_hash_is_referenced(&hash).await.unwrap());
    }
```

Add `"idx_folder_share_chunks_chunk_hash",` to the index list in
`blob_reference_generic_plan_uses_every_index` (l.2337).

**Step 2:** `cargo test -p hcfs-server a_folder_link_chunk_keeps_its_blob blob_reference_generic_plan -- --test-threads=1`
Expected: FAIL. The hash is reported unreferenced, and the plan lacks the index.

**Step 3: Implement**. Append this arm to `BLOB_REFERENCE_SQL`:

```rust
           OR EXISTS (SELECT 1 FROM share_session_chunks WHERE chunk_hash = t.h) \
           OR EXISTS (SELECT 1 FROM folder_share_chunks WHERE chunk_hash = t.h)";
```

Update the doc sentence to "a file, a file share, a chunk of a live upload or share session,
or a chunk of an uploaded folder link". In `hcfs-server/CLAUDE.md` "Blob deletion", extend the
list "`file_records`, `file_shares`, `upload_session_chunks` or `share_session_chunks`" with
"or `folder_share_chunks`".

**Step 4:** Run it and confirm it passes.

**Step 5: Commit**

```bash
git add hcfs-server/src/store/files.rs hcfs-server/CLAUDE.md
git commit -m "Count uploaded folder-link chunks as blob references" -m "Blob keys carry no account, so one chunk can back another tenant's row;
every delete asks BLOB_REFERENCE_SQL first. Without this arm, cleanup of
any other row with identical bytes would delete a chunk a live link
still serves."
```

---

### Task 10: Upload reaper (revoked / expired / idle), billing release, purge

**Files:**
- Modify: `hcfs-server/src/folder_shares/upload_db.rs` (reaper queries)
- Create: `hcfs-server/src/folder_shares/upload_reaper.rs`
- Modify: `hcfs-server/src/folder_shares/mod.rs` (`pub mod upload_reaper;`; update the
  module doc's reaper paragraph)
- Modify: `hcfs-server/src/shares/reaper.rs:146-148` (tick) and its module doc "## Folder
  shares"
- Modify: `hcfs-server/src/workers/purge.rs:672-680` (`purge_shares`)

**Step 1: Failing DB tests** (`upload_db.rs` tests)

```rust
    async fn set(store: &HcfsStore, token_hash: &str, assignment: &str) {
        sqlx::query(&format!("UPDATE folder_shares SET {assignment} WHERE token_hash = $1"))
            .bind(token_hash)
            .execute(store.pool())
            .await
            .unwrap();
    }

    /// Each death (revoked, expired, idle) is claimed; a live link, sealed or
    /// still uploading, is not. Settling returns what to delete and release.
    #[tokio::test]
    #[serial]
    async fn the_reaper_claims_every_dead_link_and_settles_it() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let owner = unique_tag("owner");
        let (sealed, sealed_file) = one_file(&store, &owner).await;
        finish_file(&store, &owner, &sealed, sealed_file).await;
        set(&store, &sealed, "declared_file_count = 1, declared_bytes = 10").await;
        seal_upload_share(store.pool(), &owner, &sealed).await.unwrap();
        let (idle, _) = open_for(&store, &owner, &[]).await;
        let (live, _) = open_for(&store, &owner, &[]).await;

        set(&store, &sealed, "expires_at = NOW() - INTERVAL '1 minute'").await;
        set(&store, &idle, "last_activity_at = NOW() - INTERVAL '2 hours'").await;
        let claimed = claim_dead_upload_shares(store.pool(), 500).await.unwrap();
        assert!(claimed.contains(&sealed) && claimed.contains(&idle), "{claimed:?}");
        assert!(!claimed.contains(&live));

        let reaped = settle_dead_upload_share(store.pool(), &sealed).await.unwrap().expect("dead");
        assert_eq!((reaped.released_bytes, reaped.released_files), (10, 1));
        assert!(!reaped.was_uploading);
        let mut chunks = reaped.chunk_hashes.clone();
        chunks.sort();
        assert_eq!(chunks, ["c0", "c1"]);

        let idle_reaped = settle_dead_upload_share(store.pool(), &idle).await.unwrap().expect("dead");
        assert_eq!((idle_reaped.released_bytes, idle_reaped.was_uploading), (0, true), "never billed");
        assert!(settle_dead_upload_share(store.pool(), &live).await.unwrap().is_none(), "live stays");
        assert!(settle_dead_upload_share(store.pool(), &sealed).await.unwrap().is_none(), "gone");
    }

    #[tokio::test]
    #[serial]
    async fn purge_revokes_every_upload_link_of_the_account() {
        let Some(store) = test_store().await else {
            eprintln!("Skipping test: TEST_DATABASE_URL not set");
            return;
        };
        let owner = unique_tag("owner");
        let (one, _) = open_for(&store, &owner, &[]).await;
        let (two, _) = open_for(&store, &owner, &[]).await;
        let mut revoked = revoke_upload_shares_for_owner(store.pool(), &owner).await.unwrap();
        revoked.sort();
        let mut expected = vec![one, two];
        expected.sort();
        assert_eq!(revoked, expected);
    }
```

**Step 2:** Run them and confirm they fail to compile.

**Step 3: Implement** (append to `upload_db.rs`)

```rust
// =============================================================================
// Reaper
// =============================================================================

/// A dead link the reaper deleted, with what its deletion leaves to do.
#[derive(Clone, Debug)]
pub struct ReapedUploadShare {
    pub token_hash: String,
    pub owner_ss58: String,
    /// Still uploading when it died: its quota hold is released; it was
    /// never counted as usage.
    pub was_uploading: bool,
    /// Usage to subtract: what seal recorded, zero for an unsealed link.
    pub released_bytes: i64,
    pub released_files: i64,
    /// Every chunk the link stored, for post-commit blob cleanup.
    pub chunk_hashes: Vec<String>,
}

/// Dead = revoked, sealed and past its expiry, or uploading and idle. Shared
/// by the claim and the settle re-check so the two cannot disagree.
const DEAD_UPLOAD_SQL: &str = "source = 'upload' AND ( \
         revoked_at IS NOT NULL \
      OR (upload_state = 'complete' AND expires_at IS NOT NULL AND expires_at < NOW()) \
      OR (upload_state = 'uploading' \
          AND last_activity_at < NOW() - make_interval(mins => $2)))";

/// The claim: one arm per death, each on its own partial index
/// (`folder_shares_reap_upload_revoked`, `folder_shares_expires_idx`,
/// `folder_shares_reap_upload_idle`), each limited, so a backlog in one
/// cannot starve the others (the file-share reaper's lesson,
/// `shares::db::REAP_CLAIM_SQL`). A candidate list only: settle re-locks.
const UPLOAD_REAP_CLAIM_SQL: &str = "SELECT token_hash FROM ( \
         SELECT token_hash FROM folder_shares \
         WHERE source = 'upload' AND revoked_at IS NOT NULL \
           AND (reap_after IS NULL OR reap_after <= NOW()) \
         ORDER BY revoked_at LIMIT $1) revoked \
     UNION ALL \
     SELECT token_hash FROM ( \
         SELECT token_hash FROM folder_shares \
         WHERE source = 'upload' AND upload_state = 'complete' AND revoked_at IS NULL \
           AND expires_at IS NOT NULL AND expires_at < NOW() \
           AND (reap_after IS NULL OR reap_after <= NOW()) \
         ORDER BY expires_at LIMIT $1) expired \
     UNION ALL \
     SELECT token_hash FROM ( \
         SELECT token_hash FROM folder_shares \
         WHERE source = 'upload' AND upload_state = 'uploading' AND revoked_at IS NULL \
           AND last_activity_at < NOW() - make_interval(mins => $2) \
           AND (reap_after IS NULL OR reap_after <= NOW()) \
         ORDER BY last_activity_at LIMIT $1) idle";

/// Up to `limit` dead links per arm.
pub async fn claim_dead_upload_shares(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<String>, FolderShareDbError> {
    let hashes = sqlx::query_scalar(UPLOAD_REAP_CLAIM_SQL)
        .bind(limit.max(1))
        .bind(UPLOAD_IDLE_DEADLINE_MINUTES)
        .fetch_all(pool)
        .await?;
    Ok(hashes)
}

/// Delete one dead link in its own transaction and report what it held.
/// `None` when it is not dead (any more) or another reaper holds it.
///
/// Reads the chunk list and the usage BEFORE the delete: the cascade takes
/// both with the row. Storage is not touched here (no network inside a
/// transaction); the caller cleans blobs after this commits.
pub async fn settle_dead_upload_share(
    pool: &PgPool,
    token_hash: &str,
) -> Result<Option<ReapedUploadShare>, FolderShareDbError> {
    let mut tx = pool.begin().await?;
    let row: Option<(String, String)> = sqlx::query_as(&format!(
        "SELECT owner_ss58, upload_state FROM folder_shares \
         WHERE token_hash = $1 AND {DEAD_UPLOAD_SQL} \
         FOR UPDATE SKIP LOCKED"
    ))
    .bind(token_hash)
    .bind(UPLOAD_IDLE_DEADLINE_MINUTES)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((owner_ss58, upload_state)) = row else {
        return Ok(None);
    };
    let chunk_hashes: Vec<String> = sqlx::query_scalar(
        "SELECT c.chunk_hash FROM folder_share_chunks c \
         JOIN folder_share_files f ON f.file_id = c.file_id \
         WHERE f.token_hash = $1",
    )
    .bind(token_hash)
    .fetch_all(&mut *tx)
    .await?;
    let was_uploading = upload_state == "uploading";
    let (released_files, released_bytes): (i64, i64) = if was_uploading {
        (0, 0)
    } else {
        sqlx::query_as(
            "SELECT COUNT(*)::BIGINT, COALESCE(SUM(size_bytes), 0)::BIGINT \
             FROM folder_share_files WHERE token_hash = $1 AND kind = 'file'",
        )
        .bind(token_hash)
        .fetch_one(&mut *tx)
        .await?
    };
    sqlx::query("DELETE FROM folder_shares WHERE token_hash = $1")
        .bind(token_hash)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Some(ReapedUploadShare {
        token_hash: token_hash.to_string(),
        owner_ss58,
        was_uploading,
        released_bytes,
        released_files,
        chunk_hashes,
    }))
}

/// Keep a link that failed to settle off the head of its arm for a while,
/// so one poisoned row cannot take every sweep's first slot.
pub async fn back_off_upload_share(
    pool: &PgPool,
    token_hash: &str,
) -> Result<(), FolderShareDbError> {
    sqlx::query(
        "UPDATE folder_shares SET reap_after = NOW() + INTERVAL '15 minutes' \
         WHERE token_hash = $1",
    )
    .bind(token_hash)
    .execute(pool)
    .await?;
    Ok(())
}

/// Account purge: revoke every upload link of `owner` (sealed or not) so
/// each is dead, and return them for settling.
pub async fn revoke_upload_shares_for_owner(
    pool: &PgPool,
    owner: &str,
) -> Result<Vec<String>, FolderShareDbError> {
    let hashes = sqlx::query_scalar(
        "UPDATE folder_shares SET revoked_at = COALESCE(revoked_at, NOW()) \
         WHERE owner_ss58 = $1 AND source = 'upload' \
         RETURNING token_hash",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(hashes)
}
```

Run the DB tests again; they should pass.

**Step 4: Failing reaper test** (`router_oneshot.rs`, uploads section)

```rust
/// Revoke, then reap: the row, its files and its chunk references are
/// gone, and the usage the seal counted is given back exactly once.
#[tokio::test]
async fn reaping_a_revoked_upload_link_deletes_it_and_releases_its_usage() {
    let app = TestApp::new().await;
    let ss58 = unique_ss58("UpReap");
    let (_, hash) = open_upload_link(&app, &ss58, 1, 4, &[]).await;
    upload_one_file(&app, &ss58, &hash, "a.txt", 4).await;
    assert_eq!(seal_link(&app, &ss58, &hash).await.0, StatusCode::OK);
    let shares_row = format!("{ss58}_hcfs_shares");
    assert_eq!(app.state.summary_buffer().pending_delta(&shares_row), (4, 1));

    let revoke = app
        .oneshot(owner_request(Method::DELETE, &ss58, &format!("/v1/folder-shares/by-hash/{hash}")))
        .await;
    assert_eq!(revoke.status(), StatusCode::NO_CONTENT);
    let settled = hcfs_server::folder_shares::upload_reaper::settle_upload_shares(
        &app.state,
        std::slice::from_ref(&hash),
    )
    .await;
    assert_eq!((settled.reaped, settled.failed), (1, 0));
    assert_eq!(
        app.state.summary_buffer().pending_delta(&shares_row),
        (0, 0),
        "the reap releases what the seal counted"
    );
    let files: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folder_share_files WHERE token_hash = $1")
        .bind(&hash)
        .fetch_one(app.state.db.pool())
        .await
        .unwrap();
    assert_eq!(files, 0);
}

/// An abandoned upload (no request for an hour) is reaped and never billed;
/// its room comes back.
#[tokio::test]
async fn an_idle_upload_link_is_reaped_without_billing() {
    let app = TestApp::new().await;
    let ss58 = unique_ss58("UpIdle");
    let (_, hash) = open_upload_link(&app, &ss58, 1, 4, &[]).await;
    sqlx::query("UPDATE folder_shares SET last_activity_at = NOW() - INTERVAL '2 hours' WHERE token_hash = $1")
        .bind(&hash)
        .execute(app.state.db.pool())
        .await
        .unwrap();
    let settled = hcfs_server::folder_shares::upload_reaper::settle_upload_shares(
        &app.state,
        std::slice::from_ref(&hash),
    )
    .await;
    assert_eq!(settled.reaped, 1);
    assert_eq!(app.state.summary_buffer().pending_delta(&format!("{ss58}_hcfs_shares")), (0, 0));
}

/// Open holds the declared bytes against the plan; abort gives them back
/// at once, and a sealed link's bytes are counted once.
#[tokio::test]
async fn an_upload_link_holds_its_room_until_seal_or_abort() {
    let (plan, _client) = mock_entitlement(200, lagging_free_plan()).await;
    let app = capped_pod(&plan).await;
    let ss58 = unique_ss58("UpHold");
    let before = committed_drive_bytes(&app, &ss58).await;

    let open = Request::post("/v1/folder-shares/uploads")
        .header("Authorization", Auth::user(&ss58).header())
        .header("Content-Type", "application/json")
        .body(Body::from(serde_json::to_vec(&upload_open_body(1, 800, &[])).unwrap()))
        .unwrap();
    let response = app.oneshot(open).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let hash = body_json(response).await["token_hash"].as_str().unwrap().to_string();
    assert_eq!(committed_drive_bytes(&app, &ss58).await, before + 800, "open holds the room");

    let abort = Request::delete(uploads_path(&hash, ""))
        .header("Authorization", Auth::user(&ss58).header())
        .body(Body::empty())
        .unwrap();
    assert_eq!(app.oneshot(abort).await.status(), StatusCode::NO_CONTENT);
    assert_eq!(committed_drive_bytes(&app, &ss58).await, before, "abort gives it back");
}
```

**Step 5:** `cargo test -p hcfs-server --test router_oneshot reap idle_upload holds_its_room`
Expected: compile error (`upload_reaper` missing).

**Step 6: Implement `upload_reaper.rs`**

```rust
//! Reaper for uploaded-copy folder links. Runs on the share reaper's tick
//! (`shares::reaper::reap_expired_shares`), before the metadata-only
//! folder-share sweep, and from account purge.
//!
//! Per link, in this order: delete the row in its own short transaction
//! (`upload_db::settle_dead_upload_share` reads the chunk list and usage
//! first, the cascade takes files and chunks), then record the usage
//! release, release a never-sealed link's quota hold, and hand the chunks to
//! `storage::cleanup`, which deletes each blob only if no other row still
//! names it. Storage runs after commit: a transaction must not wait on the
//! network. A link that fails to settle is backed off and retried later.
//!
//! No dedup: every link's content is encrypted under its own fresh key, so
//! its chunks match no other row and each link is billed and released on
//! its own.

use std::sync::Arc;

use tracing::{info, warn};

use crate::folder_shares::db::FolderShareDbError;
use crate::folder_shares::upload_db::{self, ReapedUploadShare};
use crate::folder_shares::upload_routes::upload_hold;
use crate::http::handlers::helpers::{record_share_summary_delta, release_quota_hold};
use crate::shares::db::REAP_BATCH_LIMIT;
use crate::state::AppState;
use crate::storage::cleanup::spawn_blob_cleanup;
use crate::store::BlobRef;

/// What one settle pass did.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct UploadSettle {
    pub reaped: u64,
    pub failed: u64,
}

/// One sweep as the reaper loop runs it. Errors are logged, never raised:
/// a failed tick leaves the rows for the next one.
pub async fn sweep_upload_folder_shares(state: &Arc<AppState>) -> u64 {
    let candidates = match upload_db::claim_dead_upload_shares(state.db.pool(), REAP_BATCH_LIMIT).await {
        Ok(candidates) => candidates,
        Err(e) => {
            warn!(error = %e, "upload folder-share reaper claim failed");
            return 0;
        }
    };
    let settled = settle_upload_shares(state, &candidates).await;
    if settled.reaped > 0 || settled.failed > 0 {
        info!(reaped = settled.reaped, failed = settled.failed, "upload folder-share sweep complete");
    }
    settled.reaped
}

/// Settle `token_hashes` one by one. Public so tests and purge drive the
/// exact path the loop does.
pub async fn settle_upload_shares(state: &Arc<AppState>, token_hashes: &[String]) -> UploadSettle {
    let mut settled = UploadSettle::default();
    for token_hash in token_hashes {
        match upload_db::settle_dead_upload_share(state.db.pool(), token_hash).await {
            Ok(Some(reaped)) => {
                release_reaped(state, reaped).await;
                settled.reaped += 1;
            }
            Ok(None) => {}
            Err(e) => {
                warn!(token_hash = %token_hash, error = %e, "upload folder share could not be reaped; backing it off");
                if let Err(e) = upload_db::back_off_upload_share(state.db.pool(), token_hash).await {
                    warn!(token_hash = %token_hash, error = %e, "could not back off an unsettled upload folder share");
                }
                settled.failed += 1;
            }
        }
    }
    settled
}

/// Everything a deleted link leaves to do, after its commit.
async fn release_reaped(state: &Arc<AppState>, reaped: ReapedUploadShare) {
    if reaped.released_bytes != 0 || reaped.released_files != 0 {
        record_share_summary_delta(state, &reaped.owner_ss58, -reaped.released_bytes, -reaped.released_files);
    }
    if reaped.was_uploading {
        release_quota_hold(state, &upload_hold(&reaped.token_hash)).await;
    }
    if !reaped.chunk_hashes.is_empty() {
        spawn_blob_cleanup(
            state,
            vec![BlobRef {
                arion_hash: String::new(),
                s3_hash: None,
                chunk_hashes: Some(reaped.chunk_hashes),
            }],
        );
    }
}

/// Account purge: revoke and settle every upload link of `owner`.
/// `failed > 0` means some remain (revoked); the purge retries the job.
pub async fn purge_owner_upload_shares(
    state: &Arc<AppState>,
    owner: &str,
) -> Result<UploadSettle, FolderShareDbError> {
    let hashes = upload_db::revoke_upload_shares_for_owner(state.db.pool(), owner).await?;
    let mut settled = settle_upload_shares(state, &hashes).await;
    // A row another reaper held (SKIP LOCKED) settled as `None`: count it
    // as not done, so purge retries rather than finishing over it.
    let gone = settled.reaped + settled.failed;
    settled.failed += u64::try_from(hashes.len()).unwrap_or(u64::MAX).saturating_sub(gone);
    Ok(settled)
}
```

Check that `BlobRef`'s `arion_hash: ""` is handled. `record_targets` in
`storage/cleanup.rs` must skip an empty hash: read it, and if it does not skip it, set
`arion_hash` to the first chunk hash instead. The reference probe always reports `""` as
referenced, so the worst case is a skipped no-op.

**Wire the loop** (`shares/reaper.rs:146-148`):

```rust
            _ = tick.tick() => {
                run_sweep_with_billing(&state, &cancel).await;
                crate::folder_shares::upload_reaper::sweep_upload_folder_shares(&state).await;
                sweep_folder_shares(state.db.pool()).await;
            }
```

Append to its module doc "## Folder shares": "Uploaded-copy links do own blobs and usage; the
same tick runs `folder_shares::upload_reaper` for them first, and the metadata sweep skips
them (`source = 'drive'`)."

**Wire purge** (`workers/purge.rs`, in `purge_shares` before
`folder_shares_db::delete_all_for_owner` at l.673):

```rust
    // Upload links own blobs and usage: settle them through their reaper
    // before the metadata delete (which skips them), and treat any left
    // behind as an incomplete purge to retry.
    let uploads = crate::folder_shares::upload_reaper::purge_owner_upload_shares(app_state, ss58)
        .await
        .map_err(|err| DatabaseError::QueryFailed(err.to_string()))?;
    let all_done = all_done && uploads.failed == 0;
    let progressed = progressed || uploads.reaped > 0;
```

This replaces the existing `let all_done = …;` line (l.672): compute
`let all_done = settled.failed.is_empty() && settled.deferred.is_empty();` first, then shadow
it as above. Do the same for `progressed`.

**Step 7: Run the tests and confirm they pass**

```bash
cargo test -p hcfs-server folder_shares -- --test-threads=1
cargo test -p hcfs-server --test router_oneshot upload
cargo test -p hcfs-server shares::reaper
cargo test -p hcfs-server --test router_oneshot purge
```

Expected: PASS. The pinned `reaper_loop_delays_missed_ticks_and_spawns_blob_deletes` still
passes because the loop still calls only spawned cleanups.

**Step 8: Commit**

```bash
git add hcfs-server/src
git commit -m "Reap dead uploaded folder links: storage, usage and quota hold" -m "Revoked, expired and idle (60 min without a request) upload links are
deleted in their own short transaction after their chunk list and usage
are read, then their usage is released, a never-sealed link's hold is
freed, and the chunks go through the reference-probing blob cleanup.
Account purge settles them the same way before its metadata delete."
```

---

### Task 11: Capability flag

**Files:**
- Modify: `hcfs-server/src/shares/types.rs` (`Capabilities`, after `camera_backup_v1` at
  l.167)
- Modify: `hcfs-server/src/shares/routes.rs` (`get_capabilities` l.678)
- Modify: `hcfs-server/tests/router_oneshot.rs` (next to
  `capabilities_advertise_no_camera_backup_without_the_flag`, l.13038)

**Step 1: Failing test**

```rust
#[tokio::test]
async fn capabilities_advertise_uploaded_folder_links() {
    let app = TestApp::new().await;
    let response = app
        .oneshot(Request::get("/v1/capabilities").body(Body::empty()).expect("build"))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["upload_folder_shares"], true, "{json}");
}
```

**Step 2:** `cargo test -p hcfs-server --test router_oneshot capabilities_advertise_uploaded`
Expected: FAIL (`null != true`).

**Step 3: Implement.** Add the field to `Capabilities`:

```rust
    /// `/v1/folder-shares/uploads`: a folder link whose contents are an
    /// uploaded copy, for a folder that is in no drive. Its own flag because
    /// `folder_shares` is `true` on every server that predates it; a client
    /// that probed with the open would read the 404 of an old server as an
    /// unknown link. Older deployments omit the field; treat absent as
    /// `false`.
    pub upload_folder_shares: bool,
```

In `get_capabilities`, add `upload_folder_shares: true,` with the comment "Always on: the
routes are mounted unconditionally, like the by-hash pair."

**Step 4:** Run it and confirm it passes.

**Step 5: Commit**

```bash
git add hcfs-server/src/shares hcfs-server/tests/router_oneshot.rs
git commit -m "Advertise upload_folder_shares in /v1/capabilities" -m "The desktop shares an outside folder only against a server that has the
upload routes; an old server answers them with the same 404 as a dead
link, so a dedicated flag is the only reliable gate."
```

---

### Task 12: hcfs-client: `FolderShareSource` on listing rows

**Files:**
- Modify: `hcfs-client/src/client/folder_share.rs`: re-export near l.37,
  `FolderShareListItem` (l.164), `ListItemWire` (l.312), `list_folder_shares` mapping
  (l.473-484), tests

**Step 1: Failing tests** (`folder_share.rs` `mod tests`)

```rust
    /// The server serializes source and an uploaded copy's "" scope; an old
    /// server sends neither. Accept null too, so one future server mistake
    /// cannot fail a whole listing.
    #[tokio::test]
    async fn listing_rows_carry_their_source() {
        let server = MockServer::start().await;
        let row = |hash: &str, extra: serde_json::Value| {
            let mut base = json!({
                "token_hash": hash,
                "folder_hash": DRIVE_HASH,
                "path_prefix": "",
                "display_name": "x",
                "created_at": "2026-10-02T00:00:00Z",
                "expires_at": null,
                "revoked_at": null,
            });
            base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            base
        };
        let body = json!([
            row(&"a".repeat(64), json!({})),
            row(&"b".repeat(64), json!({ "source": "upload", "folder_hash": "", "path_prefix": "" })),
            row(&"c".repeat(64), json!({ "source": "upload", "folder_hash": null, "path_prefix": null })),
        ]);
        Mock::given(method("GET"))
            .and(path("/v1/folder-shares"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        let rows = drive_client(&server.uri(), "").list_folder_shares().await.unwrap();
        let sources: Vec<FolderShareSource> = rows.iter().map(|r| r.source).collect();
        assert_eq!(sources, [FolderShareSource::Drive, FolderShareSource::Upload, FolderShareSource::Upload]);
        assert_eq!((rows[2].folder_hash.as_str(), rows[2].path_prefix.as_str()), ("", ""));
    }
```

**Step 2:** `cargo test -p hcfs-client listing_rows_carry_their_source`
Expected: compile error.

**Step 3: Implement**

```rust
pub use hcfs_shared::shares::FolderShareSource;
```

Add to `FolderShareListItem`:

```rust
    /// Drive view or uploaded copy. `folder_hash` / `path_prefix` are `""`
    /// for an uploaded copy.
    pub source: FolderShareSource,
```

Change `ListItemWire` as follows:

```rust
#[derive(Deserialize)]
struct ListItemWire {
    token_hash: String,
    #[serde(default, deserialize_with = "null_as_empty")]
    folder_hash: String,
    #[serde(default, deserialize_with = "null_as_empty")]
    path_prefix: String,
    display_name: String,
    created_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
    #[serde(default)]
    owner_wrap: Option<String>,
    /// Absent on servers that predate uploaded copies: those only had drives.
    #[serde(default)]
    source: FolderShareSource,
}

/// `null` (or absent) reads as `""`: an uploaded copy has no drive scope,
/// and the server sends `""` for it, but a `null` must not fail the list.
fn null_as_empty<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}
```

Map `source: row.source,` in `list_folder_shares`.

**Step 4:** `cargo test -p hcfs-client folder_share`. Expected: PASS.

**Step 5: Commit**

```bash
git add hcfs-client/src/client/folder_share.rs
git commit -m "Read source on folder-share listing rows in hcfs-client" -m "The desktop labels uploaded copies from it. Missing or null scope fields
read as empty so a server-side mistake cannot fail the whole listing."
```

---

### Task 13: hcfs-client: plan, progress and errors for uploaded copies (pure parts)

**Files:**
- Modify: `hcfs-client/src/client/share.rs`: `predict_ciphertext_size` (l.85) and
  `read_chunk_filling` (l.1437) → `pub(crate)`
- Modify: `hcfs-client/src/client/folder_share.rs`: new error variants in
  `FolderShareError` (l.55), `mod upload;` + re-exports
- Create: `hcfs-client/src/client/folder_share/upload.rs`

**Step 1: Failing tests** (in `upload.rs` `mod tests`)

```rust
#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn file_entry(path: &str, size: u64) -> UploadFolderEntry {
        UploadFolderEntry::File {
            relative_path: path.to_string(),
            source: PathBuf::from("/nonexistent").join(path),
            size,
        }
    }

    #[test]
    fn a_plan_sizes_every_file_in_drive_framing() {
        let entries = vec![
            file_entry("empty.txt", 0),
            file_entry("big.bin", 9 * 1024 * 1024),
            UploadFolderEntry::Dir { relative_path: "Empty".into() },
        ];
        let plan = plan_upload(&entries).unwrap();
        // 0 bytes is still one framed chunk: nonce 24 + count 4 + len 4 + tag 16.
        assert_eq!((plan.files[0].ciphertext_size, plan.files[0].total_chunks), (48, 1));
        assert_eq!(plan.files[1].total_chunks, 2, "9 MiB of ciphertext is two 8 MiB PUTs");
        assert_eq!(plan.dirs, ["Empty"]);
        assert_eq!(plan.plaintext_total, 9 * 1024 * 1024);
    }

    #[test]
    fn a_plan_refuses_what_the_server_would() {
        let only_dirs = vec![UploadFolderEntry::Dir { relative_path: "x".into() }];
        assert!(matches!(plan_upload(&only_dirs), Err(FolderShareError::EmptyFolder)));

        let huge = vec![file_entry("huge.mov", MAX_UPLOAD_FOLDER_SHARE_FILE_CIPHERTEXT)];
        let Err(FolderShareError::FileTooLarge { relative_path, .. }) = plan_upload(&huge) else {
            panic!("a file whose ciphertext passes 5 GiB is refused");
        };
        assert_eq!(relative_path, "huge.mov");

        let many: Vec<UploadFolderEntry> = (0..=MAX_UPLOAD_FOLDER_SHARE_FILES)
            .map(|n| file_entry(&format!("f{n}"), 1))
            .collect();
        assert!(matches!(
            plan_upload(&many),
            Err(FolderShareError::TooManyItems { max: MAX_UPLOAD_FOLDER_SHARE_FILES, .. })
        ));
    }

    /// Four files overlap, so encryption and upload interleave. The bar must
    /// not flip between labels: Encrypting until the first byte is sent, then
    /// Uploading only, with totals summed across files, then Finalizing.
    #[test]
    fn progress_is_summed_and_never_flips_back_to_encrypting() {
        let seen: Arc<Mutex<Vec<ShareProgress>>> = Arc::default();
        let sink = Arc::clone(&seen);
        let progress: ShareProgressFn = Arc::new(move |p| sink.lock().unwrap().push(p));
        let entries = vec![file_entry("a", 100), file_entry("b", 300)];
        let plan = plan_upload(&entries).unwrap();
        let sum = ProgressSum::new(Some(progress), &plan);

        sum.add_encrypted(100);
        sum.add_uploaded(148);
        sum.add_encrypted(300);
        sum.add_uploaded(348);
        sum.finalizing();

        let seen = seen.lock().unwrap();
        let phases: Vec<SharePhase> = seen.iter().map(|p| p.phase).collect();
        assert_eq!(phases, [SharePhase::Encrypting, SharePhase::Uploading, SharePhase::Uploading, SharePhase::Finalizing]);
        assert_eq!((seen[0].bytes_done, seen[0].bytes_total), (100, 400));
        assert_eq!((seen[2].bytes_done, seen[2].bytes_total), (496, 496));
    }

    /// The JSON keys the server pins (`folder_shares::types` tests).
    #[test]
    fn upload_wire_keys_match_the_server_pins() {
        let dirs = ["Empty"];
        let open = OpenRequestWire {
            display_name: "Holiday",
            ttl: ShareTtl::Days7,
            file_count: 2,
            total_bytes: 100,
            dirs: &dirs,
        };
        assert_eq!(
            serde_json::to_value(&open).unwrap(),
            serde_json::json!({
                "display_name": "Holiday", "ttl": "7d", "file_count": 2,
                "total_bytes": 100, "dirs": ["Empty"],
            }),
        );
        let file = FileInitRequestWire {
            relative_path: "a/b.txt",
            plaintext_size: 5,
            ciphertext_size: 53,
            total_chunks: 1,
        };
        assert_eq!(
            serde_json::to_value(&file).unwrap(),
            serde_json::json!({
                "relative_path": "a/b.txt", "plaintext_size": 5,
                "ciphertext_size": 53, "total_chunks": 1,
            }),
        );
        let opened: OpenResponseWire = serde_json::from_value(
            serde_json::json!({ "share_token": "tok", "token_hash": "ab" }),
        )
        .unwrap();
        assert_eq!(opened.share_token, "tok");
        let sealed: SealResponseWire =
            serde_json::from_value(serde_json::json!({ "expires_at": null })).unwrap();
        assert!(sealed.expires_at.is_none());
    }
}
```

**Step 2:** `cargo test -p hcfs-client folder_share::upload`
Expected: compile error.

**Step 3: Implement**

In `share.rs`, change `fn predict_ciphertext_size` and `async fn read_chunk_filling` to
`pub(crate)`.

In `folder_share.rs`, add these variants to `FolderShareError` before `Share`:

```rust
    /// An uploaded copy needs at least one file (`create_upload_folder_share`).
    #[error("the folder has no files to share")]
    EmptyFolder,
    /// More files, or listed directories, than one link may hold.
    #[error("the folder holds {count} items; a link can hold at most {max}")]
    TooManyItems { count: usize, max: u32 },
    /// One file's ciphertext would pass the per-file cap.
    #[error("{relative_path} is too large to share ({size} bytes)")]
    FileTooLarge { relative_path: String, size: u64 },
    /// A file changed size or modification time, or vanished, while it was
    /// being shared. Nothing partial is left behind: the link was aborted.
    #[error(
        "{relative_path} changed while it was being shared; \
         share the folder again once it stops changing"
    )]
    SourceChanged { relative_path: String },
    /// The caller's cancellation token fired; the link was aborted.
    #[error("folder share cancelled")]
    Cancelled,
```

Below the imports, add:

```rust
mod upload;

pub use upload::{UploadFolderEntry, UploadFolderShareOptions};
```

Create `hcfs-client/src/client/folder_share/upload.rs` with the module doc, imports,
constants, public types, plan, `ProgressSum`, wire types and `SourceStamp`. The network
methods arrive in Task 14.

```rust
//! Uploaded-copy folder links: share a folder that is in no drive by
//! uploading an encrypted copy of it under the link's own key.
//!
//! Downstream it is an ordinary folder link. The recipient page browses and
//! downloads it through the same `/v1/folder-shares/{token}` routes, and the
//! owner lists, re-expires and revokes it like any other. The URL carries
//! the key the same way. Only the contents differ: a fresh random 32-byte
//! key encrypts every file in the drive framing
//! (`crypto::encrypt_stream_with_hash`, what drive uploads write and the
//! recipient page decrypts), and the bytes live under the link.
//!
//! Flow: plan (validate and size everything, no I/O), open (the server
//! mints the token and holds quota), upload [`FILE_CONCURRENCY`] files at
//! once, seal (the server checks every declared file arrived and starts the
//! expiry clock), then keystore and URL. Any failure or cancellation after
//! open aborts the link, so the server keeps no half-uploaded copy past
//! the reaper's next sweep.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use bytes::Bytes;
use chrono::{DateTime, Utc};
use futures_util::stream::{self, TryStreamExt};
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use hcfs_shared::shares::{
    MAX_UPLOAD_FOLDER_SHARE_DIRS, MAX_UPLOAD_FOLDER_SHARE_FILE_CIPHERTEXT,
    MAX_UPLOAD_FOLDER_SHARE_FILES,
};

use crate::client::HcfsClient;
use crate::client::folder_share::{
    CreatedFolderShare, FolderShareError, ShareTtl, TOKEN_HASH_LOG_PREFIX_LEN,
    build_folder_share_url_for, folder_share_token_hash, network_error, reqwest_without_url,
};
use crate::client::share::{
    ShareError, ShareKeystore, SharePhase, ShareProgress, ShareProgressFn, ShareSecret,
    TRANSPORT_CHUNK_SIZE, generate_share_key, predict_ciphertext_size, read_chunk_filling,
    validate_share_password, wrap_share_key,
};
use crate::crypto;
use crate::sync::SyncError;

/// Files in flight at once. Enough to keep the link busy while one file
/// encrypts; each in-flight file stages one encrypted tempfile on disk.
const FILE_CONCURRENCY: usize = 4;

/// Attempts per chunk PUT on a transport error, a 5xx or a 429. A chunk
/// claim is idempotent for identical bytes, so a retry cannot double-store.
const CHUNK_ATTEMPTS: u32 = 3;

/// Backoff unit between chunk attempts (×1, ×2).
const CHUNK_RETRY_BASE: Duration = Duration::from_millis(500);

// =============================================================================
// Public types
// =============================================================================

/// One item of the folder being shared, as the caller scanned it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UploadFolderEntry {
    /// A regular file. `size` is the scan-time stat and is binding: a file
    /// whose size or modification time changes before it has been read
    /// fails the share ([`FolderShareError::SourceChanged`]).
    File {
        /// `/`-joined, relative to the shared folder, no leading slash.
        relative_path: String,
        source: PathBuf,
        size: u64,
    },
    /// A directory. Only directories with no file beneath them need listing
    /// (file paths imply the rest), but listing more is harmless.
    Dir { relative_path: String },
}

/// What the caller chooses about an uploaded copy; the same shape as
/// [`crate::client::folder_share::FolderShareOptions`] minus the drive scope.
#[derive(Clone, Copy, Debug)]
pub struct UploadFolderShareOptions<'a> {
    /// Recipient page header; the shared folder's own name.
    pub display_name: &'a str,
    /// Applied at seal, so a slow upload does not shorten the link.
    pub ttl: ShareTtl,
    /// `Some` makes a `#p=` link; validated before any request.
    pub password: Option<&'a str>,
    /// Origin the recipient URL is built against.
    pub console_base_url: &'a str,
}

// =============================================================================
// Plan
// =============================================================================

#[derive(Debug)]
struct PlannedFile<'e> {
    relative_path: &'e str,
    source: &'e Path,
    size: u64,
    ciphertext_size: u64,
    total_chunks: u32,
}

/// Everything the upload will send, decided before any request.
#[derive(Debug)]
struct UploadPlan<'e> {
    files: Vec<PlannedFile<'e>>,
    dirs: Vec<&'e str>,
    plaintext_total: u64,
    ciphertext_total: u64,
}

fn plan_upload(entries: &[UploadFolderEntry]) -> Result<UploadPlan<'_>, FolderShareError> {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    for entry in entries {
        match entry {
            UploadFolderEntry::File {
                relative_path,
                source,
                size,
            } => files.push(plan_file(relative_path, source, *size)?),
            UploadFolderEntry::Dir { relative_path } => dirs.push(relative_path.as_str()),
        }
    }
    if files.is_empty() {
        return Err(FolderShareError::EmptyFolder);
    }
    check_item_count(files.len(), MAX_UPLOAD_FOLDER_SHARE_FILES)?;
    check_item_count(dirs.len(), MAX_UPLOAD_FOLDER_SHARE_DIRS)?;
    let plaintext_total = files.iter().fold(0u64, |sum, f| sum.saturating_add(f.size));
    let ciphertext_total = files
        .iter()
        .fold(0u64, |sum, f| sum.saturating_add(f.ciphertext_size));
    Ok(UploadPlan {
        files,
        dirs,
        plaintext_total,
        ciphertext_total,
    })
}

fn plan_file<'e>(
    relative_path: &'e str,
    source: &'e Path,
    size: u64,
) -> Result<PlannedFile<'e>, FolderShareError> {
    let too_large = || FolderShareError::FileTooLarge {
        relative_path: relative_path.to_string(),
        size,
    };
    let ciphertext_size = predict_ciphertext_size(size);
    if ciphertext_size > MAX_UPLOAD_FOLDER_SHARE_FILE_CIPHERTEXT {
        return Err(too_large());
    }
    let chunks = ciphertext_size.div_ceil(TRANSPORT_CHUNK_SIZE as u64).max(1);
    let total_chunks = u32::try_from(chunks).map_err(|_| too_large())?;
    Ok(PlannedFile {
        relative_path,
        source,
        size,
        ciphertext_size,
        total_chunks,
    })
}

fn check_item_count(count: usize, max: u32) -> Result<(), FolderShareError> {
    if count > max as usize {
        return Err(FolderShareError::TooManyItems { count, max });
    }
    Ok(())
}

// =============================================================================
// Progress
// =============================================================================

/// Folds per-file progress into the one [`ShareProgress`] stream the share
/// UI already renders.
///
/// Four files are in flight at once, so one file's encryption overlaps
/// another's upload. Reporting both would flip the label back and forth.
/// Instead the bar reports `Encrypting` (plaintext bytes) only until the
/// first ciphertext byte is sent, then `Uploading` (ciphertext bytes summed
/// across files) for the rest. Both counts only grow.
struct ProgressSum {
    progress: Option<ShareProgressFn>,
    plaintext_total: u64,
    ciphertext_total: u64,
    encrypted: AtomicU64,
    uploaded: AtomicU64,
    uploading: AtomicBool,
}

impl ProgressSum {
    fn new(progress: Option<ShareProgressFn>, plan: &UploadPlan<'_>) -> Self {
        Self {
            progress,
            plaintext_total: plan.plaintext_total,
            ciphertext_total: plan.ciphertext_total,
            encrypted: AtomicU64::new(0),
            uploaded: AtomicU64::new(0),
            uploading: AtomicBool::new(false),
        }
    }

    fn emit(&self, phase: SharePhase, bytes_done: u64, bytes_total: u64) {
        if let Some(progress) = &self.progress {
            progress(ShareProgress {
                phase,
                bytes_done: bytes_done.min(bytes_total),
                bytes_total,
            });
        }
    }

    fn add_encrypted(&self, bytes: u64) {
        let done = self.encrypted.fetch_add(bytes, Ordering::Relaxed) + bytes;
        if !self.uploading.load(Ordering::Relaxed) {
            self.emit(SharePhase::Encrypting, done, self.plaintext_total);
        }
    }

    fn add_uploaded(&self, bytes: u64) {
        self.uploading.store(true, Ordering::Relaxed);
        let done = self.uploaded.fetch_add(bytes, Ordering::Relaxed) + bytes;
        self.emit(SharePhase::Uploading, done, self.ciphertext_total);
    }

    fn finalizing(&self) {
        self.emit(SharePhase::Finalizing, self.ciphertext_total, self.ciphertext_total);
    }
}

// =============================================================================
// Wire types (private; the server pins the same keys)
// =============================================================================

#[derive(Serialize)]
struct OpenRequestWire<'a> {
    display_name: &'a str,
    ttl: ShareTtl,
    file_count: u32,
    total_bytes: u64,
    dirs: &'a [&'a str],
}

/// The server also returns `token_hash`; the client derives it from the
/// token instead, so the two cannot disagree.
#[derive(Deserialize)]
struct OpenResponseWire {
    share_token: String,
}

#[derive(Serialize)]
struct FileInitRequestWire<'a> {
    relative_path: &'a str,
    plaintext_size: u64,
    ciphertext_size: u64,
    total_chunks: u32,
}

#[derive(Deserialize)]
struct FileInitResponseWire {
    file_id: i64,
}

#[derive(Deserialize)]
struct SealResponseWire {
    expires_at: Option<DateTime<Utc>>,
}

// =============================================================================
// Source checks
// =============================================================================

/// What a file must still look like when it has been read.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SourceStamp {
    size: u64,
    modified: Option<SystemTime>,
}

/// `None` when the path is gone or no longer a regular file.
async fn stamp(path: &Path) -> Option<SourceStamp> {
    let meta = tokio::fs::metadata(path).await.ok()?;
    meta.is_file().then(|| SourceStamp {
        size: meta.len(),
        modified: meta.modified().ok(),
    })
}

fn source_changed(relative_path: &str) -> FolderShareError {
    FolderShareError::SourceChanged {
        relative_path: relative_path.to_string(),
    }
}

fn io_error(context: &str, err: std::io::Error) -> FolderShareError {
    FolderShareError::Share(ShareError::Io(format!("{context}: {err}")))
}
```

In `folder_share.rs`, change `TOKEN_HASH_LOG_PREFIX_LEN`, `network_error` and
`reqwest_without_url` to `pub(super)` so the child module can name them in absolute `use`
paths.

The import list above already includes what Task 14 needs. Until Task 14 lands, the
non-test build reports those imports and the not-yet-called private items as unused. That
is why this task does not commit (Step 5).

**Step 4:** `cargo test -p hcfs-client folder_share::upload`. Expected: the four tests PASS.
Warnings about unused imports and items are expected at this point.

**Step 5: No commit yet.** The plan, progress and wire types are only reachable through
`create_upload_folder_share`. Committing now would put `dead_code` / `unused_imports`
warnings in history, which the zero-warnings policy forbids. Task 14 commits both tasks
together, with a body that covers both.

---

### Task 14: hcfs-client: `create_upload_folder_share`

**Files:**
- Modify: `hcfs-client/src/client/folder_share/upload.rs`

**Step 1: Failing tests** (append to `upload.rs` `mod tests`)

```rust
    use std::collections::HashMap;
    use std::io::Cursor;

    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use wiremock::matchers::{method, path, path_regex};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    use crate::client::HcfsClientConfig;

    const TOKEN: &str = "tok-upload";

    #[derive(Default)]
    struct MemoryKeystore(Mutex<HashMap<String, ShareSecret>>);

    impl ShareKeystore for MemoryKeystore {
        fn put(&self, token: &str, secret: &ShareSecret) -> Result<(), ShareError> {
            self.0.lock().unwrap().insert(token.to_string(), secret.clone());
            Ok(())
        }
        fn get(&self, token: &str) -> Result<Option<ShareSecret>, ShareError> {
            Ok(self.0.lock().unwrap().get(token).cloned())
        }
        fn forget(&self, token: &str) -> Result<(), ShareError> {
            self.0.lock().unwrap().remove(token);
            Ok(())
        }
    }

    /// Answers a file init with an id derived from its path, so the test can
    /// map chunk PUTs back to files whatever order the four uploads run in.
    struct FileIds;

    impl wiremock::Respond for FileIds {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
            let id = file_id_for(body["relative_path"].as_str().unwrap());
            ResponseTemplate::new(201).set_body_json(serde_json::json!({ "file_id": id }))
        }
    }

    fn file_id_for(path: &str) -> i64 {
        i64::from(u16::from_le_bytes([path.as_bytes()[0], path.len() as u8]))
    }

    fn hash() -> String {
        folder_share_token_hash(TOKEN)
    }

    fn client(server: &MockServer) -> HcfsClient {
        HcfsClient::new(HcfsClientConfig {
            base_url: server.uri(),
            ..HcfsClientConfig::default()
        })
        .expect("client constructs")
    }

    fn options(password: Option<&str>) -> UploadFolderShareOptions<'_> {
        UploadFolderShareOptions {
            display_name: "Holiday",
            ttl: ShareTtl::Days7,
            password,
            console_base_url: "https://console.example.com",
        }
    }

    async fn mount_open(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/v1/folder-shares/uploads"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "share_token": TOKEN, "token_hash": hash(),
            })))
            .expect(1)
            .mount(server)
            .await;
    }

    async fn mount_happy_path(server: &MockServer) {
        mount_open(server).await;
        let base = format!("^/v1/folder-shares/uploads/{}", hash());
        Mock::given(method("POST"))
            .and(path_regex(format!("{base}/files$")))
            .respond_with(FileIds)
            .mount(server)
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(format!("{base}/files/[0-9]+/chunks/[0-9]+$")))
            .respond_with(ResponseTemplate::new(204))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path_regex(format!("{base}/files/[0-9]+/complete$")))
            .respond_with(ResponseTemplate::new(204))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/v1/folder-shares/uploads/{}/complete", hash())))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "expires_at": null })))
            .expect(1)
            .mount(server)
            .await;
    }

    async fn mount_abort(server: &MockServer) {
        Mock::given(method("DELETE"))
            .and(path(format!("/v1/folder-shares/uploads/{}", hash())))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(server)
            .await;
    }

    /// A temp folder with `files`; returns the dir guard and the entries.
    fn folder(files: &[(&str, &[u8])]) -> (tempfile::TempDir, Vec<UploadFolderEntry>) {
        let dir = tempfile::tempdir().unwrap();
        let mut entries = Vec::new();
        for (relative, contents) in files {
            let source = dir.path().join(relative);
            std::fs::create_dir_all(source.parent().unwrap()).unwrap();
            std::fs::write(&source, contents).unwrap();
            entries.push(UploadFolderEntry::File {
                relative_path: relative.to_string(),
                source,
                size: contents.len() as u64,
            });
        }
        (dir, entries)
    }

    fn key_from(url: &str) -> [u8; 32] {
        let fragment = url.split("#k=").nth(1).expect("a public link carries #k=");
        URL_SAFE_NO_PAD.decode(fragment).unwrap().try_into().unwrap()
    }

    #[tokio::test]
    async fn uploads_every_file_encrypted_under_the_link_key_then_seals() {
        let server = MockServer::start().await;
        mount_happy_path(&server).await;
        let (_dir, mut entries) = folder(&[("a.txt", b"hello"), ("sub/b.bin", b"")]);
        entries.push(UploadFolderEntry::Dir { relative_path: "Empty".into() });
        let keystore = MemoryKeystore::default();

        let created = client(&server)
            .create_upload_folder_share(entries, &options(None), &keystore, None, CancellationToken::new())
            .await
            .expect("upload succeeds");

        assert!(created.share_url.starts_with(&format!("https://console.example.com/share/folder/{TOKEN}#k=")));
        assert_eq!(keystore.0.lock().unwrap().len(), 1);
        let key = key_from(&created.share_url);

        let requests = server.received_requests().await.unwrap();
        let open: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(open["file_count"], 2);
        assert_eq!(open["dirs"], serde_json::json!(["Empty"]));
        for (relative, plaintext) in [("a.txt", &b"hello"[..]), ("sub/b.bin", &b""[..])] {
            let chunk_path = format!("/files/{}/chunks/0", file_id_for(relative));
            let body = &requests
                .iter()
                .find(|r| r.method.as_str() == "PUT" && r.url.path().ends_with(&chunk_path))
                .unwrap_or_else(|| panic!("chunk for {relative}"))
                .body;
            let mut decrypted = Vec::new();
            crypto::decrypt_stream(&mut Cursor::new(body), &mut decrypted, &key, None, None::<fn(u64, u64)>)
                .expect("drive framing under the link key");
            assert_eq!(decrypted, plaintext, "{relative}");
        }
    }

    #[tokio::test]
    async fn a_password_link_stores_only_the_wrapped_key() {
        let server = MockServer::start().await;
        mount_happy_path(&server).await;
        let (_dir, entries) = folder(&[("a.txt", b"hello")]);
        let keystore = MemoryKeystore::default();
        let created = client(&server)
            .create_upload_folder_share(entries, &options(Some("correct horse battery")), &keystore, None, CancellationToken::new())
            .await
            .unwrap();
        assert!(created.share_url.contains("#p="), "{}", created.share_url);
        assert!(matches!(keystore.0.lock().unwrap().get(TOKEN), Some(ShareSecret::Private(_))));
    }

    #[tokio::test]
    async fn a_failed_chunk_aborts_the_link_and_stores_nothing() {
        let server = MockServer::start().await;
        mount_open(&server).await;
        mount_abort(&server).await;
        let base = format!("^/v1/folder-shares/uploads/{}", hash());
        Mock::given(method("POST"))
            .and(path_regex(format!("{base}/files$")))
            .respond_with(FileIds)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(format!("{base}/files/[0-9]+/chunks/[0-9]+$")))
            .respond_with(ResponseTemplate::new(400).set_body_string("chunk refused"))
            .mount(&server)
            .await;
        let (_dir, entries) = folder(&[("a.txt", b"hello")]);
        let keystore = MemoryKeystore::default();

        let err = client(&server)
            .create_upload_folder_share(entries, &options(None), &keystore, None, CancellationToken::new())
            .await
            .expect_err("a refused chunk fails the share");
        assert!(matches!(err, FolderShareError::Server { status: 400, .. }), "{err:?}");
        assert!(keystore.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_file_that_changed_since_the_scan_fails_naming_it() {
        let server = MockServer::start().await;
        mount_open(&server).await;
        mount_abort(&server).await;
        let (_dir, mut entries) = folder(&[("notes/a.txt", b"hello")]);
        if let UploadFolderEntry::File { size, .. } = &mut entries[0] {
            *size = 6;
        }
        let err = client(&server)
            .create_upload_folder_share(entries, &options(None), &MemoryKeystore::default(), None, CancellationToken::new())
            .await
            .expect_err("a size change is fatal");
        let FolderShareError::SourceChanged { relative_path } = err else {
            panic!("expected SourceChanged, got {err:?}");
        };
        assert_eq!(relative_path, "notes/a.txt");
    }

    #[tokio::test]
    async fn cancelling_mid_upload_aborts_the_link() {
        let server = MockServer::start().await;
        mount_open(&server).await;
        mount_abort(&server).await;
        let base = format!("^/v1/folder-shares/uploads/{}", hash());
        Mock::given(method("POST"))
            .and(path_regex(format!("{base}/files$")))
            .respond_with(FileIds)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(format!("{base}/files/[0-9]+/chunks/[0-9]+$")))
            .respond_with(ResponseTemplate::new(204).set_delay(Duration::from_secs(10)))
            .mount(&server)
            .await;
        let (_dir, entries) = folder(&[("a.txt", b"hello")]);
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            trigger.cancel();
        });
        let err = client(&server)
            .create_upload_folder_share(entries, &options(None), &MemoryKeystore::default(), None, cancel)
            .await
            .expect_err("cancelled");
        assert!(matches!(err, FolderShareError::Cancelled), "{err:?}");
    }

    #[tokio::test]
    async fn an_already_cancelled_token_sends_nothing() {
        let server = MockServer::start().await;
        let (_dir, entries) = folder(&[("a.txt", b"hello")]);
        let cancel = CancellationToken::new();
        cancel.cancel();
        let err = client(&server)
            .create_upload_folder_share(entries, &options(None), &MemoryKeystore::default(), None, cancel)
            .await
            .expect_err("cancelled");
        assert!(matches!(err, FolderShareError::Cancelled));
        assert!(server.received_requests().await.unwrap().is_empty());
    }
```

The `.expect(1)` mocks are verified when the `MockServer` drops at the end of each test, so
the abort `DELETE` is asserted in every failure test. Check that `HcfsClientConfig`
implements `Default` (`folder_share.rs` tests already use `..HcfsClientConfig::default()`).

**Step 2:** `cargo test -p hcfs-client folder_share::upload`
Expected: compile error (`no method create_upload_folder_share`).

**Step 3: Implement** (append to `upload.rs`)

```rust
// =============================================================================
// HcfsClient
// =============================================================================

/// One file's address on the server.
#[derive(Clone, Copy)]
struct FileTarget<'a> {
    token_hash: &'a str,
    file_id: i64,
}

/// Map a non-2xx upload-route response. A 404 is the link being gone
/// (revoked, reaped, not ours), the same collapse every folder-share route
/// makes; anything else keeps its status and body.
async fn upload_response(resp: reqwest::Response) -> Result<reqwest::Response, FolderShareError> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    if status.as_u16() == 404 {
        return Err(FolderShareError::NotFound);
    }
    let message = resp.text().await.unwrap_or_default();
    Err(FolderShareError::Server {
        status: status.as_u16(),
        message,
    })
}

fn parse_error(what: &str, err: reqwest::Error) -> FolderShareError {
    FolderShareError::Network(format!("parse {what} response: {}", reqwest_without_url(err)))
}

/// Transport failures, 5xx and 429 are worth another attempt; a 4xx is the
/// server refusing this exact chunk and will refuse it again.
fn is_retryable(err: &FolderShareError) -> bool {
    match err {
        FolderShareError::Network(_) => true,
        FolderShareError::Server { status, .. } => *status >= 500 || *status == 429,
        _ => false,
    }
}

impl HcfsClient {
    /// Share a folder that is in no drive as a folder link, by uploading an
    /// encrypted copy under a fresh link key. See the module docs for the
    /// flow; the result is the same [`CreatedFolderShare`] a drive link
    /// returns, so URL building, the keystore and owner wraps are shared.
    ///
    /// Works with an account-scoped client (empty `folder_hash`): an
    /// uploaded copy belongs to no drive.
    ///
    /// `progress` gets the same [`ShareProgress`] stream as a file share,
    /// summed across files (see [`ProgressSum`]). It may fire from blocking
    /// encryption threads; keep it cheap and non-blocking.
    ///
    /// # Errors
    ///
    /// Before any request: [`ShareError::WeakPassword`] (via
    /// [`FolderShareError::Share`]), [`FolderShareError::EmptyFolder`],
    /// [`FolderShareError::TooManyItems`], [`FolderShareError::FileTooLarge`],
    /// [`FolderShareError::Cancelled`]. After open, every error aborts the
    /// link first: [`FolderShareError::SourceChanged`] naming the file,
    /// [`FolderShareError::Cancelled`], or the transport and server variants.
    pub async fn create_upload_folder_share(
        &self,
        entries: Vec<UploadFolderEntry>,
        options: &UploadFolderShareOptions<'_>,
        keystore: &dyn ShareKeystore,
        progress: Option<ShareProgressFn>,
        cancel: CancellationToken,
    ) -> Result<CreatedFolderShare, FolderShareError> {
        if let Some(password) = options.password {
            validate_share_password(password)?;
        }
        let plan = plan_upload(&entries)?;
        if cancel.is_cancelled() {
            return Err(FolderShareError::Cancelled);
        }
        // Decided once, before minting, as in `create_folder_share`: the
        // same secret lands in the keystore and shapes the URL.
        let key = generate_share_key();
        let secret = match options.password {
            Some(password) => ShareSecret::Private(wrap_share_key(password, &key)?),
            None => ShareSecret::Public(key),
        };

        let share_token = self.open_upload(&plan, options).await?;
        let token_hash = folder_share_token_hash(&share_token);
        let sum = Arc::new(ProgressSum::new(progress, &plan));
        let expires_at = match self.fill_and_seal(&token_hash, &plan, &key, &sum, &cancel).await {
            Ok(expires_at) => expires_at,
            Err(e) => {
                self.abort_upload(&token_hash).await;
                return Err(e);
            }
        };

        if let Err(e) = keystore.put(&share_token, &secret) {
            warn!(error = ?e, "folder-share keystore put failed; revoking the new link");
            self.abort_upload(&token_hash).await;
            return Err(e.into());
        }
        let share_url = build_folder_share_url_for(options.console_base_url, &share_token, &secret);
        debug!(
            files = plan.files.len(),
            private = secret.is_private(),
            "uploaded folder share created"
        );
        Ok(CreatedFolderShare {
            share_token,
            share_url,
            expires_at,
        })
    }

    /// Upload every file (cancellable), then seal. The seal itself is NOT
    /// raced against cancellation: once sent it may commit, and a link that
    /// committed must be found and revoked, not orphaned mid-flight.
    async fn fill_and_seal(
        &self,
        token_hash: &str,
        plan: &UploadPlan<'_>,
        key: &[u8; 32],
        sum: &Arc<ProgressSum>,
        cancel: &CancellationToken,
    ) -> Result<Option<DateTime<Utc>>, FolderShareError> {
        tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(FolderShareError::Cancelled),
            uploaded = self.upload_files(token_hash, plan, key, sum) => uploaded?,
        }
        sum.finalizing();
        self.seal_upload(token_hash).await
    }

    async fn open_upload(
        &self,
        plan: &UploadPlan<'_>,
        options: &UploadFolderShareOptions<'_>,
    ) -> Result<String, FolderShareError> {
        let body = OpenRequestWire {
            display_name: options.display_name,
            ttl: options.ttl,
            file_count: u32::try_from(plan.files.len()).unwrap_or(u32::MAX),
            total_bytes: plan.plaintext_total,
            dirs: &plan.dirs,
        };
        let url = format!("{}/v1/folder-shares/uploads", self.base_url().await?);
        let resp = self
            .client
            .post(&url)
            .headers(self.cached_headers.clone())
            .json(&body)
            .send()
            .await
            .map_err(network_error)?;
        let opened: OpenResponseWire = upload_response(resp)
            .await?
            .json()
            .await
            .map_err(|e| parse_error("open", e))?;
        Ok(opened.share_token)
    }

    async fn upload_files(
        &self,
        token_hash: &str,
        plan: &UploadPlan<'_>,
        key: &[u8; 32],
        sum: &Arc<ProgressSum>,
    ) -> Result<(), FolderShareError> {
        // First error wins: the stream stops and drops the other in-flight
        // files, whose partial chunks the abort/reaper then collects.
        stream::iter(plan.files.iter().map(Ok::<_, FolderShareError>))
            .try_for_each_concurrent(FILE_CONCURRENCY, |file| {
                self.upload_file(token_hash, file, key, sum)
            })
            .await
    }

    /// One file: stat, declare, encrypt (re-stat right after the read),
    /// send its chunks, complete.
    async fn upload_file(
        &self,
        token_hash: &str,
        file: &PlannedFile<'_>,
        key: &[u8; 32],
        sum: &Arc<ProgressSum>,
    ) -> Result<(), FolderShareError> {
        let before = stamp(file.source)
            .await
            .filter(|stamp| stamp.size == file.size)
            .ok_or_else(|| source_changed(file.relative_path))?;
        let file_id = self.init_upload_file(token_hash, file).await?;
        let encrypted = encrypt_source(file, *key, Arc::clone(sum)).await;
        // The bytes are captured now; a change during the read is exactly
        // what must fail, and a change later cannot alter what is sent.
        if stamp(file.source).await != Some(before) {
            return Err(source_changed(file.relative_path));
        }
        let ciphertext = encrypted?;
        let target = FileTarget { token_hash, file_id };
        self.put_file_chunks(target, &ciphertext, file.total_chunks, sum).await?;
        self.post_empty(&format!(
            "/v1/folder-shares/uploads/{token_hash}/files/{file_id}/complete"
        ))
        .await
        .map(drop)
    }

    async fn init_upload_file(
        &self,
        token_hash: &str,
        file: &PlannedFile<'_>,
    ) -> Result<i64, FolderShareError> {
        let body = FileInitRequestWire {
            relative_path: file.relative_path,
            plaintext_size: file.size,
            ciphertext_size: file.ciphertext_size,
            total_chunks: file.total_chunks,
        };
        let url = format!(
            "{}/v1/folder-shares/uploads/{token_hash}/files",
            self.base_url().await?
        );
        let resp = self
            .client
            .post(&url)
            .headers(self.cached_headers.clone())
            .json(&body)
            .send()
            .await
            .map_err(network_error)?;
        let created: FileInitResponseWire = upload_response(resp)
            .await?
            .json()
            .await
            .map_err(|e| parse_error("file init", e))?;
        Ok(created.file_id)
    }

    async fn put_file_chunks(
        &self,
        target: FileTarget<'_>,
        ciphertext: &NamedTempFile,
        total_chunks: u32,
        sum: &ProgressSum,
    ) -> Result<(), FolderShareError> {
        let mut source = tokio::fs::File::open(ciphertext.path())
            .await
            .map_err(|e| io_error("open ciphertext", e))?;
        let mut buf = vec![0u8; TRANSPORT_CHUNK_SIZE];
        for index in 0..total_chunks {
            let read = read_chunk_filling(&mut source, &mut buf)
                .await
                .map_err(|e| io_error("read ciphertext", e))?;
            if read == 0 {
                return Err(FolderShareError::Share(ShareError::Crypto(format!(
                    "ciphertext ended at chunk {index} of {total_chunks}"
                ))));
            }
            let body = Bytes::copy_from_slice(&buf[..read]);
            self.put_chunk_with_retry(target, index, body).await?;
            sum.add_uploaded(read as u64);
        }
        Ok(())
    }

    async fn put_chunk_with_retry(
        &self,
        target: FileTarget<'_>,
        index: u32,
        body: Bytes,
    ) -> Result<(), FolderShareError> {
        let url = format!(
            "{}/v1/folder-shares/uploads/{}/files/{}/chunks/{index}",
            self.base_url().await?,
            target.token_hash,
            target.file_id,
        );
        let mut attempt = 1;
        loop {
            let sent = self
                .client
                .put(&url)
                .headers(self.cached_headers.clone())
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(body.clone())
                .send()
                .await
                .map_err(network_error);
            let result = match sent {
                Ok(resp) => upload_response(resp).await.map(drop),
                Err(e) => Err(e),
            };
            match result {
                Err(e) if attempt < CHUNK_ATTEMPTS && is_retryable(&e) => {
                    tokio::time::sleep(CHUNK_RETRY_BASE * attempt).await;
                    attempt += 1;
                }
                other => return other,
            }
        }
    }

    async fn seal_upload(&self, token_hash: &str) -> Result<Option<DateTime<Utc>>, FolderShareError> {
        let resp = self
            .post_empty(&format!("/v1/folder-shares/uploads/{token_hash}/complete"))
            .await?;
        let sealed: SealResponseWire = resp.json().await.map_err(|e| parse_error("seal", e))?;
        Ok(sealed.expires_at)
    }

    /// Body-less POST with an explicit `Content-Length: 0`: the Arion
    /// ingress proxy answers a POST without one with 411 before it reaches
    /// the server (same quirk as `share::post_share_complete`).
    async fn post_empty(&self, path: &str) -> Result<reqwest::Response, FolderShareError> {
        let url = format!("{}{path}", self.base_url().await?);
        let resp = self
            .client
            .post(&url)
            .headers(self.cached_headers.clone())
            .header(reqwest::header::CONTENT_LENGTH, "0")
            .send()
            .await
            .map_err(network_error)?;
        upload_response(resp).await
    }

    /// Best-effort teardown of a link that will not be returned. Abort
    /// answers 404 once the link is sealed (the seal landed though its
    /// response did not), so fall back to revoking it: no copy may outlive
    /// a share the caller was told failed.
    async fn abort_upload(&self, token_hash: &str) {
        let prefix = &token_hash[..TOKEN_HASH_LOG_PREFIX_LEN.min(token_hash.len())];
        match self
            .delete_folder_share_at(&format!("/v1/folder-shares/uploads/{token_hash}"))
            .await
        {
            Ok(()) => {}
            Err(FolderShareError::NotFound) => {
                if let Err(e) = self.revoke_folder_share_by_hash(token_hash).await
                    && !matches!(e, FolderShareError::NotFound)
                {
                    warn!(token_hash_prefix = %prefix, error = %e, "revoking a failed folder share upload failed");
                }
            }
            Err(e) => warn!(
                token_hash_prefix = %prefix,
                error = %e,
                "aborting a failed folder share upload failed; the server reaps it once idle"
            ),
        }
    }
}

/// Encrypt one source file into a tempfile on a blocking thread, in the
/// drive framing the recipient page decrypts. The framing is a pure
/// function of the bytes read, so a length other than the plan's means the
/// file changed under the read.
async fn encrypt_source(
    file: &PlannedFile<'_>,
    key: [u8; 32],
    sum: Arc<ProgressSum>,
) -> Result<NamedTempFile, FolderShareError> {
    let ciphertext = NamedTempFile::new().map_err(|e| io_error("ciphertext tempfile", e))?;
    let source = file.source.to_path_buf();
    let target = ciphertext.path().to_path_buf();
    let size = file.size;
    tokio::task::spawn_blocking(move || encrypt_blocking(&source, &target, &key, size, &sum))
        .await
        .map_err(|e| FolderShareError::Share(ShareError::Crypto(format!("encrypt task panicked: {e}"))))?
        .map_err(|e| FolderShareError::Share(ShareError::Crypto(e.to_string())))?;
    let written = tokio::fs::metadata(ciphertext.path())
        .await
        .map_err(|e| io_error("ciphertext stat", e))?
        .len();
    if written != file.ciphertext_size {
        return Err(source_changed(file.relative_path));
    }
    Ok(ciphertext)
}

fn encrypt_blocking(
    source: &Path,
    target: &Path,
    key: &[u8; 32],
    size: u64,
    sum: &ProgressSum,
) -> Result<(), SyncError> {
    let mut reader = std::fs::File::open(source)?;
    let mut writer = std::fs::File::create(target)?;
    let mut hasher = blake3::Hasher::new();
    // The encryptor reports cumulative bytes for this file; the sum wants
    // the increment.
    let last = AtomicU64::new(0);
    let report = |done: u64, _total: u64| {
        let previous = last.swap(done, Ordering::Relaxed);
        sum.add_encrypted(done.saturating_sub(previous));
    };
    crypto::encrypt_stream_with_hash(&mut reader, &mut writer, key, size, &mut hasher, Some(report))?;
    Ok(())
}
```

The `if let … && …` let-chain in `abort_upload` needs edition 2024 (the crate uses it).
`blake3` is a dependency of `hcfs-client`. `create_upload_folder_share` is about 45 lines and every other function is
under 40.

**Step 4: Run the tests and confirm they pass**

```bash
cargo test -p hcfs-client folder_share
cargo clippy -p hcfs-client --all-targets -- -D warnings
```

Expected: PASS, with no warnings.

**Step 5: Commit**

```bash
git add hcfs-client/src/client
git commit -m "Add create_upload_folder_share to hcfs-client" -m "Plans the folder before any request (drive-framing sizes, empty folder,
5 GiB per file, 50,000 items), encrypts each file under a fresh link key,
uploads four files at once with retried chunks, re-checks size and mtime
around the read so a file still being written fails the share by name,
sums progress into the existing share stream, and aborts the server-side
link on any error or cancellation, falling back to revoke when the seal
landed unseen."
```

---

### Task 15: Client↔server end-to-end test

**Files:**
- Create: `hcfs-e2e-tests/tests/upload_folder_shares.rs`
- Modify: `hcfs-e2e-tests/Cargo.toml` (`[dev-dependencies]`: `tokio-util = { workspace = true }`)

**Step 1: Write the test** (it is red until Tasks 2-14 are deployed to the target server, and
it skips quietly where the capability is absent)

```rust
//! End-to-end: an outside folder shared as an uploaded copy, against a real
//! server (`e2e-local` builds it from this branch; `e2e-live` hits prod).
//!
//! Same production-safety convention as `folder_shares.rs`: every anonymous
//! GET happens before the revoke, and every assertion over the captured
//! responses after it, so a failing assertion cannot leave a live link on
//! production. The token, URL and key never appear in a failure message.
//!
//! Capability gate: skips quietly while the target server does not
//! advertise `upload_folder_shares` (production until this deploys);
//! `e2e-local` always has it, so the routes are exercised on every run.

mod common;

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use common::{USER_BEARER_PROBE_SS58, billing_bypass, server_url, user_scoped_env};
use hcfs_client::client::folder_share::{ShareTtl, UploadFolderEntry, UploadFolderShareOptions, folder_share_token_hash};
use hcfs_client::client::share::{ShareError, ShareKeystore, ShareSecret};
use hcfs_client::client::{HcfsClient, HcfsClientConfig};
use hcfs_client::crypto;
use tokio_util::sync::CancellationToken;

const CAPABILITY: &str = "upload_folder_shares";

#[derive(Clone, Default)]
struct InMemKeystore(Arc<Mutex<HashMap<String, ShareSecret>>>);

impl ShareKeystore for InMemKeystore {
    fn put(&self, token: &str, secret: &ShareSecret) -> Result<(), ShareError> {
        self.0.lock().expect("keystore").insert(token.to_string(), secret.clone());
        Ok(())
    }
    fn get(&self, token: &str) -> Result<Option<ShareSecret>, ShareError> {
        Ok(self.0.lock().expect("keystore").get(token).cloned())
    }
    fn forget(&self, token: &str) -> Result<(), ShareError> {
        self.0.lock().expect("keystore").remove(token);
        Ok(())
    }
}

/// `true` to run: the server advertises the capability, or the probe was
/// indeterminate (let the test fail loudly on its own requests).
async fn supported(test: &str) -> bool {
    let response = match reqwest::get(format!("{}/v1/capabilities", server_url())).await {
        Ok(response) => response,
        Err(e) => {
            eprintln!("{test}: capabilities probe transport error ({e:?}); running anyway");
            return true;
        }
    };
    if response.status().is_server_error() {
        return true;
    }
    let body = response.text().await.unwrap_or_default();
    let advertised = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|caps| caps[CAPABILITY].as_bool())
        .unwrap_or(false);
    if !advertised {
        eprintln!("skipping {test}: server does not advertise {CAPABILITY} yet");
    }
    advertised
}

fn user_client(user_bearer: &str) -> HcfsClient {
    HcfsClient::new(HcfsClientConfig {
        base_url: std::env::var("HCFS_E2E_SERVER_URL").unwrap_or_default(),
        bearer_token: user_bearer.to_string(),
        accept_invalid_certs: false,
        billing_bypass_token: Some(billing_bypass()),
        ss58_address: USER_BEARER_PROBE_SS58.to_string(),
        folder_hash: String::new(),
        shared_drive_member: false,
        read_timeout_ms: None,
    })
    .expect("user client")
}

#[tokio::test]
#[ignore = "e2e: hits the deployed service"]
async fn an_outside_folder_round_trips_as_an_uploaded_copy() {
    let test = "an_outside_folder_round_trips_as_an_uploaded_copy";
    if !supported(test).await {
        return;
    }
    let Some((user_bearer, _, _)) = user_scoped_env(test).await else {
        return;
    };

    let dir = tempfile::tempdir().expect("tempdir");
    let big: Vec<u8> = (0..9 * 1024 * 1024).map(|i: usize| (i % 251) as u8).collect();
    let files: [(&str, &[u8]); 3] = [
        ("notes.txt", b"hello uploaded copy"),
        ("photos/a.bin", &big),
        ("photos/empty.txt", b""),
    ];
    let mut entries = Vec::new();
    for (relative, contents) in files {
        let source = dir.path().join(relative);
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, contents).unwrap();
        entries.push(UploadFolderEntry::File {
            relative_path: relative.to_string(),
            source,
            size: contents.len() as u64,
        });
    }
    entries.push(UploadFolderEntry::Dir { relative_path: "Empty Dir".into() });

    let client = user_client(&user_bearer);
    let options = UploadFolderShareOptions {
        display_name: "e2e-upload",
        ttl: ShareTtl::Hours24,
        password: None,
        console_base_url: "https://console.hippius.com",
    };
    let created = client
        .create_upload_folder_share(entries, &options, &InMemKeystore::default(), None, CancellationToken::new())
        .await
        .expect("create_upload_folder_share");
    let key: [u8; 32] = URL_SAFE_NO_PAD
        .decode(created.share_url.split("#k=").nth(1).expect("#k="))
        .expect("key b64")
        .try_into()
        .expect("32-byte key");
    let base = format!("{}/v1/folder-shares/{}", server_url(), created.share_token);
    let anon = reqwest::Client::new();

    // --- Every anonymous GET first (see module docs) ---
    let meta = anon.get(format!("{base}/meta")).send().await.unwrap().text().await.unwrap();
    let root = anon.get(format!("{base}/browse")).send().await.unwrap().text().await.unwrap();
    let photos = anon.get(format!("{base}/browse?path=photos")).send().await.unwrap().text().await.unwrap();
    let hits = anon.get(format!("{base}/browse?q=notes")).send().await.unwrap().text().await.unwrap();
    let blob = anon.get(format!("{base}/blob?path=photos/a.bin")).send().await.unwrap();
    let blob_status = blob.status();
    let blob_bytes = blob.bytes().await.unwrap();

    // --- Revoke, then assert ---
    let token_hash = folder_share_token_hash(&created.share_token);
    client.revoke_folder_share_by_hash(&token_hash).await.expect("revoke");
    let after = anon.get(format!("{base}/meta")).send().await.unwrap().status();

    let meta: serde_json::Value = serde_json::from_str(&meta).expect("meta json");
    assert_eq!(meta["display_name"], "e2e-upload");
    let root: serde_json::Value = serde_json::from_str(&root).expect("root json");
    let dirs: Vec<&str> = root["directories"].as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap()).collect();
    assert_eq!(dirs, ["Empty Dir", "photos"]);
    assert_eq!(root["files"][0]["name"], "notes.txt");
    assert_eq!(root["recursive_file_count"], 3);
    let photos: serde_json::Value = serde_json::from_str(&photos).expect("photos json");
    assert_eq!(photos["files"].as_array().unwrap().len(), 2);
    let hits: serde_json::Value = serde_json::from_str(&hits).expect("hits json");
    assert_eq!(hits["files"][0]["path"], "notes.txt");
    assert!(blob_status.is_success(), "blob status {blob_status}");
    let mut plaintext = Vec::new();
    crypto::decrypt_stream(&mut Cursor::new(&blob_bytes), &mut plaintext, &key, None, None::<fn(u64, u64)>)
        .expect("drive framing under the link key");
    assert!(plaintext == big, "the 9 MiB file round-trips byte for byte");
    assert_eq!(after.as_u16(), 404, "revoked links are cut off at once");
}
```

**Step 2: Run it against e2e-local** (with the stack from `.github/workflows/ci.yml`
`e2e-local-run`, or a local `cargo run -p hcfs-server` plus postgres and minio):

```bash
HCFS_E2E_SERVER_URL=http://127.0.0.1:9999 \
  cargo test --release -p hcfs-e2e-tests --test upload_folder_shares -- --ignored --nocapture
```

Expected: PASS on a branch-local server, and `skipping … does not advertise` against
production until the deploy.

**Step 3: Commit**

```bash
git add hcfs-e2e-tests
git commit -m "Cover uploaded-copy folder links end to end" -m "Shares a real folder with hcfs-client against a real server and reads it
back anonymously: browse, search, an empty folder, a two-chunk file
decrypted with the URL key, and an immediate 404 after revoke. Skips
while the target server lacks the capability."
```

---

### Task 16: Docs

**Files:**
- Modify: `docs/public/api/folder-shares.md`. Add an "Uploaded copies" section to the
  endpoint index with the six routes, bodies, statuses (201/204/200/400/404/409/413), the
  `token_hash` addressing, the 60-minute idle reap, seal-anchored expiry, and `source` on
  the listing.
- Modify: `hcfs-server/src/folder_shares/mod.rs` module docs. Make the second paragraph
  read: "Two sources. `drive` rows are metadata-only views (below). `upload` rows own an
  encrypted copy in `folder_share_files` / `folder_share_chunks` (`upload_db`,
  `upload_routes`, `upload_listing`, `upload_reaper`)." Fix "rows only, since a folder share
  stores no blobs" to say so for drive rows only.
- Modify: root `CLAUDE.md` "Current State". Change "folder shares" to "folder shares (drive
  views and uploaded copies)".

**Step 1:** Edit the files. Docs are not code, so this task has no test.
**Step 2:** `cargo doc -p hcfs-server --no-deps 2>&1 | grep -i warning` (expect none) and
`cargo test -p hcfs-server route_catalog`.

**Step 3: Commit**

```bash
git add docs/public/api/folder-shares.md hcfs-server/src/folder_shares/mod.rs CLAUDE.md
git commit -m "Document uploaded-copy folder links" -m "The public API doc is what the console and desktop teams build against;
the module docs stop claiming folder shares never store blobs."
```

---

### Task 17: Full verification, then PR

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
export TEST_DATABASE_URL=postgres://localhost/hcfs_test
cargo test -p hcfs-shared
cargo test -p hcfs-client
cargo test -p hcfs-server -- --test-threads=1
cargo test --release -p hcfs-e2e-tests --no-run
```

Expected: all green and zero warnings. `server_integration` and `router_oneshot` must not run
concurrently, and Cargo runs test binaries sequentially, so a plain `cargo test` is safe.

Then run an adversarial review (global CLAUDE.md, "When opening a PR"). Push
`feat/upload-folder-shares` and open a PR into `main` with a plain, factual description:
what the code does now, the capability flag, the migration (additive and catalog-only), and
the rollout order. The rollout order is: server deploy, then console (Part 2), then the
desktop pin bump (Part 3), with the live e2e lane run on that bump.

---

### Open risks

1. **Share-summary heal scripts do not know uploaded copies.**
   `scripts/backfill_share_summaries.sql` and `shares::db::billed_share_totals` rebuild
   `{ss58}_hcfs_shares` from `file_shares` only. An operator who runs them would drop every
   sealed link's bytes from usage, and the reaper would later release those bytes again,
   driving the row below truth. Follow-up: add `SUM(size_bytes)/COUNT(*)` over sealed
   upload rows to both, with a test pinning that the two agree. This plan does not change
   them.
2. **The 50,000-file cap is a validation limit, not a load test.** `init_upload_file`
   serializes on the link row, and the aggregate SQL scans one link by `token_hash` with a
   `LIKE` residual. Those are fine at 50k rows, but nobody has measured them. Measure open
   to seal for 50k × 1 KiB files on e2e-local before the desktop enables it broadly.
3. **Per-file round trips.** Small files cost 3 requests each (init, chunk, complete). A
   folder of 50k tiny files is 150k requests at concurrency 4. Batching init/complete is a
   later optimization, and the wire leaves room for it (new routes, no breaking change).
4. **An abort can fail silently on the client.** If the network dies, the client cannot
   send the abort `DELETE`, and the link stays `uploading` until the 60-minute idle reap
   (holding quota and storage until then). That outcome is intended, but the user sees the
   space as used for up to an hour.
5. **Revoking an uploading link through the by-hash route** (not abort) leaves its quota
   hold until the next reaper sweep (≤ 5 min), not instantly. Only a hand-crafted call does
   this, because the listing never shows unsealed links.
6. **`FolderShareError` gained variants.** Any exhaustive `match` in hippius-desktop breaks
   at compile time on the pin bump, which is the intended signal. Part 3 maps `SourceChanged`
   and `Cancelled` by name.
7. **A cancelled seal.** The seal is deliberately not cancellable mid-flight. A cancel
   during the seal POST waits for its response, which is at most the client's request
   timeout. If the seal commits but its response is lost, the abort falls back to
   revoke-by-hash. The link is then live for the seconds between those two calls.
8. **Old clients see upload rows.** A shipped desktop or console parses the new rows (the
   scope fields are `""`), but they render them as "whole drive" links of an unnamed drive
   until Parts 2/3 ship. The impact is cosmetic. Revoke and expiry still work because they
   are keyed by `token_hash`.
9. **Content-blind duplicate billing.** The upload billing does no dedup. Fresh random keys
   make ciphertext collisions impossible, except for a client that deliberately replays its
   own chunks across links. Such a client pays twice and is released twice, so the result is
   consistent.

---

# Part 2 — hippius-console

## Part 2 — hippius-console: uploaded-copy folder links

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans (or
> superpowers:subagent-driven-development) to work through this plan task by task.
> Call `mcp__hippius-mem__recall` about the task before making changes, and
> `mcp__hippius-mem__remember` any durable decision/gotcha you discover.

**Goal:** a folder link with `source = 'upload'` (an outside folder shared from the desktop app)
works on the recipient page **with no recipient-code changes**, and gets its own label on the
owner's Shared Links page, where it never feeds the drive folder "shared" badge.

**Architecture:** the recipient route `src/app/share/folder/[token]/` never reads a drive's
identity. It reads only the `meta` / `browse` / `blob` wire shapes, which the contract keeps the
same for both sources, so the work there is a pinning test plus comment fixes. The owner side
parses a new optional `source` field on `GET /v1/folder-shares` rows into `FolderShareRow.source`.
The badge index skips rows whose source is not `drive`, and the shares page uses one pure helper
to name the row's scope ("Uploaded copy" / "Whole drive" / the path). Revoke, change expiry and
copy are keyed by `token_hash` / plaintext token / owner wrap and do not depend on source, so
they stay as they are.

**Tech stack:** Next.js 15, TypeScript strict, vitest (node, jsdom and contract projects),
Playwright against a production build with the mock HCFS fixture `e2e/fixtures/mock-hcfs.ts`.

**Read-only verification this plan is based on** (origin/dev @ `266bed7d`, 2026-10-01):

| Surface | Drive-only assumption? | Evidence |
|---|---|---|
| Recipient `meta` | No. Reads `display_name`, `expires_at` only | `page.tsx` `interface FolderShareMeta` (l.131) |
| Recipient `browse` | No. Reads `directories[].{name,file_count,total_bytes,created_at}`, `files[].{name,size_bytes,path,uploaded_at}`, `total_count`, `has_more`, `offset`, `limit`, `recursive_file_count`, `recursive_bytes` | `page.tsx` `fetchListing` (l.1445–1485), `folder-share-types.ts` |
| Stats ("Storage Used" / "File No") | No. They come from browse `recursive_*`, falling back to summing one level | `FolderShareUi.tsx` l.555–566 |
| Search / filters / sort | No. Query params only: `path q file_type size_min size_max date_from date_to sort_by sort_order offset limit` | `folder-share-search.ts` l.143–195 |
| Blob / preview / single download | No. `/blob?path=`, drive-file framing (`makeHcfsDecryptStream`) with the 32-byte fragment key | `page.tsx` `openDecryptedStream` (l.1592) |
| Thumbnails | No. The same blob route, with `Range: bytes=0-(4 MiB-1)` for video | `page.tsx` l.1196–1260 |
| Download folder | No. Search-mode browse (`size_min=0`, limit 10 000) then blob per file, store-only zip | `page.tsx` `collectSearchFiles` / `packFolderZip` |
| `#k=` / `#p=` | No. 32-byte key or 89-byte wrapped blob, `import_share_key` / `unwrap_share_key` | `page.tsx` l.400–450, 505–545 |
| Any `folder_hash` / `path_prefix` / `owner_ss58` read in the route dir | None (grep: zero hits outside comments) | — |
| Public proxy | Forwards only `v1/folder-shares/<token>/(meta\|browse\|blob)`; streams only binary content types | `src/app/api/hcfs/public/[...path]/route.ts` |
| Owner listing parse | **Yes.** `folder_hash: string`, `path_prefix: string` typed non-null; no `source` | `src/lib/hooks/useFolderShares.ts` `FolderShareListItem`, `toFolderRow` |
| Badge index | **Yes.** It indexes every non-revoked row by `${folderHash}\n${pathPrefix}` | `src/lib/hooks/useFolderSharesIndex.ts` `buildFolderShareIndex` |
| Shares page subtitle | **Yes.** `pathPrefix === "" ? "Whole drive" : pathPrefix`. An uploaded copy (prefix NULL → "") would read "Whole drive" | `src/components/files/SharesPageClient.tsx` l.1386–1393 |
| File-share badge index (`useSharedFilesIndex`) | Not involved. It reads `GET /v1/shares` only; folder links never reach it | `useSharedFilesIndex.ts` l.137 |
| `folderShareTarget` | Not involved. It maps UI rows to targets, and an uploaded copy has no UI row. No change | `src/lib/files/share/folder-share-target.ts` |
| Owner-wrap hydration / Copy | Keyed by `token_hash` + session SS58, no source dependency | `SharesPageClient.tsx` l.402–485, 561–605 |

---

### Contract deviations

1. **Base branch is `dev`, not `staging`.** hippius-console has no `staging` branch. Feature
   PRs target `dev` (`.github/workflows/test.yml` runs on `dev` and `main`; feature branches are
   named `*-dev`). Promotion `dev` → `main` follows the repo's normal process and is out of
   scope.
2. **Owner listing: `folder_hash` / `path_prefix` may be `null` or absent on `source='upload'`
   rows.** The contract makes the DB columns NULLable but does not say how the list serializes
   them. The console accepts `string | null | undefined` and normalizes to `""` in
   `FolderShareRow`. **Ask part 1 (hcfs) to serialize them as JSON `null`** (an
   `Option<String>`), not `""`, so that "no drive" stays distinguishable on the wire.
3. **`source` parsing is lenient.** If absent or `null` the row is `drive` (servers before
   uploaded copies; mirrors the client's `#[serde(default)]`). Exactly `"upload"` is `upload`.
   **Any other string is treated as `drive`** (the console has no closed-enum failure mode like
   serde's). This is safe for the badge because an identity-less row can never match a
   `folderShareTarget` (empty `folderHash` is rejected at lookup).
4. **No capability gate in the console.** The console never mints uploaded copies, so it does not
   read `upload_folder_shares`. Rows carry `source` themselves, and a server without it lists
   none.
5. **Recipient wire requirements the contract leaves implicit.** The console needs these from
   hcfs for `source='upload'`; part 1 must pin them:
   - `GET …/blob` responds `Content-Type: application/octet-stream`. The public proxy streams
     only `application/octet-stream|binary|*cbor`. Any other type is **buffered and re-sent as
     text**, which corrupts ciphertext (`route.ts` `isBinaryContentType`).
   - `GET …/blob` honours `Range: bytes=0-N` with 206 (video thumbnails), or ignores it with a
     full 200. Both work, but 200 downloads whole videos for a thumbnail.
   - `GET …/browse` returns per-file `path`, `uploaded_at`, dir `created_at`, dir
     `file_count`/`total_bytes`, and `recursive_file_count`/`recursive_bytes` in directory mode
     (null in search mode), and lists `kind='dir'` entries so empty sub-folders appear.
   - Search mode honours `limit` up to 10 000 (`FOLDER_SHARE_SEARCH_MAX_LIMIT`) and `size_min=0`,
     because Download folder pages with them.
   - `date_from`/`date_to` filter and `sort_by=uploaded_at` order on `folder_share_files.uploaded_at`.
6. **Label text.** The design says "Uploaded copy". The console also sets a `title` tooltip:
   "A copy uploaded when the link was created. Later changes to the folder are not included."
7. **No CHANGELOG entry.** hippius-console has no CHANGELOG file. The user-visible line belongs
   in the PR description.

---

### File map

| File | Change |
|---|---|
| `src/lib/files/share/folder-share-source.ts` | **New.** `FolderShareSource`, `parseFolderShareSource`, `folderShareScopeLabel`, `folderShareScopeTitle`, label constants |
| `src/lib/files/share/folder-share-source.test.ts` | **New.** Unit tests |
| `src/lib/hooks/useFolderShares.ts` | Wire type: nullable `folder_hash`/`path_prefix`, optional `source`. `FolderShareRow.source`. `toFolderRow` normalizes |
| `src/lib/hooks/useFolderShares.test.ts` | Exact-shape test gains `source`, plus two new parse tests |
| `src/lib/hooks/useFolderSharesIndex.ts` | `buildFolderShareIndex` skips non-`drive` rows; doc |
| `src/lib/hooks/useFolderSharesIndex.test.ts` | Factory gains `source: "drive"`, plus two exclusion tests |
| `src/components/files/SharesPageClient.tsx` | Subtitle via `folderShareScopeLabel` / `folderShareScopeTitle`; size-cell + `rowSize` comments |
| `src/components/files/shares-page-client.test.ts` | Replace the `"Whole drive"` literal pin with a helper-usage pin |
| `src/app/api/hcfs/public/[...path]/public-proxy.test.ts` | Pin: upload owner routes never forwarded anonymously |
| `src/app/share/folder/[token]/page.tsx` | Comment-only: the fragment key is the link's key, which may be a drive's derived key or an uploaded copy's random key |
| `src/app/share/folder/[token]/recipient.test.ts` | Pin: route never reads drive identity |
| `e2e/fixtures/mock-hcfs.ts` | `recursiveTotals` on recipient shares; `listedFolderShares` + by-hash PATCH/DELETE; `source` on owner rows; capability type |
| `e2e/fixtures/mock-hcfs.contract.test.ts` | Pin `source` through the real parser |
| `e2e/folder-share.spec.ts` | New describe: an uploaded-copy link, end to end |
| `e2e/shares-page.spec.ts` | New describe: uploaded-copy row label + by-hash expiry/revoke + copy suppressed |

Code style (binding): kebab-case util files, `useXxx.ts` hooks, absolute `@/` imports in `src/`
(relative `../src/...` only inside `e2e/`, as the existing specs do), ≤100-line functions,
comments say *why*, no emojis.

---

#### Task 0: Worktree and baseline

**Files:** none.

- [ ] **Step 1: Create an isolated worktree from `origin/dev`**

```bash
cd /Users/georgiosdelkos/Documents/GitHub/Bitensor/hippius-console
git fetch origin
git worktree add .worktrees/upload-folder-share-rows -b feat/upload-folder-share-rows-dev origin/dev
cd .worktrees/upload-folder-share-rows
pnpm install --frozen-lockfile
npx papi generate
```

Expected: worktree created on `feat/upload-folder-share-rows-dev`, install completes, `papi
generate` writes `.papi/descriptors` (tsc needs it, as CI does).

- [ ] **Step 2: Baseline the suites this plan touches**

```bash
npx vitest run src/lib/hooks/useFolderShares.test.ts src/lib/hooks/useFolderSharesIndex.test.ts \
  src/components/files/shares-page-client.test.ts "src/app/share/folder/[token]/recipient.test.ts" \
  "src/app/api/hcfs/public/[...path]/public-proxy.test.ts" e2e/fixtures/mock-hcfs.contract.test.ts
```

Expected: all files pass. If anything fails here, stop and report it, because it is
pre-existing.

---

#### Task 1: Source parsing and scope label helper

**Files:**
- Create: `src/lib/files/share/folder-share-source.ts`
- Test: `src/lib/files/share/folder-share-source.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/files/share/folder-share-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  folderShareScopeLabel,
  folderShareScopeTitle,
  parseFolderShareSource,
  UPLOADED_COPY_LABEL,
  UPLOADED_COPY_TOOLTIP,
  WHOLE_DRIVE_LABEL,
} from "@/lib/files/share/folder-share-source";

describe("parseFolderShareSource", () => {
  it("reads a missing source as drive, as servers before uploaded copies send", () => {
    expect(parseFolderShareSource(undefined)).toBe("drive");
    expect(parseFolderShareSource(null)).toBe("drive");
  });

  it("reads the two known values", () => {
    expect(parseFolderShareSource("drive")).toBe("drive");
    expect(parseFolderShareSource("upload")).toBe("upload");
  });

  it("does not promote a near-miss or unknown value to upload", () => {
    // Only the exact wire string marks an uploaded copy; anything else keeps
    // the drive reading the row had before `source` existed.
    expect(parseFolderShareSource("UPLOAD")).toBe("drive");
    expect(parseFolderShareSource("archive")).toBe("drive");
    expect(parseFolderShareSource(1)).toBe("drive");
  });
});

describe("folderShareScopeLabel", () => {
  it("names an uploaded copy instead of a path that does not exist", () => {
    expect(folderShareScopeLabel({ source: "upload", pathPrefix: "" })).toBe(
      UPLOADED_COPY_LABEL,
    );
  });

  it("names an uploaded copy even if a prefix ever arrives with it", () => {
    expect(
      folderShareScopeLabel({ source: "upload", pathPrefix: "Downloads/T2-KD" }),
    ).toBe(UPLOADED_COPY_LABEL);
  });

  it("keeps the drive wording: whole drive at the root, the path below it", () => {
    expect(folderShareScopeLabel({ source: "drive", pathPrefix: "" })).toBe(
      WHOLE_DRIVE_LABEL,
    );
    expect(
      folderShareScopeLabel({ source: "drive", pathPrefix: "Photos/2026" }),
    ).toBe("Photos/2026");
  });

  it("pins the user-facing strings", () => {
    expect(UPLOADED_COPY_LABEL).toBe("Uploaded copy");
    expect(WHOLE_DRIVE_LABEL).toBe("Whole drive");
  });
});

describe("folderShareScopeTitle", () => {
  it("explains that an uploaded copy does not follow the folder", () => {
    expect(folderShareScopeTitle({ source: "upload", pathPrefix: "" })).toBe(
      UPLOADED_COPY_TOOLTIP,
    );
  });

  it("repeats the label for a drive row, where it is already the full answer", () => {
    expect(
      folderShareScopeTitle({ source: "drive", pathPrefix: "Photos/2026" }),
    ).toBe("Photos/2026");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run src/lib/files/share/folder-share-source.test.ts
```

Expected: FAIL. `Failed to resolve import "@/lib/files/share/folder-share-source"`.

- [ ] **Step 3: Implement**

`src/lib/files/share/folder-share-source.ts`:

```ts
/**
 * Where a folder link's contents come from, and how the owner's list names it.
 *
 * A `drive` link is a live view of a drive subtree. The server identifies it
 * by `{folder_hash, path_prefix}`, and it badges that folder in the file
 * browser. An `upload` link is a copy the desktop app uploaded under the
 * link's own key when the link was made, from a folder outside every drive.
 * It has no drive identity, so it must never badge a drive folder, and the
 * owner list names it instead of showing a path that does not exist.
 *
 * Revoke, expiry and copy do not care which kind a row is: they are keyed by
 * the token, its hash, or the owner wrap.
 */

export type FolderShareSource = "drive" | "upload";

/** Subtitle of an uploaded-copy row on the Shared Links page. */
export const UPLOADED_COPY_LABEL = "Uploaded copy";

/** Hover text for that subtitle: the link is a snapshot, not a live view. */
export const UPLOADED_COPY_TOOLTIP =
  "A copy uploaded when the link was created. Later changes to the folder are not included.";

/** Subtitle of a drive row whose share covers the drive root. */
export const WHOLE_DRIVE_LABEL = "Whole drive";

/**
 * Read the owner listing's `source`.
 *
 * Absent or `null` means `drive`: every server that predates uploaded copies
 * lists only drive-backed links, and that is also the client crate's serde
 * default. Only the exact string `upload` marks an uploaded copy. Any other
 * value keeps the drive reading rather than inventing a third state. That is
 * safe for the badge because a row without a drive identity cannot match a
 * folder target anyway.
 */
export function parseFolderShareSource(raw: unknown): FolderShareSource {
  return raw === "upload" ? "upload" : "drive";
}

interface ScopedRow {
  source: FolderShareSource;
  /** `""` = drive root on a drive row; always `""` on an uploaded copy. */
  pathPrefix: string;
}

/** The second line under a folder row's name on the Shared Links page. */
export function folderShareScopeLabel(row: ScopedRow): string {
  if (row.source === "upload") return UPLOADED_COPY_LABEL;
  return row.pathPrefix === "" ? WHOLE_DRIVE_LABEL : row.pathPrefix;
}

/** Hover text for that line: the explanation for a copy, else the full path. */
export function folderShareScopeTitle(row: ScopedRow): string {
  if (row.source === "upload") return UPLOADED_COPY_TOOLTIP;
  return folderShareScopeLabel(row);
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npx vitest run src/lib/files/share/folder-share-source.test.ts
npx eslint src/lib/files/share/folder-share-source.ts src/lib/files/share/folder-share-source.test.ts
```

Expected: `Test Files  1 passed (1)`, `Tests  9 passed (9)`. ESLint prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/files/share/folder-share-source.ts src/lib/files/share/folder-share-source.test.ts
git commit -m "Add folder link source parsing and scope label helper" -m "Folder links can now be uploaded copies of a folder outside any drive
(hcfs source='upload'). Those rows have no drive identity, so the shares
page needs a name for them and the badge needs a way to tell them apart.
One pure helper keeps the parse rule (absent means drive) and the wording
in a single tested place."
```

---

#### Task 2: Carry `source` through the owner listing

**Files:**
- Modify: `src/lib/hooks/useFolderShares.ts` (`FolderShareRow`, `FolderShareListItem`, `toFolderRow`, imports)
- Test: `src/lib/hooks/useFolderShares.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/hooks/useFolderShares.test.ts`, in `describe("toFolderRow + keystore resolution", …)`:

1. In the existing test `"maps the wire shape and tags rows {kind:'folder'}"`, add
   `source: "drive",` to the expected object right after `kind: "folder",`.
2. Append two tests inside the same `describe`:

```ts
  it("reads a row without `source` as drive, as a server before uploaded copies sends it", () => {
    const row = toFolderRow(item(), new Map());

    expect(row.source).toBe("drive");
    expect(row.folderHash).toBe("abcdef0123456789");
    expect(row.pathPrefix).toBe("Photos/2026");
  });

  it("maps an uploaded copy, which belongs to no drive, without inventing an identity", () => {
    // hcfs stores NULL folder_hash / path_prefix for `source = 'upload'`.
    // The row keeps "" so string-typed consumers stay total; `source` is
    // what tells the badge and the label that there is no drive behind it.
    const row = toFolderRow(
      item({
        source: "upload",
        folder_hash: null,
        path_prefix: null,
        display_name: "T2-KD",
      }),
      new Map(),
    );

    expect(row.source).toBe("upload");
    expect(row.folderHash).toBe("");
    expect(row.pathPrefix).toBe("");
    expect(row.displayName).toBe("T2-KD");
  });
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/lib/hooks/useFolderShares.test.ts
```

Expected: FAIL. The exact-shape test reports a missing `source`. The upload test fails on
`row.source` (`undefined`) and `row.folderHash` (`null`). `tsc` would also reject
`folder_hash: null` against `string`.

- [ ] **Step 3: Implement**

In `src/lib/hooks/useFolderShares.ts`:

Add the import beside the others:

```ts
import {
  parseFolderShareSource,
  type FolderShareSource,
} from "@/lib/files/share/folder-share-source";
```

In `interface FolderShareRow`, after `kind: "folder";`'s neighbour `tokenHash`, add:

```ts
  /**
   * `upload` = a copy the desktop uploaded under the link's own key, from a
   * folder outside every drive. Such a row has no drive identity: its
   * `folderHash` and `pathPrefix` are `""` and must never be matched against
   * a drive folder (see `buildFolderShareIndex`).
   */
  source: FolderShareSource;
```

and change the `folderHash` doc to:

```ts
  /** Owning drive's folder hash; `""` on an uploaded copy (no drive). */
  folderHash: string;
```

Replace `interface FolderShareListItem` with:

```ts
/** Mirrors `FolderShareListItem` in `hcfs-server/src/folder_shares/types.rs`. */
export interface FolderShareListItem {
  token_hash: string;
  /** `null` (or absent) on an uploaded copy, which belongs to no drive. */
  folder_hash: string | null;
  /** `null` (or absent) on an uploaded copy. */
  path_prefix: string | null;
  display_name: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  owner_wrap?: string | null;
  /** `drive` | `upload`; absent on servers that predate uploaded copies. */
  source?: string | null;
}
```

Replace the body of `toFolderRow` with:

```ts
export function toFolderRow(
  item: FolderShareListItem,
  tokenByHash: Map<string, string>,
): FolderShareRow {
  return {
    kind: "folder",
    tokenHash: item.token_hash,
    source: parseFolderShareSource(item.source),
    // Normalised rather than widened to `string | null`: every consumer
    // treats "" as "no target", and the badge index keys off `source`
    // before it ever looks at these.
    folderHash: item.folder_hash ?? "",
    pathPrefix: item.path_prefix ?? "",
    displayName: item.display_name,
    createdAt: item.created_at,
    expiresAt: item.expires_at,
    revokedAt: item.revoked_at,
    shareToken: tokenByHash.get(item.token_hash) ?? null,
    ownerWrap: item.owner_wrap ?? null,
  };
}
```

Fix the one other `FolderShareRow` literal so tsc stays green. In
`src/lib/hooks/useFolderSharesIndex.test.ts`, in the `row()` factory, add `source: "drive",`
after `kind: "folder",`.

- [ ] **Step 4: Run and confirm pass**

```bash
npx vitest run src/lib/hooks/useFolderShares.test.ts src/lib/hooks/useFolderShares.hook.test.tsx \
  src/lib/hooks/useFolderSharesIndex.test.ts
npx tsc --noEmit
npx eslint src/lib/hooks/useFolderShares.ts src/lib/hooks/useFolderShares.test.ts \
  src/lib/hooks/useFolderSharesIndex.test.ts
```

Expected: all three files pass. `tsc` reports no errors. If it flags another `FolderShareRow`
literal, add `source: "drive"` there. ESLint prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hooks/useFolderShares.ts src/lib/hooks/useFolderShares.test.ts \
  src/lib/hooks/useFolderSharesIndex.test.ts
git commit -m "Read folder link source from the owner listing" -m "hcfs now lists uploaded copies alongside drive-backed folder links, with
NULL folder_hash and path_prefix. The parser typed both as strings and had
no source, so an uploaded copy would have looked like a whole-drive share.
Rows now carry source (absent means drive) and normalise the missing drive
identity to empty strings."
```

---

#### Task 3: Keep uploaded copies out of the drive badge index

**Files:**
- Modify: `src/lib/hooks/useFolderSharesIndex.ts` (`buildFolderShareIndex`, header doc)
- Test: `src/lib/hooks/useFolderSharesIndex.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `describe("selectFolderSharesFor", …)` in `src/lib/hooks/useFolderSharesIndex.test.ts`:

```ts
  it("never indexes an uploaded copy, even one that arrives with a drive's identity", () => {
    // Defensive: hcfs sends NULL identity for uploaded copies, but if a row
    // ever carried one, badging that drive folder would claim a live view of
    // it was shared when only a detached copy of some other folder was.
    const index = buildFolderShareIndex([
      row({ tokenHash: "h-upload", source: "upload", pathPrefix: "docs" }),
    ]);

    expect(index.size).toBe(0);
    expect(selectFolderSharesFor(index, DRIVE, "docs")).toEqual([]);
  });

  it("indexes the drive rows beside an uploaded copy unchanged", () => {
    const index = buildFolderShareIndex([
      row({ tokenHash: "h-upload", source: "upload", folderHash: "", pathPrefix: "" }),
      row({ tokenHash: "h-drive", pathPrefix: "" }),
    ]);

    expect(
      selectFolderSharesFor(index, DRIVE, "").map((r) => r.tokenHash),
    ).toEqual(["h-drive"]);
    // A row with no drive identity matches no folder target, the root of an
    // unnamed drive included.
    expect(selectFolderSharesFor(index, "", "")).toEqual([]);
  });
```

And append to `describe("folderShareTarget → index round-trip", …)`:

```ts
  it("an uploaded copy never round-trips into any folder row's badge", () => {
    const index = buildFolderShareIndex([
      row({ tokenHash: "h-upload", source: "upload", folderHash: "", pathPrefix: "" }),
    ]);
    const targets = [
      folderShareTarget({ id: DRIVE, parentFolderHash: undefined }),
      folderShareTarget({
        id: "synthetic-row-id",
        parentFolderHash: DRIVE,
        browseSubpath: "Photos/2026",
      }),
    ];

    for (const target of targets) {
      expect(
        selectFolderSharesFor(index, target.folderHash, target.pathPrefix),
      ).toEqual([]);
    }
  });
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run src/lib/hooks/useFolderSharesIndex.test.ts
```

Expected: FAIL. In "never indexes an uploaded copy…" `index.size` is 1 and the lookup returns
the row. In "indexes the drive rows beside…" the index has 2 keys (that test still passes its
asserts, which is fine). The round-trip test passes already. It pins the outcome; the first test
is the one that proves the change.

- [ ] **Step 3: Implement**

In `src/lib/hooks/useFolderSharesIndex.ts`, replace `buildFolderShareIndex` with:

```ts
export function buildFolderShareIndex(
  rows: FolderShareRow[],
): FolderShareIndex {
  const index: FolderShareIndex = new Map();
  for (const row of rows) {
    if (row.revokedAt !== null) continue;
    // An uploaded copy is a snapshot of a folder outside every drive. It has
    // no drive folder to badge, so it is skipped by kind rather than relying
    // on its empty identity never matching.
    if (row.source !== "drive") continue;
    const key = indexKey(row.folderHash, row.pathPrefix);
    const list = index.get(key);
    if (list) list.push(row);
    else index.set(key, [row]);
  }
  return index;
}
```

In the file header doc, replace the paragraph starting "The owner listing deliberately includes
revoked and expired rows" with:

```ts
 * The owner listing deliberately includes revoked and expired rows (they
 * linger until the server-side reaper sweeps them); a dead link must not
 * badge a folder as shared, so revoked rows are dropped at index build and
 * expired ones at lookup time (expiry is clock-dependent, the index is
 * cached). Uploaded copies (`source: "upload"`) are dropped at build too:
 * they are not a view of any drive folder.
```

- [ ] **Step 4: Run and confirm pass**

```bash
npx vitest run src/lib/hooks/useFolderSharesIndex.test.ts
npx eslint src/lib/hooks/useFolderSharesIndex.ts src/lib/hooks/useFolderSharesIndex.test.ts
```

Expected: `Test Files  1 passed (1)`. ESLint prints nothing.

Mutation check (required by the testing policy): temporarily delete the
`if (row.source !== "drive") continue;` line and rerun. "never indexes an uploaded copy…" must
fail. Restore the line.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hooks/useFolderSharesIndex.ts src/lib/hooks/useFolderSharesIndex.test.ts
git commit -m "Keep uploaded folder copies out of the shared badge" -m "The folder badge means a live link shows that drive folder. An uploaded
copy is a snapshot of a folder outside every drive, so it must never
badge one. Skip it by source at index build instead of trusting that its
empty identity can never match."
```

---

#### Task 4: "Uploaded copy" on the Shared Links page

**Files:**
- Modify: `src/components/files/SharesPageClient.tsx` (imports; `FolderShareRowItem` subtitle l.1386–1393; size cell comment l.1403–1404; `rowSize` doc l.198–200)
- Test: `src/components/files/shares-page-client.test.ts`

- [ ] **Step 1: Update the grep test so it fails first**

In `src/components/files/shares-page-client.test.ts`, replace:

```ts
  it("renders a root path_prefix as 'Whole drive'", () => {
    expect(SOURCE).toContain('"Whole drive"');
  });
```

with:

```ts
  it("names a folder row's scope through the shared helper, never inline", () => {
    // The wording ("Whole drive", the path, or "Uploaded copy" for a folder
    // uploaded from outside every drive) lives in folder-share-source.ts with
    // its own tests. An inline ternary here is how an uploaded copy, whose
    // prefix is "", would quietly read "Whole drive".
    expect(SOURCE).toContain("{folderShareScopeLabel(row)}");
    expect(SOURCE).toContain("title={folderShareScopeTitle(row)}");
    expect(SOURCE).not.toContain('"Whole drive"');
  });
```

```bash
npx vitest run src/components/files/shares-page-client.test.ts
```

Expected: FAIL on `toContain("{folderShareScopeLabel(row)}")`.

- [ ] **Step 2: Implement**

In `src/components/files/SharesPageClient.tsx`, add to the imports (next to the other
`@/lib/files/share/*` imports):

```ts
import {
  folderShareScopeLabel,
  folderShareScopeTitle,
} from "@/lib/files/share/folder-share-source";
```

Replace the subtitle span in `FolderShareRowItem`:

```tsx
        <span
          className="block truncate text-xs text-grey-50 dark:text-grey-dark-700"
          title={row.pathPrefix === "" ? "Whole drive" : row.pathPrefix}
        >
          {row.pathPrefix === "" ? "Whole drive" : row.pathPrefix}
        </span>
```

with:

```tsx
        <span
          className="block truncate text-xs text-grey-50 dark:text-grey-dark-700"
          title={folderShareScopeTitle(row)}
        >
          {folderShareScopeLabel(row)}
        </span>
```

Replace the size-cell comment:

```tsx
        {/* A live folder share has no fixed size — it exposes the folder's
            CURRENT contents — so the cell doubles as the kind marker. */}
```

with:

```tsx
        {/* A live folder share has no fixed size (it shows the folder's
            CURRENT contents), and the listing does not carry an uploaded
            copy's total, so the cell doubles as the kind marker for both. */}
```

Replace the `rowSize` doc comment:

```ts
/** Bytes for a file share; `null` for a folder share, which has no fixed
 *  size — it exposes whatever the folder holds right now. Those rows sort to
 *  the bottom in both directions rather than piling up at one end. */
```

with:

```ts
/** Bytes for a file share; `null` for a folder share. A live one has no
 *  fixed size, and the listing carries no total for an uploaded copy. Those
 *  rows sort to the bottom in both directions rather than piling up at one
 *  end. */
```

Nothing else changes. Copy, Change expiry and Revoke for an uploaded copy go through the same
`resolveActionRoute`, `canManage` and owner-wrap paths. The contract keeps
`PATCH`/`DELETE /v1/folder-shares/{token}` and `/by-hash/{token_hash}` unchanged on
`folder_shares` rows of either source.

- [ ] **Step 3: Run and confirm pass**

```bash
npx vitest run src/components/files/shares-page-client.test.ts src/lib/files/share/folder-share-source.test.ts
npx tsc --noEmit
npx eslint src/components/files/SharesPageClient.tsx src/components/files/shares-page-client.test.ts
```

Expected: both test files pass, tsc clean, ESLint prints nothing new. If ESLint reports
pre-existing warnings in `SharesPageClient.tsx`, compare against `git stash` → lint →
`git stash pop`, as CLAUDE.md says.

- [ ] **Step 4: Commit**

```bash
git add src/components/files/SharesPageClient.tsx src/components/files/shares-page-client.test.ts
git commit -m "Label uploaded folder copies on the Shared Links page" -m "An uploaded copy has no path inside a drive, so the row's second line
read \"Whole drive\", which is wrong and alarming. It now reads \"Uploaded
copy\", with a tooltip saying later changes to the folder are not included.
The wording comes from the tested helper instead of an inline ternary."
```

---

#### Task 5: Pin the public proxy against the upload owner routes

**Files:**
- Test: `src/app/api/hcfs/public/[...path]/public-proxy.test.ts`

No production change: the allowlist regex already rejects these. This pins it, because the new
owner routes sit under the same `v1/folder-shares/` prefix the anonymous proxy forwards.

- [ ] **Step 1: Add the cases**

In the `it.each([...])("blocks %s without touching upstream", …)` table, append:

```ts
    // The upload owner routes (open, per-file init/chunk/complete, seal,
    // abort) live under the same prefix as the recipient routes. They are
    // authenticated and must only ever ride `/api/hcfs`, never this proxy.
    ["upload open", "v1/folder-shares/uploads"],
    ["upload file init", `v1/folder-shares/uploads/${"a".repeat(64)}/files`],
    [
      "upload chunk",
      `v1/folder-shares/uploads/${"a".repeat(64)}/files/1/chunks/0`,
    ],
    [
      "upload file complete",
      `v1/folder-shares/uploads/${"a".repeat(64)}/files/1/complete`,
    ],
    ["upload seal", `v1/folder-shares/uploads/${"a".repeat(64)}/complete`],
```

- [ ] **Step 2: Run, then mutate to prove the cases bite**

```bash
npx vitest run "src/app/api/hcfs/public/[...path]/public-proxy.test.ts"
```

Expected: pass. Then temporarily add `/^v1\/folder-shares\/uploads(\/.*)?$/,` to
`ALLOWED_PATTERNS` in `route.ts` and rerun. The five new cases must fail. Revert `route.ts`
(`git checkout -- "src/app/api/hcfs/public/[...path]/route.ts"`).

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/hcfs/public/[...path]/public-proxy.test.ts"
git commit -m "Pin that the public proxy never forwards upload owner routes" -m "hcfs adds authenticated routes under v1/folder-shares/uploads for the
desktop's uploaded folder copies, beside the anonymous recipient routes
this proxy forwards with the console API key. Pin that the allowlist
keeps refusing them, so a later widening cannot expose them."
```

---

#### Task 6: Recipient route stays source-agnostic

**Files:**
- Modify (comments only): `src/app/share/folder/[token]/page.tsx`
- Test: `src/app/share/folder/[token]/recipient.test.ts`

The verification table above found **no code change needed**. This task fixes the comments that
call the fragment key "the drive's derived file key", and pins the property the feature relies on.

**Gotcha:** this directory is scanned by a lowercase substring check for analytics names
(`FORBIDDEN_MODULES` includes the word `segment`). Do not use that word, or `gtag`, `datadog`,
and so on, in any new comment.

- [ ] **Step 1: Add the pinning test**

Append inside `describe("/share/folder/[token] threat-model invariants", …)` in
`recipient.test.ts`:

```ts
  it("never reads a drive's identity, so an uploaded-copy link renders the same", () => {
    // A folder uploaded from outside every drive (hcfs `source = 'upload'`)
    // is served by the same meta/browse/blob routes in the same shapes, but
    // has no folder hash, path prefix or drive owner to give. The page must
    // work from the token and the fragment key alone.
    for (const path of ROUTE_SOURCE_PATHS) {
      expect(fileText(path), path).not.toMatch(
        /folder_hash|path_prefix|folderHash|pathPrefix|owner_ss58|ownerSs58/,
      );
    }
  });
```

```bash
npx vitest run "src/app/share/folder/[token]/recipient.test.ts"
```

Expected: pass (the property already holds). Mutation check: temporarily add
`const _x = "folder_hash";` to `folder-share-types.ts`, rerun and see the test fail, then revert.

- [ ] **Step 2: Fix the comments in `page.tsx`**

Replace lines 4–5:

```ts
 * Anonymous folder-share recipient page: a live, browsable view of a shared
 * drive subtree. Anyone who has the URL — including the fragment — can list
```

with:

```ts
 * Anonymous folder-share recipient page: a browsable view of a shared folder,
 * either a live drive subtree or a copy the desktop uploaded from outside
 * every drive. The page cannot tell which and does not need to: both are
 * served in the same shapes. Anyone who has the URL — including the fragment — can list
```

Replace lines 14–17:

```ts
 *   - The fragment carries the drive's DERIVED FILE KEY — it decrypts any
 *     blob this share serves, so the link grants read of the whole shared
 *     subtree, not one file. Server-side path-prefix scoping is the only
 *     reach limit. Treat the fragment with the same care as a file-share
```

with:

```ts
 *   - The fragment carries the link's FILE KEY — the drive's derived file
 *     key for a drive link, a fresh random key for an uploaded copy. It
 *     decrypts any blob this share serves, so the link grants read of the
 *     whole shared folder, not one file. Server-side scoping to the shared
 *     folder is the only reach limit. Treat the fragment with the same care as a file-share
```

Replace lines 444–445:

```ts
      // The derived file key is a raw 32-byte key, same shape as a file-share
      // key — `import_share_key` copies it into zeroize-on-drop WASM memory.
```

with:

```ts
      // The link's file key (derived for a drive link, random for an uploaded
      // copy) is a raw 32-byte key, same shape as a file-share key —
      // `import_share_key` copies it into zeroize-on-drop WASM memory.
```

Replace line 1196 `   * derived file key, so unlike the signed-in Drive this never opens the` with
`   * link's file key, so unlike the signed-in Drive this never opens the`.

Replace lines 1589–1590:

```ts
 * drive-file scheme (`makeHcfsDecryptStream`), NOT the file-share blob
 * layout: the fragment key is the drive's derived file key.
```

with:

```ts
 * drive-file scheme (`makeHcfsDecryptStream`), NOT the file-share blob
 * layout, for both kinds of folder link: an uploaded copy is encrypted in
 * the same framing under its own random key.
```

- [ ] **Step 3: Run the route's tests**

```bash
npx vitest run "src/app/share/folder/[token]"
npx eslint "src/app/share/folder/[token]/page.tsx" "src/app/share/folder/[token]/recipient.test.ts"
```

Expected: every file in the route dir passes, including the `FORBIDDEN_MODULES` scan. ESLint
prints nothing.

- [ ] **Step 4: Commit**

```bash
git add "src/app/share/folder/[token]/page.tsx" "src/app/share/folder/[token]/recipient.test.ts"
git commit -m "Pin that the folder link page never reads a drive identity" -m "Uploaded folder copies reuse the recipient page unchanged. That holds only
while the page works from the token and fragment key alone, so pin that no
route file reads folder_hash, path_prefix or the owner. Comments that
called the key the drive's derived key now cover both kinds of link."
```

---

#### Task 7: Teach the e2e fixture about uploaded copies

**Files:**
- Modify: `e2e/fixtures/mock-hcfs.ts`
- Test: `e2e/fixtures/mock-hcfs.contract.test.ts`

- [ ] **Step 1: Write the failing contract tests**

In `e2e/fixtures/mock-hcfs.contract.test.ts` add the import:

```ts
import {
  requestFolderShareList,
  toFolderRow,
} from "../../src/lib/hooks/useFolderShares";
```

and append:

```ts
/** A fetch that answers with the bytes the mock produced. */
function fetchOf(body: unknown): typeof fetch {
  return (async () =>
    ({ status: 200, ok: true, json: async () => body })) as unknown as typeof fetch;
}

describe("the folder-share owner listing the mock serves", () => {
  it("carries an uploaded copy's source the parser can read", async () => {
    // What the Shared Links page labels "Uploaded copy" and the badge index
    // skips. A mock without `source` would make every e2e row a drive row.
    const body = await mockResponse(
      {
        ...BASE,
        listedFolderShares: [
          {
            token: "e2e-uploaded-copy",
            displayName: "T2-KD",
            source: "upload",
            folderHash: null,
            pathPrefix: null,
          },
        ],
      },
      "/v1/folder-shares",
    );

    const items = await requestFolderShareList("token", fetchOf(body));
    const row = toFolderRow(items[0]!, new Map());

    expect(row.source).toBe("upload");
    expect(row.folderHash).toBe("");
    expect(row.pathPrefix).toBe("");
    expect(row.displayName).toBe("T2-KD");
  });

  it("omits source when the fixture names none, as a server before uploaded copies does", async () => {
    const body = await mockResponse(
      {
        ...BASE,
        listedFolderShares: [
          {
            token: "e2e-older-row",
            displayName: "Photos",
            folderHash: "abc123",
            pathPrefix: "",
          },
        ],
      },
      "/v1/folder-shares",
    );

    expect((body as unknown[])[0]).not.toHaveProperty("source");
    const items = await requestFolderShareList("token", fetchOf(body));
    expect(toFolderRow(items[0]!, new Map()).source).toBe("drive");
  });
});
```

```bash
npx vitest run e2e/fixtures/mock-hcfs.contract.test.ts
```

Expected: FAIL. `items` is empty (`items[0]` undefined → TypeError) because the mock does not
know `listedFolderShares`. tsc also rejects the unknown option.

- [ ] **Step 2: Implement the fixture changes**

In `e2e/fixtures/mock-hcfs.ts`:

(a) `MockFolderShare`: add after `tree: MockTree;`:

```ts
  /**
   * Send the recursive totals `browse` carries since hcfs #368:
   * `recursive_file_count` / `recursive_bytes` for the listed directory and
   * `file_count` / `total_bytes` on each subfolder row. Off by default so the
   * older specs keep exercising the page's fallback of summing one level.
   */
  recursiveTotals?: boolean;
```

(b) Add a new exported interface after `MockFolderShare`:

```ts
/**
 * A row `GET /v1/folder-shares` lists that this tab did not mint, such as a
 * link made in the desktop app, which is where uploaded copies come from.
 * Its plaintext token never enters the tab's keystore, so the page manages
 * it through the by-hash routes or not at all.
 */
export interface MockListedFolderShare {
  /** Hashed with the mock wasm's algorithm to form `token_hash`. */
  token: string;
  displayName: string;
  /** Omitted from the wire when undefined, as an older server does. */
  source?: "drive" | "upload";
  /** `null` on an uploaded copy, which belongs to no drive. */
  folderHash: string | null;
  pathPrefix: string | null;
  /** RFC 3339; defaults to `MOCK_FOLDER_SHARE_EXPIRES`. */
  expiresAt?: string | null;
}
```

(c) `MockOptions`: in `capabilities?: { … }` add:

```ts
    /** `/v1/folder-shares/by-hash/{token_hash}` PATCH + DELETE. */
    folder_share_revoke_by_hash?: boolean;
```

and after `folderShares?: MockFolderShare[];` add:

```ts
  /** Owner-listing rows minted elsewhere (see `MockListedFolderShare`). */
  listedFolderShares?: MockListedFolderShare[];
```

(d) `Captured`: after `folderShareRevokes: string[];` add:

```ts
  /** Every by-hash `PATCH` body, with the `token_hash` it addressed. */
  folderShareByHashTtlUpdates: Array<{ tokenHash: string; ttl: string }>;
  /** Every by-hash `DELETE` `token_hash`, in order. */
  folderShareByHashRevokes: string[];
```

and initialise both to `[]` in the `captured` object literal next to `folderShareRevokes: [],`.

(e) After `function shareRelativePath`, add:

```ts
/** Every file under `dirPath` at any depth, totalled the way hcfs #368 does. */
function subtreeTotals(
  tree: MockTree,
  dirPath: string,
): { fileCount: number; totalBytes: number } {
  const files = filesUnder(tree, dirPath);
  return {
    fileCount: files.length,
    totalBytes: files.reduce(
      (sum, { file }) =>
        sum + (file.reportedSize ?? utf8(file.content).byteLength),
      0,
    ),
  };
}
```

(f) In `installHcfsMock`, after the `mintedFolderShares` declaration:

```ts
  // Rows minted elsewhere, listed beside this tab's mints. Stateful like the
  // minted ones: a by-hash PATCH rewrites the expiry, a by-hash DELETE sets
  // `revokedAt` and the row lingers until the (absent) reaper.
  const listedFolderShares = (options.listedFolderShares ?? []).map((row) => ({
    row,
    tokenHash: mockFolderShareTokenHash(row.token),
    expiresAt:
      row.expiresAt === undefined ? MOCK_FOLDER_SHARE_EXPIRES : row.expiresAt,
    revokedAt: null as string | null,
  }));
```

(g) In the recipient `browse` directory-mode branch, replace the `directories` construction
and the final `return json(route, { directories, files, … })` with:

```ts
        const directories = (dir.folders ?? []).map((name) => ({
          name,
          created_at: MOCK_FOLDER_SHARE_CREATED_AT,
          ...(share.recursiveTotals
            ? (() => {
                const t = subtreeTotals(
                  share.tree,
                  shareRelativePath(sharePath, name),
                );
                return { file_count: t.fileCount, total_bytes: t.totalBytes };
              })()
            : {}),
        }));
        const files = (dir.files ?? []).map((f) => ({
          name: f.name,
          path: shareRelativePath(sharePath, f.name),
          size_bytes: f.reportedSize ?? utf8(f.content).byteLength,
          uploaded_at: uploadedAt,
        }));
        const childCount = directories.length + files.length;
        const totals = share.recursiveTotals
          ? subtreeTotals(share.tree, sharePath)
          : null;
        return json(route, {
          directories,
          files,
          total_count: childCount,
          has_more: false,
          offset: 0,
          limit: childCount,
          ...(totals
            ? {
                recursive_file_count: totals.fileCount,
                recursive_bytes: totals.totalBytes,
              }
            : {}),
        });
```

(h) Immediately **before** the existing plaintext-token handler
(`const folderShareByToken = p.match(/^\/v1\/folder-shares\/([^/]+)$/);`), add:

```ts
    // Owner PATCH / DELETE addressed by `token_hash`, the only key a row
    // minted elsewhere offers. Unknown hash = the bodiless 404 the real
    // server returns.
    const folderShareByHash = p.match(
      /^\/v1\/folder-shares\/by-hash\/([0-9a-f]{64})$/,
    );
    if (folderShareByHash && (method === "PATCH" || method === "DELETE")) {
      const listed = listedFolderShares.find(
        (l) => l.tokenHash === folderShareByHash[1],
      );
      if (!listed) return route.fulfill({ status: 404, body: "" });
      if (method === "PATCH") {
        const body = JSON.parse(route.request().postData() ?? "{}") as {
          ttl: string;
        };
        captured.folderShareByHashTtlUpdates.push({
          tokenHash: listed.tokenHash,
          ttl: body.ttl,
        });
        listed.expiresAt =
          body.ttl === "never" ? null : MOCK_FOLDER_SHARE_EXPIRES;
        return json(route, { expires_at: listed.expiresAt });
      }
      captured.folderShareByHashRevokes.push(listed.tokenHash);
      listed.revokedAt = "2026-08-23T12:00:00Z";
      return route.fulfill({ status: 204, body: "" });
    }
```

(i) Replace the `GET /v1/folder-shares` response body with both row sets. Minted rows now say
`source: "drive"`, as a server with part 1 deployed does:

```ts
      return json(route, [
        ...mintedFolderShares.map((row) => ({
          token_hash: mockFolderShareTokenHash(MOCK_FOLDER_SHARE_TOKEN),
          folder_hash: row.mint.folder_hash,
          path_prefix: row.mint.path_prefix,
          display_name: row.mint.display_name,
          created_at: "2026-08-23T00:00:00Z",
          expires_at: row.expiresAt,
          revoked_at: row.revokedAt,
          source: "drive",
        })),
        ...listedFolderShares.map((l) => ({
          token_hash: l.tokenHash,
          folder_hash: l.row.folderHash,
          path_prefix: l.row.pathPrefix,
          display_name: l.row.displayName,
          created_at: "2026-08-23T00:00:00Z",
          expires_at: l.expiresAt,
          revoked_at: l.revokedAt,
          ...(l.row.source ? { source: l.row.source } : {}),
        })),
      ]);
```

(keep the existing explanatory comment above it).

- [ ] **Step 3: Run and confirm pass**

```bash
npx vitest run e2e/fixtures/mock-hcfs.contract.test.ts
npx tsc --noEmit
npx eslint e2e/fixtures/mock-hcfs.ts e2e/fixtures/mock-hcfs.contract.test.ts
```

Expected: contract file passes (2 new tests plus the existing ones), tsc clean, ESLint prints
nothing.

- [ ] **Step 4: Commit**

```bash
git add e2e/fixtures/mock-hcfs.ts e2e/fixtures/mock-hcfs.contract.test.ts
git commit -m "Let the HCFS mock serve uploaded folder copies" -m "The browser specs need owner rows minted elsewhere (source=upload, NULL
drive identity) with working by-hash expiry and revoke, and recipient
listings that send the recursive totals an uploaded copy is served with.
The contract test feeds the new rows through the real parser so the
fixture cannot drift from what the page reads."
```

---

#### Task 8: E2E — the recipient page over an uploaded copy

**Files:**
- Modify: `e2e/folder-share.spec.ts` (new `describe` at the end of the file)

- [ ] **Step 1: Write the spec**

Append to `e2e/folder-share.spec.ts` (all imports it needs, `formatBytes`, `readFileSync`,
`unzipSync`, `strFromU8`, `installHcfsMock`, `MockTree`, `Captured` and `Page`, are already
imported at the top. `wrappedBlobB64Url` and `breadcrumbs` are module-level helpers defined
earlier in the file):

```ts
// =============================================================================
// Recipient side — an uploaded copy (hcfs `source = 'upload'`)
// =============================================================================
//
// A folder shared from outside every drive is uploaded under the link's own
// key and served by the same meta/browse/blob routes in the same shapes. The
// recipient cannot tell the difference and must not need to. These tests run
// the recipient surface against a tree shaped like an uploaded folder: empty
// sub-folders kept, recursive totals computed from the upload's own entries,
// a fresh random key in the fragment. They prove the page leans on nothing a
// drive would have supplied. What the server must send is pinned in hcfs;
// this pins what the page does with it.

const UPLOAD_TOKEN = "e2e-uploaded-folder-copy";
const UPLOAD_NAME = "T2-KD";
// A random link key rather than a drive's derived one. The mock decrypt
// ignores key material; non-zero bytes keep this from silently reusing the
// drive fixture's all-zero key.
const UPLOAD_KEY_B64URL = Buffer.alloc(32, 0x5a).toString("base64url");

const UPLOAD_README = "uploaded from Downloads";
const UPLOAD_NOTES = "nested inside photos";
const UPLOAD_COVER = "mock-png-bytes";

const UPLOAD_TREE: MockTree = {
  "": {
    folders: ["drafts", "photos"],
    files: [{ name: "readme.txt", content: UPLOAD_README }],
  },
  // Empty sub-folders survive an upload (`kind = 'dir'` entries).
  drafts: {},
  photos: {
    folders: ["raw"],
    files: [
      { name: "cover.png", content: UPLOAD_COVER },
      { name: "notes.txt", content: UPLOAD_NOTES },
    ],
  },
  "photos/raw": {},
};

const UPLOAD_TOTAL_BYTES = [UPLOAD_README, UPLOAD_NOTES, UPLOAD_COVER].reduce(
  (sum, s) => sum + Buffer.byteLength(s, "utf8"),
  0,
);

async function setupUploadedCopy(page: Page): Promise<Captured> {
  return installHcfsMock(page, {
    driveLabel: "Unused",
    driveHash: "c".repeat(64),
    tree: {},
    folderShares: [
      {
        token: UPLOAD_TOKEN,
        displayName: UPLOAD_NAME,
        expiresAt: null,
        tree: UPLOAD_TREE,
        recursiveTotals: true,
      },
    ],
  });
}

/** A header stat's label and value, read as one string ("File No:3"). */
function headerStat(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator("xpath=..");
}

test.describe("folder share recipient: uploaded copy", () => {
  test("browses the copy: whole-folder totals, nested files, kept empty folders", async ({
    page,
  }) => {
    await setupUploadedCopy(page);
    await page.goto(`/share/folder/${UPLOAD_TOKEN}#k=${UPLOAD_KEY_B64URL}`);

    await expect(page.getByText(UPLOAD_NAME).first()).toBeVisible();
    await expect(page.getByText("readme.txt")).toBeVisible();

    // The header reads the server's recursive totals, not the one file at
    // the root: three files, all their bytes.
    await expect(headerStat(page, "File No:")).toHaveText("File No:3");
    await expect(headerStat(page, "Storage Used:")).toHaveText(
      `Storage Used:${formatBytes(UPLOAD_TOTAL_BYTES)}`,
    );

    // An empty folder from the upload is listed and enterable.
    await page.getByRole("button", { name: "drafts", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "This folder is empty" }),
    ).toBeVisible();

    await breadcrumbs(page)
      .getByRole("button", { name: UPLOAD_NAME, exact: true })
      .click();
    await page.getByRole("button", { name: "photos", exact: true }).click();
    await expect(page.getByText("notes.txt")).toBeVisible();
    await expect(page.getByText("cover.png")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "raw", exact: true }),
    ).toBeVisible();
  });

  test("search finds a nested file and a single download decrypts it", async ({
    page,
  }) => {
    const captured = await setupUploadedCopy(page);
    await page.goto(`/share/folder/${UPLOAD_TOKEN}#k=${UPLOAD_KEY_B64URL}`);
    await expect(page.getByText("readme.txt")).toBeVisible();

    await page.getByLabel("Search this folder").fill("notes");
    await expect(
      page.getByRole("button", { name: "notes.txt", exact: true }),
    ).toBeVisible();
    await expect(page.getByTitle("photos/notes.txt")).toBeVisible();
    expect(
      captured.folderShareBrowseQueries.some((q) => /(^|&)q=notes(&|$)/.test(q)),
    ).toBe(true);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Actions for notes.txt" }).click();
    await page.getByRole("menuitem", { name: "Download", exact: true }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe("notes.txt");
    expect(readFileSync(await download.path(), "utf8")).toBe(UPLOAD_NOTES);
  });

  test("Download folder zips every file in the copy", async ({ page }) => {
    const captured = await setupUploadedCopy(page);
    await page.goto(`/share/folder/${UPLOAD_TOKEN}#k=${UPLOAD_KEY_B64URL}`);
    await expect(page.getByText("readme.txt")).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download folder" }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe(`${UPLOAD_NAME}.zip`);
    expect(captured.folderShareBlobs.sort()).toEqual([
      "photos/cover.png",
      "photos/notes.txt",
      "readme.txt",
    ]);
    const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
    expect(Object.keys(files).sort()).toEqual([
      "photos/cover.png",
      "photos/notes.txt",
      "readme.txt",
    ]);
    expect(strFromU8(files["readme.txt"]!)).toBe(UPLOAD_README);
    expect(strFromU8(files["photos/notes.txt"]!)).toBe(UPLOAD_NOTES);
  });

  test("card view asks the copy for an image thumbnail", async ({ page }) => {
    // The mock bytes are not a decodable PNG, so the card falls back to its
    // file-type artwork. The point is that the thumbnail path fetches from
    // the uploaded copy's blob route like any other link.
    const captured = await setupUploadedCopy(page);
    await page.goto(`/share/folder/${UPLOAD_TOKEN}#k=${UPLOAD_KEY_B64URL}`);
    await page.getByRole("button", { name: "photos", exact: true }).click();
    await expect(page.getByText("cover.png")).toBeVisible();

    await page.getByRole("button", { name: "Card view" }).click();

    await expect
      .poll(() => captured.folderShareBlobs)
      .toContain("photos/cover.png");
    await expect(page.getByText("cover.png").first()).toBeVisible();
  });

  test("a password-protected copy unlocks into browsing", async ({ page }) => {
    await setupUploadedCopy(page);
    await page.goto(`/share/folder/${UPLOAD_TOKEN}#p=${wrappedBlobB64Url(1)}`);

    await expect(
      page.getByText("Enter the password from the sender"),
    ).toBeVisible();
    await page.getByPlaceholder("Password").fill("the-shared-password");
    await page.getByRole("button", { name: "Unlock" }).click();

    await expect(page.getByText("readme.txt")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "drafts", exact: true }),
    ).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the spec**

Stop any server already on :3100 (`reuseExistingServer` would reuse a stale build):

```bash
lsof -ti tcp:3100 | xargs -r kill
NEXT_PUBLIC_BUILD_ENV=development pnpm test:e2e e2e/folder-share.spec.ts
```

Expected: the build runs (a few minutes), then every test in `folder-share.spec.ts` passes,
including the 5 new `folder share recipient: uploaded copy` tests.

If `Download folder` names the zip differently, read `selectionZipFilename` in
`src/lib/files/folder-zip/zip-names.ts` and match the existing drive test (`"Design assets.zip"`).
The rule is the same, so `${UPLOAD_NAME}.zip` should hold. If `headerStat` matches more than
one element, scope it under the header container used by `FolderShareUi`
(`StorageStateList` sits next to the "Download folder" button).

Mutation check: temporarily make `fetchListing` ignore `recursive_file_count`
(`recursiveFileCount: null`) and confirm the totals assertion fails (it would read `File No:1`),
then revert.

- [ ] **Step 3: Commit**

```bash
git add e2e/folder-share.spec.ts
git commit -m "Cover an uploaded folder copy on the recipient page" -m "Folders shared from outside a drive reuse the recipient page unchanged.
Prove it end to end against a tree shaped like an upload: kept empty
folders, server-side totals, a random link key, search, single and folder
downloads, card thumbnails and a password link."
```

---

#### Task 9: E2E — the uploaded-copy row on the Shared Links page

**Files:**
- Modify: `e2e/shares-page.spec.ts` (new `describe` at the end)

- [ ] **Step 1: Write the spec**

Add to the imports at the top of `e2e/shares-page.spec.ts`:

```ts
import { mockFolderShareTokenHash } from "../src/lib/crypto-wasm";
```

Append:

```ts
/**
 * An uploaded copy the desktop app made: listed by the server, never minted
 * in this tab. No plaintext token or owner wrap reaches the page, so Copy is
 * session-bound, while expiry and revoke go through the by-hash routes, as
 * for any folder link made elsewhere. What differs is only the label.
 */
const UPLOADED_COPY = {
  token: "e2e-uploaded-copy-token",
  displayName: "T2-KD",
  source: "upload" as const,
  folderHash: null,
  pathPrefix: null,
};

test.describe("shares page uploaded-copy row", () => {
  let captured: Captured;

  test.beforeEach(async ({ page }) => {
    await seedSession(page);
    captured = await installHcfsMock(page, {
      driveLabel: DRIVE_LABEL,
      driveHash: DRIVE_HASH,
      tree: DRIVE_TREE,
      capabilities: {
        shares: true,
        folder_shares: true,
        folder_share_revoke_by_hash: true,
      },
      listedFolderShares: [UPLOADED_COPY],
    });
    await page.goto("/dashboard/storage/drive/shares");
    await expect(
      page.getByText(UPLOADED_COPY.displayName, { exact: true }),
    ).toBeVisible();
  });

  test("labels the copy, keeps Copy session-bound, and manages it by hash", async ({
    page,
  }) => {
    const tokenHash = mockFolderShareTokenHash(UPLOADED_COPY.token);

    // ----- Label: never "Whole drive" for a folder that is in no drive -----
    const label = page.getByText("Uploaded copy", { exact: true });
    await expect(label).toBeVisible();
    await expect(label).toHaveAttribute(
      "title",
      "A copy uploaded when the link was created. Later changes to the folder are not included.",
    );
    await expect(page.getByText("Whole drive", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Folder", { exact: true })).toBeVisible();

    // ----- Copy: the key never reached this tab -----
    await expect(page.getByText("Not available in this session")).toBeVisible();
    await openShareActionsMenu(page);
    await expect(
      page.getByRole("menuitem", { name: "Copy link" }),
    ).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");

    // ----- Change expiry: PATCH by hash -----
    await openShareActionsMenu(page);
    await page.getByRole("menuitem", { name: "Change expiry" }).click();
    await expect(page.getByText("Change link expiry")).toBeVisible();
    await page
      .locator("#folder-share-expiry")
      .selectOption({ label: "Until I revoke it" });
    await page.getByRole("button", { name: "Update expiry" }).click();
    await expect(page.getByText("Never", { exact: true })).toBeVisible();
    expect(captured.folderShareByHashTtlUpdates).toEqual([
      { tokenHash, ttl: "never" },
    ]);

    // ----- Revoke: DELETE by hash, row stays listed as Revoked -----
    await openShareActionsMenu(page);
    await page.getByRole("menuitem", { name: "Revoke" }).click();
    await expect(page.getByText("Revoke Shared Link")).toBeVisible();
    await page.getByRole("button", { name: "Revoke Link" }).click();

    await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
    expect(captured.folderShareByHashRevokes).toEqual([tokenHash]);
    // Nothing went through the plaintext-token route: this tab never had it.
    expect(captured.folderShareRevokes).toEqual([]);
    expect(captured.folderShareTtlUpdates).toEqual([]);
    // The label survives the revoke; a dead copy is still a copy.
    await expect(page.getByText("Uploaded copy", { exact: true })).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the spec**

```bash
lsof -ti tcp:3100 | xargs -r kill
NEXT_PUBLIC_BUILD_ENV=development pnpm test:e2e e2e/shares-page.spec.ts
```

Expected: both describes pass (the existing mint-driven test and the new uploaded-copy test).

If the shares page renders nothing until the capability settles, the `beforeEach` visibility wait
covers it. If the "Escape" leaves Radix's `pointer-events: none` behind, `openShareActionsMenu`
already clears it.

Mutation check: temporarily revert Task 4's subtitle to the old ternary and rerun. The test must
fail on `"Uploaded copy"` (it would read "Whole drive"). Revert.

- [ ] **Step 3: Commit**

```bash
git add e2e/shares-page.spec.ts
git commit -m "Cover the uploaded-copy row on the Shared Links page" -m "Owners will see folder links the desktop uploaded from outside a drive.
Prove the row reads \"Uploaded copy\" rather than \"Whole drive\", that Copy
stays session-bound, and that expiry and revoke work from any session
through the by-hash routes, as for every folder link made elsewhere."
```

---

#### Task 10: Full verification and PR

- [ ] **Step 1: Unit lane exactly as CI runs it**

```bash
npx tsc --noEmit
pnpm exec vitest run
```

Expected: tsc clean. Vitest reports all projects (node, jsdom, contract) passing, with 0 failed.

- [ ] **Step 2: Lint every touched file**

```bash
npx eslint src/lib/files/share/folder-share-source.ts src/lib/files/share/folder-share-source.test.ts \
  src/lib/hooks/useFolderShares.ts src/lib/hooks/useFolderShares.test.ts \
  src/lib/hooks/useFolderSharesIndex.ts src/lib/hooks/useFolderSharesIndex.test.ts \
  src/components/files/SharesPageClient.tsx src/components/files/shares-page-client.test.ts \
  "src/app/api/hcfs/public/[...path]/public-proxy.test.ts" \
  "src/app/share/folder/[token]/page.tsx" "src/app/share/folder/[token]/recipient.test.ts" \
  e2e/fixtures/mock-hcfs.ts e2e/fixtures/mock-hcfs.contract.test.ts \
  e2e/folder-share.spec.ts e2e/shares-page.spec.ts
```

Expected: no new warnings or errors. Compare any pre-existing ones against a `git stash`
baseline.

- [ ] **Step 3: Whole e2e suite (required CI check)**

```bash
lsof -ti tcp:3100 | xargs -r kill
NEXT_PUBLIC_BUILD_ENV=development pnpm test:e2e
```

Expected: every spec passes. In particular `drive-sharing-badge.spec.ts` must stay green, since
minted owner rows now carry `source: "drive"`.

- [ ] **Step 4: Adversarial self-review before opening the PR**

Check: no place outside `useFolderSharesIndex` builds a badge from folder rows
(`rg -n "toFolderRow|requestFolderShareList" src`). Check that `folderShareTarget` is untouched.
Check that no recipient route file gained a fetch or a forbidden word. Check that
`FolderShareRow.source` is set on every construction path (`rg -n "kind: \"folder\"" src e2e`).

- [ ] **Step 5: Push and open the PR against `dev`**

```bash
git push -u origin feat/upload-folder-share-rows-dev
gh pr create --base dev --title "Label uploaded folder copies and keep them off the drive badge" --body "$(cat <<'EOF'
## What this does

Folder links can now be uploaded copies of a folder outside every drive (hcfs `source = 'upload'`, made from the desktop app's Finder share). This PR makes the console handle them:

- **Shared Links page:** an uploaded copy's second line reads "Uploaded copy", with a tooltip saying that later changes to the folder are not included. It previously would have read "Whole drive". Copy, Change expiry and Revoke behave as for any folder link: by-hash from any session, Copy only where the key is available.
- **Drive badge:** uploaded copies are never indexed, so they cannot mark a drive folder as shared.
- **Owner listing parse:** reads the optional `source` (absent means drive) and accepts `null` `folder_hash`/`path_prefix`.
- **Recipient page:** no behaviour change. A new test pins that the route never reads a drive identity, and the comments now describe both kinds of link.
- **Public proxy:** a pin that the new authenticated `v1/folder-shares/uploads/...` routes are never forwarded anonymously.

User-visible: "Folders shared from the desktop app from outside a drive show as Uploaded copy in Shared links."

## Compatibility

Safe to merge before the hcfs change ships: with no `source` field every row stays a drive row and nothing changes.

## Tests

- Unit: source parsing and label helper; listing parse (absent `source`, `null` identity); badge exclusion; grep pins for the shares page, the recipient route and the proxy; mock contract for `source`.
- E2E: an uploaded-copy link through browse, totals, empty folders, search, single download, Download folder, card thumbnail fetch and password link; the Shared Links row label with by-hash expiry and revoke.
EOF
)"
```

---

### Open risks

1. **The console cannot prove the server.** The e2e suite runs against the mock, so it proves the
   page tolerates the upload-backed wire, not that hcfs produces it. Part 1's server tests must
   cover browse/search/blob over `folder_share_files`. Before promoting to `main`, open one real
   uploaded copy on the staging hcfs in the dev console and run browse, search, Download folder
   and the password link by hand.
2. **Blob `Content-Type`.** If hcfs serves upload blobs with anything other than
   `application/octet-stream`, the public proxy buffers the body as text and the decrypt fails,
   which the page then shows as "expired or unavailable". Nothing in this repo can catch that.
   Part 1 must pin the header.
3. **`Range` on upload blobs.** Without 206 support, every video thumbnail downloads the whole
   ciphertext (up to 5 GiB per file). It still works, but it is slow and costs bandwidth.
4. **Download folder vs the 5 GiB per-file limit.** The recipient zip is classic (non-zip64) and
   refuses entries or totals past the classic limits (`classicZipOverflowReason`). An uploaded
   copy holding a file over 4 GiB cannot be zipped, though single-file download still works. The
   same is already true of drive links, but outside folders (Downloads) hit it more often.
5. **Empty sub-folders are not in the zip.** The zip is built from files only (pre-existing for
   drive links). The browse view shows them; the downloaded archive does not.
6. **`uploading` rows in the owner listing.** The design says they are absent. If the server
   ever lists them, the page would show a live-looking row whose link 404s. The console
   deliberately does not filter on `upload_state` (no phantom field). Revisit if part 1 changes
   that.
7. **Unknown future `source` values** are read as `drive` and labelled with the path or "Whole
   drive". They are safe for the badge only while such rows carry no drive identity.
8. **No size for uploaded copies on the Shared Links page.** The owner listing carries no total.
   The size cell shows "Folder" as it does for drive links. A follow-up could show
   `total_bytes` if hcfs adds it to the listing.
9. **The thumbnail e2e asserts the fetch, not the rendered image.** Mock bytes are not a real
   PNG, so rasterization falls back. Real-image coverage remains in unit tests of
   `folder-share-thumbnail.ts`.

---

# Part 3 — hippius-desktop

## PART 3: hippius-desktop (sharing a folder from outside a drive)

> **For the implementer:** work task by task, red then green. Each task ends in one
> commit. Branch off `origin/staging` (e.g. `feat/outside-folder-share`). Use Node 22
> (`nvm use 22`) for every `pnpm` command, because Node 18 fails 3 folder-share tests. Before your
> first edit, call `mcp__hippius-mem__recall` with
> "outside folder share uploaded copy Finder desktop", and `get` notes
> `mem_01M3Y1G1WYMA7W15VYCP089717` (null `folder_hash` breaks old listings) and
> `mem_01M3Y1GA6XN8Y5S2EQTVJ31ZE7` (Finder cancel drops the future). When you find a
> durable gotcha, record it with `mcp__hippius-mem__remember`.

**Goal:** Finder "Share with Hippius" on a folder outside every synced drive should produce
a live `/share/folder/{token}` link. The folder's files are uploaded as a copy under the
link's own key. The copy appears as one row labelled "Uploaded copy" in Shared links, and
the server deletes it when the link expires or is revoked.

**Architecture:** add a pure Rust scan (`shares/folder_scan.rs`). It uses the drive
upload's own skip rules, which this plan extracts once into `pathops::visible_children`.
A Rust funnel (`shares/outside_folder.rs`) then runs these steps in order: capability →
scan → `/can_upload` gate → `create_upload_folder_share` → owner wrap.
`finder_bridge/dispatch.rs` routes `ShareTarget::Outside` directories into that funnel and
hands it the cancel token. It no longer races the token. The FE only renders two
Rust-chosen facts: `isFolderCopy` on the chooser event and `source` on listing rows.

**Tech:** Rust (tokio, tokio-util 0.7 `CancellationToken`, axum 0.8 mocks), hcfs-client at
`<HCFS_REV>`, Next.js + Vitest.

**Style gates (all tasks):**
- Functions ≤100 lines and cyclomatic complexity ≤8. At most 5 positional parameters; use a
  request struct when more are needed.
- Write lines ≤100 chars. `cargo fmt` (repo `max_width = 150`) may re-join some of them, so
  accept what fmt produces.
- Log through `tracing` only, never per file. A Rust test that touches `$HOME` takes
  `crate::test_helpers::HOME_LOCK`. Integration tests use the suite's `TEST_HOME`
  LazyLock instead.
- A sync `#[tauri::command]` runs on the main thread. This plan adds no command, and every
  filesystem walk goes through `spawn_blocking`.
- Commit messages: imperative mood, ≤72 chars, a body that says why. No Co-Authored-By
  line, no emojis.

---

### Contract deviations

The real code differs from `contract.md` in the following ways. PART 1 / PART 2 owners
should confirm or adapt these items.

1. **`UploadFolderShareOptions` borrows and carries `console_base_url`.** It mirrors the
   existing `FolderShareOptions<'a>` (`hcfs-client/src/client/folder_share.rs:124`), with
   fields `display_name: &'a str`, `ttl: ShareTtl`, `password: Option<&'a str>` and
   `console_base_url: &'a str`. The client builds `share_url` from that base through
   `build_folder_share_url_for`. Without it the client cannot return a usable
   `CreatedFolderShare`.
2. **Keystore parameter is `&dyn hcfs_client::client::share::ShareKeystore`.** It is the
   real trait (`share.rs:302`, methods `put`/`get`/`forget`). The desktop passes
   `crate::shares::SqliteShareKeystore`. The password type is `Option<&str>`, the same
   type `create_folder_share` takes.
3. **`ShareTtl` path.** `hcfs_client::client::share::ShareTtl`, which `folder_share`
   re-exports. The cancel token is `tokio_util::sync::CancellationToken` (0.7, the same
   crate the desktop already depends on).
4. **Error type is `FolderShareError`**, extended by PART 1 with two variants this plan
   matches by name: `SourceChanged { relative_path: String }` (size or mtime moved before
   or after upload, or the file vanished) and `Cancelled` (the token fired and the abort
   `DELETE` was sent). If PART 1 picks other names, change the match in
   `map_upload_folder_share_error` (Task 3). The unit test there pins the user-facing
   messages, not the variant names.
5. **The client is account-scoped** (`shares::client::build_account_client`, empty
   `folder_hash`). An upload link has no drive. `create_upload_folder_share` must not
   return `MissingFolderHash`.
6. **Owner wrap is `owner_wrap::push_folder_for_account`**, not `push_for_account`. The
   token lives in the folder-share wrap table, which is what `list_folder_shares_inner`
   reconciles through `sync_folder_wraps`.
7. **The capability flag belongs to a desktop-owned struct.** The desktop parses
   `/v1/capabilities` itself (`shares/capabilities.rs::ServerCapabilities`, not an
   hcfs-client type), so `upload_folder_shares` is added there and pinned in that file's
   wire-key test. `tests/hcfs_contract.rs` pins only the hcfs-client types.
8. **The listing needs `""` and not `null` for `folder_hash` / `path_prefix` on upload
   rows. This is a cross-repo requirement on PART 1.** The pinned client
   (`ListItemWire`, `folder_share.rs:312`) declares both fields as required `String`, and
   the listing parses as one unit. If the server sends `null`, every shipped desktop and
   console loses its whole folder-share list as soon as one upload row exists.
   - The server must serialize those columns as `""`.
   - The new client should also accept `null`, so a later server mistake does not
     break new builds.
   - `FolderShareListItem` keeps `folder_hash: String` / `path_prefix: String`. If PART 1
     makes them `Option<String>`, Task 5 maps them with `.unwrap_or_default()`.
9. **`FolderShareSource` is converted, not forwarded.** The desktop maps it to its own
   `FolderShareOrigin { Drive, UploadedCopy }`, serialized as `"drive"` / `"uploadedCopy"`.
   That way Rust chooses the label key the FE reads, and an upstream rename fails the
   build. If the type is `#[non_exhaustive]`, add a `_ => Self::Drive` arm with a comment.
10. **Entry conventions the server and console must share.**
    - `relative_path` is `/`-joined, relative to the shared folder, and excludes the
      folder's own name, which becomes `display_name`. It has no leading or trailing `/`.
    - The scan emits `Dir` entries only for visible directories that have no visible
      children ("empty sub-folders"). Every other directory is implied by the files under
      it.
11. **The cap is counted over entries, not just files.** The desktop refuses more than
    50,000 entries (files plus kept empty dirs, each one a server row). That is at or
    below any reading of "≤ 50,000 files". The 5 GiB per-file cap is checked during the
    scan, so a large file fails before anything uploads. If PART 1 exports the limits as
    constants, import them instead of the local ones in `folder_scan.rs`.
12. **Addition not in the contract: `finder:share-choosing` gains
    `isFolderCopy: bool`.** Rust sets it so the chooser can say the folder is uploaded as
    a copy. Showing the existing "link always shows the current contents" notice would be
    false for a copy.

---

### Task 1: Bump the hcfs pin, pin the new client surface, add the capability flag

**Files:**
- Modify: `src-tauri/Cargo.toml` (~lines 197–225: comment block, `hcfs-client` rev,
  `hcfs-shared` rev), `src-tauri/Cargo.lock`
- Modify: `src-tauri/tests/hcfs_contract.rs` (imports at lines 21–24; existing literal at
  lines 816–828; new test after line 843)
- Modify: `src-tauri/src/shares/commands.rs` (test helper `mk_folder_row`, ~line 2385)
- Modify: `src-tauri/src/shares/capabilities.rs` (struct ~line 34; tests ~lines 186–227)
- Modify: `app/lib/tauri/shares.ts` (`ServerCapabilities`, ~line 51)

**Step 1: Bump the rev.** Set both `hcfs-client` and `hcfs-shared` to
`rev = "<HCFS_REV>"`. Add one comment paragraph above them, in the style of the block's
existing paragraphs:

```toml
# Now at hcfs main <HCFS_REV_SHORT> (#<PR>): folder links whose files are
# uploaded as a copy (`create_upload_folder_share`, `UploadFolderEntry`,
# `FolderShareListItem::source`) for Finder shares of folders outside every
# drive. The owner listing sends "" (never null) for an upload row's
# folder_hash/path_prefix — older builds parse those as required strings.
```

Run: `cd src-tauri && cargo update -p hcfs-client -p hcfs-shared && cargo build 2>&1 | tail -20`

Expected: the build fails to compile only at `FolderShareListItem { .. }` literals, which
are missing the `source` field. That is the pin working.

**Step 2: Fix the two existing literals.** In `tests/hcfs_contract.rs` (line 816), add
`source: FolderShareSource::Drive,` to the literal and `FolderShareSource` to the line-21
import. Do the same in `mk_folder_row` in `src/shares/commands.rs` (the import goes in the
test module's `use`).

**Step 3: Write the new surface pin (red until the rev has the API).** Append to
`tests/hcfs_contract.rs`:

```rust
/// Compile-time pin of the uploaded-copy folder-share surface the Finder
/// outside-folder share consumes (`shares/outside_folder.rs`). Exhaustive
/// literals: a renamed, dropped or added field fails here, in the pin-bump
/// PR, not in the share path at runtime.
#[test]
fn upload_folder_share_client_surface_is_reachable() {
    let file = UploadFolderEntry::File {
        relative_path: "sub/a.txt".to_string(),
        source: std::path::PathBuf::from("/tmp/T2-KD/sub/a.txt"),
        size: 5,
    };
    let dir = UploadFolderEntry::Dir {
        relative_path: "empty".to_string(),
    };
    assert!(matches!(file, UploadFolderEntry::File { size: 5, .. }));
    assert!(matches!(dir, UploadFolderEntry::Dir { .. }));

    let options = UploadFolderShareOptions {
        display_name: "T2-KD",
        ttl: ShareTtl::Days7,
        password: None,
        console_base_url: "https://console.example.com",
    };
    assert_eq!(options.display_name, "T2-KD");

    // The listing's source discriminator: both variants exist, and Drive is
    // what a row from an older server reads as.
    let sources = [FolderShareSource::Drive, FolderShareSource::Upload];
    assert_eq!(sources.len(), 2);

    let _ = hcfs_client::client::HcfsClient::create_upload_folder_share;
}
```

Extend the line-21 import with `FolderShareSource, UploadFolderEntry, UploadFolderShareOptions`.
If PART 1 derives `Default` on `FolderShareSource`, also add
`assert_eq!(FolderShareSource::default(), FolderShareSource::Drive);`. That line pins the
serde-default semantics the contract promises.

Run: `cd src-tauri && cargo test --test hcfs_contract`
Expected: `test result: ok.` and the new test is listed.

**Step 4: Add the capability flag (red first).** In `capabilities.rs`:
- Extend `full_capabilities_shape_round_trips`: add `"upload_folder_shares":true` to the
  JSON, add `assert!(caps.upload_folder_shares);`, add `"upload_folder_shares"` to the
  expected key set (keep it sorted), and add
  `assert!(!old.upload_folder_shares, "an older server never claims uploaded folder links");`.
- Add:

```rust
/// Uploaded-copy folder links ship after browsable folder shares, so a server
/// can advertise `folder_shares` without them. That must read as "not yet",
/// which is what keeps the Finder outside-folder share on its
/// "isn't available yet" refusal instead of a 404 mid-upload.
#[test]
fn folder_shares_without_uploads_reads_as_uploads_unavailable() {
    let caps: ServerCapabilities = serde_json::from_str(r#"{"shares":true,"folder_shares":true}"#).expect("parse");
    assert!(caps.folder_shares);
    assert!(!caps.upload_folder_shares);
}
```

Run: `cd src-tauri && cargo test --lib shares::capabilities`
Expected: compile error, because `no field upload_folder_shares`.

**Step 5: Add the field** after `folder_grant_writes`:

```rust
    /// Folder links whose files are uploaded as a copy
    /// (`/v1/folder-shares/uploads`), which is how a folder outside every
    /// drive is shared from Finder. Absent on older servers; the Finder path
    /// refuses with "isn't available yet" without it.
    pub upload_folder_shares: bool,
```

Add to `ServerCapabilities` in `app/lib/tauri/shares.ts`:

```ts
  /**
   * Folder links whose files are uploaded as a copy (Finder shares of a
   * folder outside every drive). Read by Rust only; listed so the type
   * matches the wire.
   */
  upload_folder_shares?: boolean;
```

Run: `cd src-tauri && cargo test --lib shares::capabilities && cargo clippy --all-targets -- -D warnings`
Expected: all pass, no warnings.

**Step 6: Live lane (required before merging the bump PR, per CLAUDE.md).** Push the
branch, then run `gh workflow run e2e-live.yml --ref <branch> -f suite=all`. Wait for a
green run before merging. Task 8 adds the uploaded-copy scenario to that lane. Put the bump
PR and Task 8 in the same PR, or run the lane again after Task 8 lands.

**Step 7: Commit**

```
Bump hcfs to <HCFS_REV_SHORT> for uploaded-copy folder links

The client gains create_upload_folder_share and the listing a source
field, which the Finder outside-folder share builds on. The new surface
is pinned in hcfs_contract.rs so a reshaping bump fails here, and the
server's upload_folder_shares flag is parsed so an older server reads
as "not available" rather than a 404 mid-upload.
```

---

### Task 2: Pure folder scan that reuses the drive-upload skip rules

**Files:**
- Modify: `src-tauri/src/sync/fileops/files/mod.rs:28` (`pub(super) mod pathops;` →
  `pub(crate) mod pathops;`)
- Modify: `src-tauri/src/sync/fileops/files/pathops.rs` (add `visible_children` after
  `is_engine_hidden_name`, line 36)
- Modify: `src-tauri/src/sync/fileops/remote_upload.rs:610-641` (`plan_folder_upload`
  uses it)
- Create: `src-tauri/src/shares/folder_scan.rs`
- Modify: `src-tauri/src/shares/mod.rs` (add `pub(crate) mod folder_scan;`)

#### 2a: Extract the shared entry filter (a refactor; existing tests are the guard)

**Step 1.** Add to `pathops.rs`:

```rust
/// What a visible directory child is.
pub(crate) enum VisibleKind {
    Dir,
    /// A regular file and its length when it was listed.
    File { size: u64 },
}

/// One child of a directory that an upload of the tree carries.
pub(crate) struct VisibleEntry {
    /// UTF-8 name. Wire paths are strings, so a non-UTF-8 name has no
    /// representation and is skipped (APFS stores UTF-8, so on macOS this
    /// never fires).
    pub name: String,
    pub path: PathBuf,
    pub kind: VisibleKind,
}

/// The children of `dir` that an upload of the tree carries, in `read_dir`
/// order.
///
/// One definition for every walk that uploads a local tree (a folder upload
/// into a drive, a folder shared as an uploaded copy), so each holds the
/// file set the engine would sync:
/// - dot-names are skipped ([`is_engine_hidden_name`]);
/// - symlinks and special files are skipped: `DirEntry::metadata` does not
///   follow links, so a link is neither file nor dir, which also keeps a
///   link cycle from ever being walked;
/// - an entry that vanished between `read_dir` and its stat is skipped.
///
/// # Errors
///
/// Only the `read_dir` of `dir` itself. The caller decides whether an
/// unreadable directory is skippable (drive upload) or fatal (a share must
/// not silently drop a subfolder).
pub(crate) fn visible_children(dir: &Path) -> std::io::Result<Vec<VisibleEntry>> {
    let mut children = Vec::new();
    for entry in std::fs::read_dir(dir)?.flatten() {
        let name = entry.file_name();
        if is_engine_hidden_name(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Some(name) = name.to_str() else { continue };
        let kind = if meta.is_dir() {
            VisibleKind::Dir
        } else if meta.is_file() {
            VisibleKind::File { size: meta.len() }
        } else {
            continue;
        };
        children.push(VisibleEntry {
            name: name.to_owned(),
            path: entry.path(),
            kind,
        });
    }
    Ok(children)
}
```

**Step 2.** Replace the inner loop of `plan_folder_upload` (lines 623–639) with:

```rust
        let Ok(children) = super::files::pathops::visible_children(&dir) else { continue };
        for child in children {
            match child.kind {
                super::files::pathops::VisibleKind::Dir => {
                    stack.push((child.path, wire_relative_path(&parent, &child.name)));
                }
                super::files::pathops::VisibleKind::File { .. } => planned.push(PlannedUpload {
                    source: child.path,
                    parent: parent.clone(),
                }),
            }
        }
```

Update its doc comment: "Hidden names, symlinks and non-UTF-8 names are skipped by
`pathops::visible_children`, the rule every tree upload shares."

**Step 3.** Add a symlink case to the existing `remote_upload.rs` tests. A refactor of a
filter needs proof that the filter still filters:

```rust
    /// A symlink is never uploaded: it is neither a file nor a directory to
    /// the walk, which is also what keeps a link cycle out of it.
    #[cfg(unix)]
    #[test]
    fn a_folder_upload_skips_symlinks() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("Photos");
        std::fs::create_dir_all(&root).expect("dir");
        std::fs::write(root.join("a.jpg"), b"a").expect("file");
        std::os::unix::fs::symlink(root.join("a.jpg"), root.join("link.jpg")).expect("file link");
        std::os::unix::fs::symlink(&root, root.join("loop")).expect("dir link");

        let planned = plan_folder_upload(&root, "");
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].source.file_name().unwrap(), "a.jpg");
    }
```

Run: `cd src-tauri && cargo test --lib remote_upload`
Expected: every `a_folder_upload_*` test passes, the new one included. To check the test
can fail, temporarily change `entry.metadata()` to `std::fs::metadata(entry.path())`
(which follows links): the test must fail with `left: 2`. Then revert.

#### 2b: The scan (red, then green)

**Step 4.** Create `src-tauri/src/shares/folder_scan.rs` with the tests first. The full
module is below. Write the tests, run them red with `todo!()` bodies, then fill in the
code.

```rust
//! Walk a folder that lives outside every drive into the entries an
//! uploaded-copy folder link is built from (see `shares::outside_folder`).
//!
//! Pure apart from reading the tree, so the rules (what is skipped, what is
//! kept, where the walk refuses) are unit-tested on a tempdir without a
//! server. The skip rules are the drive upload's own
//! ([`crate::sync::files::pathops::visible_children`]), not a second copy:
//! a folder shared here holds the same file set it would hold if uploaded
//! into a drive.

use std::path::{Path, PathBuf};

use hcfs_client::client::folder_share::UploadFolderEntry;

use crate::error::{AppError, Result};
use crate::sync::files::pathops::{VisibleKind, visible_children};
use crate::sync::remote_upload::wire_relative_path;

/// Bounds one scan enforces. A struct so tests can shrink them; production
/// always uses [`ScanLimits::SHARED_FOLDER`].
#[derive(Clone, Copy, Debug)]
pub(crate) struct ScanLimits {
    /// Files plus kept empty folders. Each is a row on the server, so both
    /// count toward the link's 50,000 cap.
    pub max_entries: usize,
    /// The server's per-file cap, checked here so an oversized file fails
    /// before anything is uploaded rather than after the files ahead of it.
    pub max_file_bytes: u64,
    /// Depth the walk descends before refusing. Symlinks are never followed,
    /// so this bounds a pathological tree, not a cycle.
    pub max_depth: usize,
}

impl ScanLimits {
    pub(crate) const SHARED_FOLDER: Self = Self {
        max_entries: 50_000,
        max_file_bytes: 5 * 1024 * 1024 * 1024,
        max_depth: 64,
    };
}

/// The scanned folder: what to upload and what it will cost.
#[derive(Debug)]
pub(crate) struct FolderScan {
    pub entries: Vec<UploadFolderEntry>,
    pub file_count: usize,
    /// Plaintext bytes of every file, the size the `/can_upload` gate asks about.
    pub total_bytes: u64,
}

impl FolderScan {
    fn push_file(&mut self, limits: &ScanLimits, relative_path: String, source: PathBuf, size: u64) -> Result<()> {
        if size > limits.max_file_bytes {
            return Err(AppError::Validation(format!(
                "\u{201c}{relative_path}\u{201d} is larger than 5 GB, the most one file in a \
                 shared folder can be."
            )));
        }
        self.reserve_entry(limits)?;
        self.file_count += 1;
        self.total_bytes = self.total_bytes.saturating_add(size);
        self.entries.push(UploadFolderEntry::File {
            relative_path,
            source,
            size,
        });
        Ok(())
    }

    fn push_empty_dir(&mut self, limits: &ScanLimits, relative_path: String) -> Result<()> {
        self.reserve_entry(limits)?;
        self.entries.push(UploadFolderEntry::Dir { relative_path });
        Ok(())
    }

    fn reserve_entry(&self, limits: &ScanLimits) -> Result<()> {
        if self.entries.len() >= limits.max_entries {
            return Err(AppError::Validation(
                "This folder has too many files to share as one link (the most is 50,000). \
                 Share a smaller folder."
                    .into(),
            ));
        }
        Ok(())
    }
}

/// Scan `root` with the production limits. Blocking; run it on
/// `spawn_blocking`.
pub(crate) fn scan_folder(root: &Path) -> Result<FolderScan> {
    scan_folder_with(root, &ScanLimits::SHARED_FOLDER)
}

/// Scan `root` for an uploaded-copy link.
///
/// Paths are `/`-joined and relative to `root`; its own name is the link's
/// display name, not a path segment. A visible directory with no visible
/// children is kept as a `Dir` entry so the recipient still sees it. Every
/// other directory is implied by the files under it.
///
/// # Errors
///
/// [`AppError::Validation`] for an unreadable directory (named), a tree
/// deeper than `max_depth`, a file over `max_file_bytes` (named), more than
/// `max_entries` entries, or a folder with no files at all.
pub(crate) fn scan_folder_with(root: &Path, limits: &ScanLimits) -> Result<FolderScan> {
    let mut scan = FolderScan {
        entries: Vec::new(),
        file_count: 0,
        total_bytes: 0,
    };
    let mut pending = vec![(root.to_path_buf(), String::new(), 0usize)];

    while let Some((dir, relative, depth)) = pending.pop() {
        let mut children = visible_children(&dir).map_err(|e| unreadable(&relative, &e))?;
        if children.is_empty() && !relative.is_empty() {
            scan.push_empty_dir(limits, relative)?;
            continue;
        }
        // Deterministic order, so a share of the same tree always declares
        // the same list.
        children.sort_by(|a, b| a.name.cmp(&b.name));
        for child in children {
            let child_relative = wire_relative_path(&relative, &child.name);
            match child.kind {
                VisibleKind::File { size } => scan.push_file(limits, child_relative, child.path, size)?,
                VisibleKind::Dir if depth + 1 > limits.max_depth => return Err(too_deep(&child_relative)),
                VisibleKind::Dir => pending.push((child.path, child_relative, depth + 1)),
            }
        }
    }

    if scan.file_count == 0 {
        return Err(AppError::Validation("This folder has no files to share.".into()));
    }
    Ok(scan)
}

/// An unreadable directory fails the share rather than being skipped: a
/// link silently missing a subfolder is worse than an error. On macOS the
/// usual cause is a privacy prompt the user declined.
fn unreadable(relative: &str, error: &std::io::Error) -> AppError {
    let place = if relative.is_empty() {
        "this folder".to_owned()
    } else {
        format!("\u{201c}{relative}\u{201d}")
    };
    AppError::Validation(format!(
        "Hippius can't read {place} ({error}). If macOS asked for access, allow it in System \
         Settings \u{2192} Privacy & Security \u{2192} Files and Folders, then share again."
    ))
}

fn too_deep(relative: &str) -> AppError {
    AppError::Validation(format!(
        "\u{201c}{relative}\u{201d} is nested too deeply to share. Share a folder with fewer \
         levels of subfolders."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny(max_entries: usize, max_file_bytes: u64, max_depth: usize) -> ScanLimits {
        ScanLimits {
            max_entries,
            max_file_bytes,
            max_depth,
        }
    }

    fn paths(scan: &FolderScan) -> Vec<String> {
        let mut out: Vec<String> = scan
            .entries
            .iter()
            .map(|e| match e {
                UploadFolderEntry::File { relative_path, .. } => format!("f:{relative_path}"),
                UploadFolderEntry::Dir { relative_path } => format!("d:{relative_path}"),
            })
            .collect();
        out.sort();
        out
    }

    fn tree() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("T2-KD");
        std::fs::create_dir_all(root.join("sub/deeper")).expect("dirs");
        std::fs::create_dir_all(root.join("empty")).expect("empty dir");
        std::fs::write(root.join("a.txt"), b"hello").expect("a");
        std::fs::write(root.join("sub/deeper/b.bin"), vec![7u8; 1_000]).expect("b");
        (dir, root)
    }

    /// Paths are relative to the shared folder (its own name is the link's
    /// display name), files carry their size, and only the EMPTY folder is
    /// listed: `sub/` and `sub/deeper/` are implied by `b.bin`.
    #[test]
    fn lists_files_and_only_empty_folders_relative_to_the_root() {
        let (_dir, root) = tree();
        let scan = scan_folder(&root).expect("scan");
        assert_eq!(paths(&scan), vec!["d:empty", "f:a.txt", "f:sub/deeper/b.bin"]);
        assert_eq!(scan.file_count, 2);
        assert_eq!(scan.total_bytes, 1_005);
    }

    /// The drive upload's rule, not a new one: dot-names are skipped, and a
    /// folder holding only hidden files is an EMPTY folder to the recipient.
    #[test]
    fn skips_what_the_drive_upload_skips() {
        let (_dir, root) = tree();
        std::fs::write(root.join(".DS_Store"), b"x").expect("hidden file");
        std::fs::create_dir_all(root.join(".git")).expect("hidden dir");
        std::fs::write(root.join(".git/config"), b"x").expect("file in hidden dir");
        std::fs::create_dir_all(root.join("only-hidden")).expect("dir");
        std::fs::write(root.join("only-hidden/.keep"), b"").expect("hidden child");

        let scan = scan_folder(&root).expect("scan");
        assert_eq!(
            paths(&scan),
            vec!["d:empty", "d:only-hidden", "f:a.txt", "f:sub/deeper/b.bin"]
        );
    }

    /// A link is neither file nor folder to the walk, so a link to a file is
    /// not uploaded twice and a link back to the root is never followed.
    #[cfg(unix)]
    #[test]
    fn never_follows_symlinks() {
        let (_dir, root) = tree();
        std::os::unix::fs::symlink(root.join("a.txt"), root.join("alias.txt")).expect("file link");
        std::os::unix::fs::symlink(&root, root.join("loop")).expect("dir link");

        let scan = scan_folder(&root).expect("scan");
        assert_eq!(paths(&scan), vec!["d:empty", "f:a.txt", "f:sub/deeper/b.bin"]);
    }

    #[test]
    fn refuses_a_folder_with_no_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("Nothing");
        std::fs::create_dir_all(root.join("also-empty")).expect("dirs");
        std::fs::write(root.join(".DS_Store"), b"x").expect("hidden only");

        let err = scan_folder(&root).expect_err("no files");
        assert!(matches!(&err, AppError::Validation(m) if m.contains("no files")), "{err:?}");
    }

    /// The cap counts every row: two files plus one kept empty folder is
    /// three entries.
    #[test]
    fn refuses_past_the_entry_cap_and_accepts_at_it() {
        let (_dir, root) = tree();
        assert!(scan_folder_with(&root, &tiny(3, u64::MAX, 64)).is_ok(), "exactly at the cap");
        let err = scan_folder_with(&root, &tiny(2, u64::MAX, 64)).expect_err("one past");
        assert!(matches!(&err, AppError::Validation(m) if m.contains("too many files")), "{err:?}");
    }

    #[test]
    fn refuses_an_oversized_file_naming_it() {
        let (_dir, root) = tree();
        let err = scan_folder_with(&root, &tiny(100, 999, 64)).expect_err("b.bin is 1,000 bytes");
        assert!(matches!(&err, AppError::Validation(m) if m.contains("sub/deeper/b.bin")), "{err:?}");
    }

    #[test]
    fn refuses_a_tree_deeper_than_the_limit() {
        let (_dir, root) = tree();
        assert!(scan_folder_with(&root, &tiny(100, u64::MAX, 2)).is_ok(), "depth 2 fits");
        let err = scan_folder_with(&root, &tiny(100, u64::MAX, 1)).expect_err("sub/deeper is depth 2");
        assert!(matches!(&err, AppError::Validation(m) if m.contains("sub/deeper")), "{err:?}");
    }

    /// An unreadable subfolder fails the share and is named, rather than
    /// being silently left out of the link.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_subfolder_fails_and_is_named() {
        use std::os::unix::fs::PermissionsExt;

        let (_dir, root) = tree();
        let locked = root.join("sub");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        // Root ignores permissions; the case is unobservable there.
        let readable_anyway = std::fs::read_dir(&locked).is_ok();
        let result = scan_folder(&root);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).expect("restore");
        if readable_anyway {
            return;
        }

        let err = result.expect_err("unreadable subfolder");
        assert!(matches!(&err, AppError::Validation(m) if m.contains("\u{201c}sub\u{201d}")), "{err:?}");
    }
}
```

Add `pub(crate) mod folder_scan;` to `src-tauri/src/shares/mod.rs`.

Run (red): with the three function bodies replaced by `todo!()`,
`cd src-tauri && cargo test --lib shares::folder_scan`. Expected: 8 tests panic with
`not yet implemented`.
Run (green): with the code above in place, run the same command. Expected:
`test result: ok. 8 passed` on macOS (7 on non-unix).

`scan_folder` has no production caller until Task 3. Do not add `#[allow(dead_code)]`;
commit 2b together with Task 3's first green step instead if clippy flags it. Check:
`cargo clippy --all-targets -- -D warnings`.

**Step 5: Commit** (2a and 2b as two commits)

```
Share one entry filter between tree uploads

The drive folder upload and the coming outside-folder share must upload
the same file set the engine syncs. Extracting the hidden-name, symlink
and non-UTF-8 rule into pathops::visible_children keeps them from
drifting; a symlink case now pins the rule the walk relied on implicitly.
```

```
Scan an outside folder into uploaded-copy entries

Pure walk for the Finder outside-folder share: reuses the drive-upload
skip rules, keeps empty subfolders so recipients see them, and refuses
an empty folder, more than 50,000 entries, a file over 5 GB or an
unreadable subfolder before any byte is uploaded.
```

---

### Task 3: `share_outside_folder`, the Rust funnel

**Files:**
- Create: `src-tauri/src/shares/outside_folder.rs`
- Modify: `src-tauri/src/shares/mod.rs` (`pub mod outside_folder;`)
- Modify: `src-tauri/src/shares/commands.rs:178-192` (make `ShareChoice::password` and
  `ShareChoice::into_password` `pub(crate)`)
- Test: `src-tauri/tests/shares_server_mock.rs` (the success case is written first, red)

**Step 1: Write the success-path mock test first.** Add the upload mock scaffolding and
`outside_folder_share_uploads_every_file_then_seals` from Task 6 (sections 6a and 6b) now.
Run it:
`cd src-tauri && cargo test --test shares_server_mock outside_folder_share_uploads_every_file_then_seals`
Expected: compile error, because `unresolved import tauri_project_lib::shares::outside_folder`.

**Step 2: Create the module.**

```rust
//! Share a folder that lives outside every synced drive as a link.
//!
//! An in-drive folder link reads the drive's server-side records; an
//! outside folder has none, so its files are uploaded as a copy under the
//! link's own key (hcfs-client `create_upload_folder_share`). The copy never
//! enters a drive and never shows in the user's Drive, and the server
//! deletes it when the link expires or is revoked. Recipients and the owner
//! listing treat the result like any other folder link.
//!
//! EVERY gate lives in [`share_outside_folder`], not in its caller. That is
//! the lesson `create_folder_share_inner` records: the Finder dispatcher
//! calls the funnel directly, and a guard one level up would not cover it.

use std::path::Path;

use hcfs_client::client::folder_share::{FolderShareError, UploadFolderShareOptions};
use hcfs_client::client::share::{ShareKeystore, ShareProgressFn, ShareTtl};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::app_state::AppState;
use crate::billing::eligibility::{InsufficientCreditsAction, require_eligible};
use crate::error::{AppError, Result};
use crate::shares::SqliteShareKeystore;
use crate::shares::capabilities::fetch_capabilities;
use crate::shares::client::build_account_client;
use crate::shares::commands::{ShareChoice, ShareLink, console_base_url};
use crate::shares::folder_scan::{FolderScan, scan_folder};

/// Refusal on a server without uploaded-copy folder links. The mock-server
/// suite asserts it verbatim.
pub const UPLOAD_FOLDER_SHARES_UNAVAILABLE: &str =
    "Sharing folders from outside a Hippius drive isn't available yet.";

/// What a cancelled Finder share reports, worded like every other Finder
/// share's cancel.
pub const SHARE_CANCELLED: &str = "Share cancelled.";

/// One outside-folder share, bundled so the entry point stays within five
/// parameters.
pub struct OutsideFolderShare<'a> {
    /// The clicked folder, canonical from Finder.
    pub folder: &'a Path,
    pub ttl: ShareTtl,
    pub choice: ShareChoice,
    /// Encrypt → upload → finalize, summed across files by hcfs-client.
    pub progress: Option<ShareProgressFn>,
    /// The modal's Cancel. Passed INTO the upload, never raced against it:
    /// the client has to get to send the abort that tears down the
    /// half-built link on the server, and a dropped future sends nothing.
    pub cancel: CancellationToken,
}

/// Upload `request.folder` as a copy and return its folder link.
///
/// The order is the point. The capability probe comes first, so an older
/// server refuses before the disk is walked. The scan comes before the gate,
/// because the gate needs the real bytes. The gate comes before any upload
/// request, so an account over its plan uploads nothing.
///
/// # Errors
///
/// [`AppError::Validation`] for the capability refusal, every scan refusal,
/// a file that changed mid-upload, and a cancel;
/// `NotReady(StorageLimitReached)` from the quota gate; [`AppError::Hcfs`]
/// for transport and server failures.
pub async fn share_outside_folder(state: &AppState, account_id: &str, request: OutsideFolderShare<'_>) -> Result<ShareLink> {
    require_upload_folder_shares_supported(state, account_id).await?;
    let scan = scan_off_main_thread(request.folder).await?;
    // The server bills the copy against the Drive quota, so the gate asks
    // about the bytes the copy will hold, same as a file share.
    require_eligible(state, account_id, InsufficientCreditsAction::Sharing, scan.total_bytes).await?;

    let display_name = folder_display_name(request.folder)?;
    // One line per share, never per file: the support bundle caps each log.
    info!(
        folder = %request.folder.display(),
        file_count = scan.file_count,
        entry_count = scan.entries.len(),
        total_bytes = scan.total_bytes,
        "Creating uploaded-copy folder share"
    );

    let pool = state.pool()?;
    let client = build_account_client(pool, account_id).await?;
    let keystore = SqliteShareKeystore::new(pool.clone());
    let console_base = console_base_url();
    let options = UploadFolderShareOptions {
        display_name: &display_name,
        ttl: request.ttl,
        password: request.choice.password(),
        console_base_url: &console_base,
    };
    let created = client
        .create_upload_folder_share(scan.entries, options, &keystore, request.progress, request.cancel)
        .await
        .map_err(|e| {
            warn!(error = %e, "create_upload_folder_share failed");
            map_upload_folder_share_error(e)
        })?;

    if let Ok(Some(secret)) = keystore.get(&created.share_token) {
        super::owner_wrap::push_folder_for_account(state, account_id, &[(created.share_token.clone(), secret)]).await;
    }

    Ok(ShareLink {
        share_token: created.share_token,
        share_url: created.share_url,
        expires_at: created.expires_at.map(|e| e.to_rfc3339()),
        password: request.choice.into_password(),
    })
}

/// Capability gate. It is this path's own authority: the Finder menu shows
/// on every folder, so nothing upstream filtered an older server out.
async fn require_upload_folder_shares_supported(state: &AppState, account_id: &str) -> Result<()> {
    let caps = fetch_capabilities(state, account_id).await?;
    if !caps.upload_folder_shares {
        return Err(AppError::Validation(UPLOAD_FOLDER_SHARES_UNAVAILABLE.into()));
    }
    Ok(())
}

/// The scan is up to 50,000 stats, so it runs on the blocking pool and never
/// on the async worker or the main thread.
async fn scan_off_main_thread(folder: &Path) -> Result<FolderScan> {
    let folder = folder.to_path_buf();
    tokio::task::spawn_blocking(move || scan_folder(&folder))
        .await
        .map_err(|e| AppError::Other(format!("Could not read that folder: {e}")))?
}

/// The recipient page's title: the folder's own name.
fn folder_display_name(folder: &Path) -> Result<String> {
    folder
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Validation("This folder has no name to share it under.".into()))
}

/// Map the upload's failures onto the app taxonomy. The two cases a person
/// can act on stay `Validation` so the modal shows them verbatim. A changed
/// file is named, because "something changed" with 50,000 candidates is no
/// help.
fn map_upload_folder_share_error(e: FolderShareError) -> AppError {
    match e {
        FolderShareError::SourceChanged { relative_path } => AppError::Validation(format!(
            "\u{201c}{relative_path}\u{201d} changed while the folder was being shared, so the \
             link was cancelled. If something is still copying into the folder, wait for it to \
             finish, then share again."
        )),
        FolderShareError::Cancelled => AppError::Validation(SHARE_CANCELLED.into()),
        other => AppError::Hcfs(format!("create_upload_folder_share: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_changed_file_is_named_and_a_cancel_reads_as_cancelled() {
        let changed = map_upload_folder_share_error(FolderShareError::SourceChanged {
            relative_path: "photos/IMG_1.heic".into(),
        });
        assert!(
            matches!(&changed, AppError::Validation(m) if m.contains("\u{201c}photos/IMG_1.heic\u{201d}")),
            "{changed:?}"
        );

        let cancelled = map_upload_folder_share_error(FolderShareError::Cancelled);
        assert!(matches!(&cancelled, AppError::Validation(m) if m == SHARE_CANCELLED), "{cancelled:?}");

        let other = map_upload_folder_share_error(FolderShareError::NotFound);
        assert!(matches!(other, AppError::Hcfs(_)), "{other:?}");
    }

    #[test]
    fn the_display_name_is_the_folder_s_own_name() {
        assert_eq!(folder_display_name(Path::new("/Users/me/Downloads/T2-KD")).unwrap(), "T2-KD");
        assert!(folder_display_name(Path::new("/")).is_err());
    }

    /// Body of `share_outside_folder`, from its signature to its closing brace.
    fn funnel_body() -> String {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/shares/outside_folder.rs"))
            .expect("read outside_folder.rs");
        let start = src.find("pub async fn share_outside_folder(").expect("funnel exists");
        let end = src[start..].find("\n}\n").expect("funnel closes") + start;
        src[start..end].to_string()
    }

    /// The gate order is the security property: capability, then the real
    /// bytes, then the quota gate, then the upload, then the owner wrap.
    /// Behaviour is covered in `tests/shares_server_mock.rs`; this pin keeps
    /// a refactor from reordering the steps while those tests still pass.
    #[test]
    fn the_funnel_gates_before_it_uploads() {
        let body = funnel_body();
        let at = |needle: &str| body.find(needle).unwrap_or_else(|| panic!("funnel must call {needle}"));
        let order = [
            at("require_upload_folder_shares_supported("),
            at("scan_off_main_thread("),
            at("require_eligible(state, account_id, InsufficientCreditsAction::Sharing, scan.total_bytes)"),
            at(".create_upload_folder_share("),
            at("push_folder_for_account("),
        ];
        assert!(order.windows(2).all(|w| w[0] < w[1]), "funnel steps out of order: {order:?}");
    }
}
```

Add `pub mod outside_folder;` to `shares/mod.rs`. In `commands.rs`, change
`fn password(&self)` → `pub(crate) fn password(&self)` and
`fn into_password(self)` → `pub(crate) fn into_password(self)`.

**Step 3: Run.**
`cd src-tauri && cargo test --lib shares::outside_folder && cargo test --test shares_server_mock outside_folder_share_uploads_every_file_then_seals`
Expected: 3 unit tests pass, and the mock success test passes.

To check the order pin can fail, swap the `require_eligible` and `scan_off_main_thread`
lines: `the_funnel_gates_before_it_uploads` must fail. Then revert.

Run: `cargo clippy --all-targets -- -D warnings`. Expected: clean. (The function is
called from the integration tests and, after Task 4, from the Finder dispatcher.)

**Step 4: Commit**

```
Add the Rust funnel for sharing a folder outside any drive

Probes upload_folder_shares, scans off the main thread, gates on the
copy's real bytes through /can_upload, then uploads under the link's own
key and pushes the owner wrap so other devices can copy the link. The
order is pinned so no refactor can upload before the gates.
```

---

### Task 4: Route Finder outside folders to the funnel; chooser shows size and "copy"

**Files:**
- Modify: `src-tauri/src/finder_bridge/dispatch.rs` (doc comment lines 12–17; struct
  `FinderShareChoosing` 59–87; `source_stat` doc 89–94; `handle_share` 121–154;
  `mint_confirmed` 168–184; `share_for_path` 208–253; tests 300–339)
- Modify: `src-tauri/src/finder_bridge/commands.rs:51-70` (drop the `select!` and pass
  the token)
- Modify: `src-tauri/src/app_state.rs:272-279` (the doc comment on `finder_share_cancels`)
- Modify: `src-tauri/tests/folder_share_wiring.rs` (add a pin)
- Modify: `app/lib/tauri/shares.ts` (`FinderShareChoosing`, ~line 99)
- Modify: `app/lib/global-atoms/sharesAtoms.ts:129-137`
- Modify: `app/(pages)/FinderShareListener.tsx`
- Modify: `app/components/page-sections/drive/ShareFileModal.tsx` (~lines 141–151, 343–350,
  `ChoosingBody` 411–534, new notice after line 590)
- Test: `app/(pages)/__tests__/FinderShareListener.test.tsx`,
  `app/components/page-sections/drive/__tests__/ShareFileModal.test.tsx`

#### 4a: Rust

**Step 1: Red: the routing pin and the wire shape.** Append to
`tests/folder_share_wiring.rs`:

```rust
/// A Finder share of a folder OUTSIDE every drive uploads a copy through
/// `share_outside_folder`, and is the ONE branch whose cancel is
/// cooperative: its token goes into the upload so hcfs-client can abort the
/// half-built link on the server. Every other branch is dropped on cancel
/// by `until_cancelled`, which is right for them and wrong for this one,
/// because a dropped future sends no abort.
#[test]
fn the_finder_outside_folder_branch_uploads_a_copy_with_cooperative_cancel() {
    let source = include_str!("../src/finder_bridge/dispatch.rs");
    let body = fn_body(source, "async fn share_for_path");
    assert!(
        body.contains("share_outside_folder(state, &account_id, request)"),
        "share_for_path must send an outside folder to share_outside_folder"
    );
    let outside_line = body
        .lines()
        .find(|l| l.contains("share_outside_folder("))
        .expect("the outside-folder call");
    assert!(
        !outside_line.contains("until_cancelled"),
        "the outside-folder upload must take the token, not be raced against it"
    );
    assert_eq!(
        body.matches("until_cancelled(&cancel,").count(),
        3,
        "the in-drive folder, in-drive file and outside file mints stay drop-on-cancel"
    );
}
```

In `dispatch.rs` tests, update `finder_share_choosing_wire_shape`: construct with
`is_folder_copy: true`, add `"isFolderCopy"` to the expected set, and add
`assert_eq!(json["isFolderCopy"], true);`. Add `is_folder_copy: false` to
`finder_share_choosing_carries_nulls_when_stat_is_unavailable`.

Run: `cd src-tauri && cargo test --test folder_share_wiring && cargo test --lib finder_bridge::dispatch`
Expected: the wiring pin fails, and the dispatch tests fail to compile on `is_folder_copy`.

**Step 2: Payload + chooser facts.** In `FinderShareChoosing`:
- Update the `size_bytes` doc: "`None` for an in-drive folder (its link moves no bytes),
  for an outside folder whose size could not be measured within
  `FOLDER_SIZE_BUDGET`, and for an unreadable stat."
- Add the field:

```rust
    /// The clicked path is a folder outside every drive, so confirming
    /// UPLOADS A COPY of it (removed when the link ends) rather than minting
    /// a live link. Rust decides this; the chooser only says so, because the
    /// live-link notice would be false for a copy.
    is_folder_copy: bool,
```

Add below `source_stat` (leave `source_stat` unchanged, but extend its doc: "A folder's
size comes from [`outside_folder_size`], and only for an outside folder."):

```rust
/// How long the chooser waits for an outside folder's size before opening
/// without one. The modal must appear promptly after a right-click.
const FOLDER_SIZE_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);

/// What the chooser shows about the clicked path.
struct ChooserFacts {
    size_bytes: Option<u64>,
    modified_secs_ago: Option<u64>,
    is_folder_copy: bool,
}

/// Gather the chooser's facts. Only an outside folder is sized: it is the
/// only folder share that uploads (and bills) bytes.
async fn chooser_facts(state: &AppState, clicked: &Path) -> ChooserFacts {
    let (size_bytes, modified_secs_ago) = source_stat(clicked);
    let is_folder_copy = clicked.is_dir() && is_outside_every_drive(state, clicked).await;
    let size_bytes = if is_folder_copy {
        outside_folder_size(clicked).await
    } else {
        size_bytes
    };
    ChooserFacts {
        size_bytes,
        modified_secs_ago,
        is_folder_copy,
    }
}

/// Whether `clicked` resolves to no registered drive. Any failure reads as
/// "inside": the chooser then shows what it showed before, and the confirm
/// path resolves the target again with real errors.
async fn is_outside_every_drive(state: &AppState, clicked: &Path) -> bool {
    let Ok(account_id) = state.current_account_id() else {
        return false;
    };
    let Ok(pool) = state.pool() else {
        return false;
    };
    match crate::sync::paths::list_drive_roots(pool, &account_id).await {
        Ok(roots) => matches!(resolve_share_target(clicked, &roots), ShareTarget::Outside),
        Err(error) => {
            warn!(%error, "finder bridge: could not list drive roots for the chooser");
            false
        }
    }
}

/// Bytes an outside folder's copy would upload. It is the same scan the
/// share runs, so the number shown is the number billed.
///
/// Bounded twice: the scan stops at the link's entry cap, and the chooser
/// stops waiting after [`FOLDER_SIZE_BUDGET`] (a scan still running then
/// finishes on the blocking pool, still capped). A refusal (empty, too many
/// files) reads as "no size" here; the confirm reports it with its message.
async fn outside_folder_size(folder: &Path) -> Option<u64> {
    let folder = folder.to_path_buf();
    let scan = tokio::task::spawn_blocking(move || crate::shares::folder_scan::scan_folder(&folder));
    match tokio::time::timeout(FOLDER_SIZE_BUDGET, scan).await {
        Ok(Ok(Ok(scan))) => Some(scan.total_bytes),
        _ => None,
    }
}
```

**Step 3: `handle_share`.** Replace lines 130–153 with:

```rust
    // Gathered once, before the chooser opens, so it can show what it is
    // about to share. The size is logged too: the 2026-08-31 truncated
    // shares were diagnosed from exactly this number.
    let facts = chooser_facts(app.state::<AppState>().inner(), &clicked).await;
    info!(
        request_id = %id,
        path = %clicked.display(),
        size_bytes = ?facts.size_bytes,
        modified_secs_ago = ?facts.modified_secs_ago,
        is_folder_copy = facts.is_folder_copy,
        "finder bridge: share requested; opening chooser",
    );
    // Target the main window only — `FinderShareListener` runs there, and the
    // borderless `tray-panel` webview must never drive the share modal.
    let _ = app.emit_to(
        "main",
        "finder:share-choosing",
        &FinderShareChoosing {
            id,
            name,
            size_bytes: facts.size_bytes,
            modified_secs_ago: facts.modified_secs_ago,
            is_folder_copy: facts.is_folder_copy,
        },
    );
```

Place `chooser_facts` and its helpers after `share_for_path`, so that
`handle_defers_mint_and_emits_choosing` still bounds `handle_share`'s body at the next
`async fn` (that next fn is now `mint_confirmed`, and the bound still holds).

**Step 4: The mint path.** Add near the top (after `PendingFinderShare`):

```rust
/// What the user confirmed in the chooser plus the handles that run the
/// mint: the progress sink and the modal's cancel token. Bundled so the mint
/// path stays within five parameters.
pub(super) struct FinderMint {
    pub ttl: ShareTtl,
    pub choice: ShareChoice,
    pub progress: Option<ShareProgressFn>,
    pub cancel: CancellationToken,
}
```

`mint_confirmed` becomes:

```rust
pub(super) async fn mint_confirmed(state: &AppState, clicked: &Path, mint: FinderMint) -> Result<ShareLink> {
    let is_private = matches!(mint.choice, ShareChoice::Private { .. });
    let link = share_for_path(state, clicked, mint).await?;
    info!(
        share_token = %link.share_token,
        path = %clicked.display(),
        is_private,
        "finder bridge: share link created",
    );
    Ok(link)
}
```

`share_for_path` becomes the following. Update the doc to: "Mint a share for `clicked` by
its shape: an in-drive file or folder, an outside file, or an outside folder (uploaded as
a copy)."

```rust
async fn share_for_path(state: &AppState, clicked: &Path, mint: FinderMint) -> Result<ShareLink> {
    let account_id = state.current_account_id()?;

    // Resolve file-vs-dir BEFORE the in-drive check so an in-drive folder
    // takes the mint path rather than `share_synced_file`, which rejects
    // directories.
    let metadata = tokio::fs::metadata(clicked).await?;
    let roots = crate::sync::paths::list_drive_roots(state.pool()?, &account_id).await?;
    let FinderMint {
        ttl,
        choice,
        progress,
        cancel,
    } = mint;

    if metadata.is_dir() {
        return match resolve_share_target(clicked, &roots) {
            // A live browsable link: one metadata POST, nothing to stream.
            ShareTarget::InDrive { label, relative_path } => {
                let mint = crate::shares::commands::create_folder_share_inner(state, &account_id, &label, &relative_path, ttl, choice);
                until_cancelled(&cancel, mint).await
            }
            // No drive a recipient could browse, so the files are uploaded
            // as a copy under the link's own key. The token goes INTO the
            // upload so the client can abort the half-built link on the
            // server; racing it here would drop the future before that
            // abort is sent.
            ShareTarget::Outside => {
                let request = OutsideFolderShare {
                    folder: clicked,
                    ttl,
                    choice,
                    progress,
                    cancel,
                };
                crate::shares::outside_folder::share_outside_folder(state, &account_id, request).await
            }
        };
    }

    match resolve_share_target(clicked, &roots) {
        ShareTarget::InDrive { label, relative_path } => {
            let mint = crate::shares::commands::share_synced_file(state, &account_id, &label, &relative_path, ttl, choice, progress);
            until_cancelled(&cancel, mint).await
        }
        ShareTarget::Outside => {
            let mint = crate::shares::commands::share_external_file(state, &account_id, clicked, ttl, choice, progress);
            until_cancelled(&cancel, mint).await
        }
    }
}

/// Run a mint that has no cancel hook of its own, dropping it when the
/// modal's Cancel fires. Dropping aborts its in-flight request; whatever a
/// dropped file upload leaves behind is collected by the server's share
/// reaper.
async fn until_cancelled(cancel: &CancellationToken, mint: impl std::future::Future<Output = Result<ShareLink>>) -> Result<ShareLink> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(AppError::Validation(SHARE_CANCELLED.into())),
        minted = mint => minted,
    }
}
```

Imports:
- Add `use tokio_util::sync::CancellationToken;`.
- Add `use crate::shares::outside_folder::{OutsideFolderShare, SHARE_CANCELLED};`.
- Keep `ShareProgressFn, ShareTtl`.

Then make two documentation edits:
- **Module doc lines 12–17.** Replace "(one metadata POST — an outside folder has no drive
  to browse and is refused)" with "(one metadata POST), and an outside folder uploads a
  copy of its files under the link's own key (`shares::outside_folder`)."
- **Line 239 refusal.** The block containing "Only folders inside a synced Hippius
  drive…" is gone.

**Step 5: `commands.rs` confirm.** Replace lines 55–70 (the comment and the `select!`) with:

```rust
        // Register a cancel handle and hand it to the mint. Most mints are
        // dropped when it fires (`dispatch::until_cancelled`); an outside
        // folder's upload takes it cooperatively so it can abort the
        // half-built link on the server. The guard removes the handle when
        // this scope ends — on success, error, cancel, OR the command future
        // being dropped (window closed mid-upload).
        let cancel = state.register_finder_mint(&request_id);
        let _guard = FinderMintGuard {
            state: state.inner(),
            request_id: &request_id,
        };
        let mint = crate::finder_bridge::dispatch::FinderMint {
            ttl,
            choice,
            progress: Some(progress),
            cancel,
        };
        crate::finder_bridge::dispatch::mint_confirmed(&state, &pending.path, mint).await
```

In `app_state.rs` (lines 276–279), replace "runs the mint inside a `tokio::select!` against
it, so `cancel_finder_share` signalling the token drops the mint future and aborts the
in-flight upload" with "hands it to the mint, so `cancel_finder_share` either drops the mint
(single-request shares) or tells an outside-folder upload to abort itself on the server".

**Step 6: Unit tests for the size probe.** Add to `dispatch.rs` tests:

```rust
    /// The chooser's number for an outside folder is the scan's total — the
    /// bytes the copy uploads and the gate bills — not a directory `len()`.
    #[tokio::test]
    async fn an_outside_folder_is_sized_by_the_share_scan() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("T2-KD");
        std::fs::create_dir_all(root.join("sub")).expect("dirs");
        std::fs::write(root.join("a.txt"), vec![0u8; 2_048]).expect("a");
        std::fs::write(root.join("sub/b.txt"), vec![0u8; 1_000]).expect("b");
        std::fs::write(root.join(".DS_Store"), vec![0u8; 9_999]).expect("hidden, not billed");

        assert_eq!(outside_folder_size(&root).await, Some(3_048));
    }

    /// A folder the share would refuse shows no size rather than "0 B". The
    /// confirm, not the chooser, explains the refusal.
    #[tokio::test]
    async fn a_folder_the_share_would_refuse_has_no_size() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(outside_folder_size(dir.path()).await, None);
    }
```

Run: `cd src-tauri && cargo test --lib finder_bridge && cargo test --test folder_share_wiring`
Expected: all pass. The existing `handle_defers_mint_and_emits_choosing` still passes.

Run: `cargo clippy --all-targets -- -D warnings && cargo fmt --all -- --check`
Expected: clean.

#### 4b: Frontend (render only)

**Step 7: Red.** In `FinderShareListener.test.tsx`:
- Add `isFolderCopy: true` to the first payload and to the expected atom.
- Change the legacy-payload test to expect `isFolderCopy: false`.

In `ShareFileModal.test.tsx`, add `isFolderCopy: false` to `CHOOSING` and add:

```tsx
  it("tells the user an outside folder is uploaded as a copy, with its size", () => {
    render(
      withFinderState(<ShareFileModal />, {
        ...CHOOSING,
        name: "T2-KD",
        sizeBytes: 6_765_321,
        isFolderCopy: true,
      }),
    );
    expect(screen.getByText(/uploads a copy of this folder/i)).toBeInTheDocument();
    expect(screen.getByText("6.77 MB")).toBeInTheDocument();
    // A copy is NOT a live link — that notice would be false here.
    expect(screen.queryByText(/always shows the current contents/i)).not.toBeInTheDocument();
  });

  it("does not show the copy notice for a file", () => {
    render(withFinderState(<ShareFileModal />, CHOOSING));
    expect(screen.queryByText(/uploads a copy of this folder/i)).not.toBeInTheDocument();
  });
```

Run: `pnpm vitest run "app/(pages)/__tests__/FinderShareListener.test.tsx" app/components/page-sections/drive/__tests__/ShareFileModal.test.tsx`
Expected: these tests fail (type errors and missing text).

**Step 8: Green.**
- **`shares.ts` `FinderShareChoosing`.** Add the field below, and update the `sizeBytes`
  doc to "`null` for an in-drive folder, an outside folder that could not be measured in
  time, or an unreadable stat."

  ```ts
  /**
   * The clicked folder is outside every drive, so confirming uploads a COPY
   * of it (removed when the link ends) instead of minting a live link.
   * Decided in Rust; the chooser only says so.
   */
  isFolderCopy: boolean;
  ```

- **`sharesAtoms.ts` `FinderShareState`.** Add the same field:
  `/** Outside folder: the share uploads a copy. */ isFolderCopy: boolean;`.
- **`FinderShareListener.tsx`.** Destructure `isFolderCopy` and set
  `isFolderCopy: isFolderCopy ?? false,`, commented "an older backend never uploads a
  folder".
- **`ShareFileModal.tsx`.** Make the following changes:

  - After `sourceModifiedSecsAgo`, add:

    ```tsx
      // Rust decided whether this Finder folder is uploaded as a copy; the
      // chooser must not show the live-link notice for one.
      const isFolderCopy =
        finderShare?.kind === "choosing" && finderShare.isFolderCopy;
    ```

  - Pass `isFolderCopy={isFolderCopy}` to `<ChoosingBody>`.
  - Add `isFolderCopy` to `ChoosingBody`'s props with the type comment
    `/** The share uploads a copy of an outside folder. */ isFolderCopy: boolean;`.
  - Under `{isFolder && <FolderShareNotice />}`, add `{isFolderCopy && <FolderCopyNotice />}`.
  - Add after `FolderShareNotice`:

    ```tsx
    /**
     * What the user agrees to when they share a folder from outside their
     * drives: an uploaded COPY, frozen at share time and deleted with the link.
     * The opposite promise to `FolderShareNotice`, so the two never render
     * together.
     */
    function FolderCopyNotice() {
      return (
        <p className="mt-3 text-xs text-grey-50 dark:text-grey-dark-600">
          Hippius uploads a copy of this folder for the link. Changes you make to
          the folder later won&apos;t reach it, and the copy is removed when the
          link expires or you revoke it.
        </p>
      );
    }
    ```

  - The existing comment at lines 141–142 ("A folder reports no size in either flow")
    becomes: "An in-drive folder reports no size: nothing is uploaded when its live link is
    minted. A Finder folder outside every drive does carry one, because its copy is
    uploaded."

Run: `pnpm vitest run "app/(pages)/__tests__/FinderShareListener.test.tsx" app/components/page-sections/drive/__tests__/ShareFileModal.test.tsx && pnpm typecheck && pnpm lint`
Expected: all green.

**Step 9: Commit** (two commits: Rust, then FE)

```
Share a Finder folder outside any drive as an uploaded copy

The dispatcher refused these folders since live folder links replaced
the zip upload. It now routes them to share_outside_folder and hands
that upload the cancel token instead of dropping it on Cancel, so the
client can abort the half-built link on the server. The chooser event
carries the copy's size and an isFolderCopy flag.
```

```
Say in the share chooser when a folder is uploaded as a copy

The live-link notice would be false for an outside folder: its link is
a snapshot that is deleted with it. The chooser now shows the copy's
size and says so, from the flag Rust sets on finder:share-choosing.
```

---

### Task 5: Listing rows carry their source; the shares page labels uploaded copies

**Files:**
- Modify: `src-tauri/src/shares/commands.rs` (`FolderShareSummary` ~1301;
  `resolve_folder_share_rows` ~1344; imports line 26; tests ~2385–2445)
- Modify: `app/lib/tauri/shares.ts` (`FolderShareSummary`, ~line 286)
- Modify: `app/(pages)/shares/shareRowDisplay.ts` (`folderSharePathLabel`)
- Modify: `app/(pages)/shares/page.tsx:754`
- Modify: `app/lib/hooks/useFolderShares.ts` (`buildFolderShareIndex`)
- Test: `app/(pages)/shares/__tests__/shareRowDisplay.test.ts`,
  `app/lib/hooks/__tests__/useFolderShares.test.ts`, plus every `FolderShareSummary`
  fixture that `pnpm typecheck` flags

**Step 1: Rust, red.** In the `commands.rs` tests:
- Add `source: FolderShareOrigin::Drive,` to the `folder_share_summary_pins_wire_shape`
  literal and `"source"` to its expected keys.
- Add:

```rust
    /// An uploaded-copy row reaches the FE as `"uploadedCopy"`: Rust picks the
    /// key the shares page labels and the badge index skips. A drive row stays
    /// `"drive"`.
    #[test]
    fn listing_rows_carry_their_source_to_the_fe() {
        let mut upload = mk_folder_row(&"cd".repeat(32), "");
        upload.source = FolderShareSource::Upload;
        upload.folder_hash = String::new();
        let rows = resolve_folder_share_rows(
            vec![mk_folder_row(&"ab".repeat(32), "photos"), upload],
            &HashMap::new(),
            "https://x.io",
        );

        let json = serde_json::to_value(&rows).expect("serialize");
        assert_eq!(json[0]["source"], "drive");
        assert_eq!(json[1]["source"], "uploadedCopy");
    }
```

Run: `cd src-tauri && cargo test --lib shares::commands::tests::listing_rows`
Expected: compile error on `FolderShareOrigin`.

**Step 2: Rust, green.** Add `FolderShareSource` to the line-26 import, and add above
`FolderShareSummary`:

```rust
/// Where a folder link's contents come from, as the shares page labels it.
///
/// Desktop-owned rather than hcfs-client's `FolderShareSource`, so the FE
/// reads a key Rust chose and an upstream rename fails the build here
/// instead of silently mislabelling rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderShareOrigin {
    /// A live link onto a drive folder.
    Drive,
    /// A copy uploaded from a folder outside every drive. It has no drive
    /// identity (`folder_hash` and `path_prefix` are `""`), so it never
    /// badges a drive folder.
    UploadedCopy,
}

impl From<FolderShareSource> for FolderShareOrigin {
    fn from(source: FolderShareSource) -> Self {
        match source {
            FolderShareSource::Drive => Self::Drive,
            FolderShareSource::Upload => Self::UploadedCopy,
        }
    }
}
```

Add a field at the end of `FolderShareSummary`, `/// Drive folder or uploaded copy.` followed
by `pub source: FolderShareOrigin,`. In `resolve_folder_share_rows`, add
`source: row.source.into(),`. If PART 1 made `folder_hash`/`path_prefix` `Option`, also map
them with `.unwrap_or_default()` here (Contract deviation 8).

Run: `cd src-tauri && cargo test --lib shares::commands`
Expected: all pass.

**Step 3: FE, red.**
- In both fixtures (`shareRowDisplay.test.ts` `folderRow`, `useFolderShares.test.ts` `row`),
  add `source: "drive",`.
- Replace the `folderSharePathLabel` describe with:

```ts
describe("folderSharePathLabel", () => {
  it("renders the whole-drive idiom for an empty prefix", () => {
    expect(folderSharePathLabel(folderRow({ pathPrefix: "" }))).toBe("Whole drive");
  });

  it("passes a real prefix through", () => {
    expect(folderSharePathLabel(folderRow({ pathPrefix: "Trips/Photos" }))).toBe("Trips/Photos");
  });

  // An uploaded copy also has an empty prefix; "Whole drive" would be a lie.
  it("labels an uploaded copy as one", () => {
    expect(
      folderSharePathLabel(folderRow({ source: "uploadedCopy", pathPrefix: "", folderHash: "" })),
    ).toBe("Uploaded copy");
  });
});
```

- In `useFolderShares.test.ts`, add:

```ts
  it("never indexes an uploaded copy — it is no drive folder", () => {
    const index = buildFolderShareIndex([
      row({ source: "uploadedCopy", folderHash: "", pathPrefix: "" }),
    ]);
    expect(index.size).toBe(0);
  });
```

Run: `pnpm vitest run "app/(pages)/shares/__tests__/shareRowDisplay.test.ts" app/lib/hooks/__tests__/useFolderShares.test.ts`
Expected: these tests fail.

**Step 4: FE, green.**
- **`shares.ts`.** Add:

```ts
/** Where a folder link's contents come from. Rust chooses the key. */
export type FolderShareOrigin = "drive" | "uploadedCopy";
```

  Then add to `FolderShareSummary`:

```ts
  /**
   * `"uploadedCopy"` for a folder shared from outside every drive: its files
   * were uploaded for the link, so it has no drive identity (`folderHash`
   * and `pathPrefix` are `""`) and never badges a drive folder.
   */
  source: FolderShareOrigin;
```

- **`shareRowDisplay.ts`.**

```ts
export const UPLOADED_COPY_LABEL = "Uploaded copy";

/**
 * The line under a folder row's name. An uploaded copy says so; a drive
 * link shows its subtree, `""` being the whole drive (console idiom).
 */
export function folderSharePathLabel(
  row: Pick<FolderShareSummary, "pathPrefix" | "source">,
): string {
  if (row.source === "uploadedCopy") return UPLOADED_COPY_LABEL;
  return row.pathPrefix === "" ? "Whole drive" : row.pathPrefix;
}
```

- **`page.tsx:754`.** `const pathLabel = folderSharePathLabel(row);`.
- **`useFolderShares.ts` `buildFolderShareIndex`.** Before the revoked check, add:

```ts
    // An uploaded copy has no drive identity — its "" pair must never be
    // matched against a drive folder.
    if (row.source === "uploadedCopy") continue;
```

  Add a sentence to the module header: "Uploaded copies (folders shared from outside a
  drive) are skipped: they belong to no drive folder."

- **Fixtures.** Run `pnpm typecheck`, add `source: "drive"` to every remaining
  `FolderShareSummary` fixture it flags, then run it again.

Run: `pnpm vitest run "app/(pages)/shares" app/lib/hooks && pnpm typecheck && pnpm lint && pnpm test`
Expected: all green (Node 22).

**Step 5: Commit** (Rust and FE together; one wire change)

```
Label folder links uploaded from outside a drive

Listing rows now carry a source Rust maps from the server's, so the
shares page reads "Uploaded copy" instead of "Whole drive" for a link
with no drive path, and the folder badge index skips those rows.
```

---

### Task 6: Mock-server suite for the uploaded-copy share

**File:** `src-tauri/tests/shares_server_mock.rs`. Extend the module doc's "Covers" list
with a bullet: "The uploaded-copy (outside-folder) share: open → files → chunks → seal,
ciphertext under the fragment key, cancel → abort, the quota gate before any upload, the
capability refusal, a mid-upload change naming the file, and the listing's `source`."

#### 6a: Scaffolding

Imports to add:

```rust
use axum::routing::put;
use hcfs_client::client::share::{SharePhase, ShareProgress};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri_project_lib::error::NotReadyKind;
use tauri_project_lib::shares::outside_folder::{
    OutsideFolderShare, SHARE_CANCELLED, UPLOAD_FOLDER_SHARES_UNAVAILABLE, share_outside_folder,
};
use tokio_util::sync::CancellationToken;
```

Scaffolding:

```rust
// ── Uploaded-copy (outside-folder) shares ──────────────────────────────────

const CAPS_UPLOADS_ON: &str = r#"{"shares":true,"folder_shares":true,"upload_folder_shares":true}"#;

/// What the upload routes saw, in arrival order.
#[derive(Clone, Default)]
struct UploadRecorded {
    opens: Arc<Mutex<Vec<serde_json::Value>>>,
    files: Arc<Mutex<Vec<serde_json::Value>>>,
    /// `(file_id, chunk index, body)` of every chunk PUT.
    chunks: Arc<Mutex<Vec<(String, u32, Vec<u8>)>>>,
    file_completes: Arc<Mutex<Vec<String>>>,
    seals: Arc<Mutex<u32>>,
    aborts: Arc<Mutex<Vec<String>>>,
    /// `size_bytes` of every `/can_upload` pre-flight.
    can_upload_sizes: Arc<Mutex<Vec<u64>>>,
}

/// Something the user or the filesystem does while the first chunk is in
/// flight.
#[derive(Clone)]
enum OnFirstChunk {
    Nothing,
    /// The modal's Cancel.
    Cancel(CancellationToken),
    /// A still-downloading file grows.
    Grow(std::path::PathBuf),
}

#[derive(Clone)]
struct UploadMock {
    /// Body of `POST /can_upload` (hcfs-server's quota pre-flight).
    can_upload: serde_json::Value,
    on_first_chunk: OnFirstChunk,
    seal_expires_at: Option<&'static str>,
}

impl Default for UploadMock {
    fn default() -> Self {
        Self {
            can_upload: json!({ "result": true, "error": null }),
            on_first_chunk: OnFirstChunk::Nothing,
            seal_expires_at: Some("2026-10-09T00:00:00+00:00"),
        }
    }
}

/// Open, seal, abort and the quota pre-flight.
fn upload_lifecycle_routes(mock: &UploadMock, rec: &UploadRecorded) -> Router {
    let (opens, seals, aborts, sizes) = (rec.opens.clone(), rec.seals.clone(), rec.aborts.clone(), rec.can_upload_sizes.clone());
    let (verdict, expires) = (mock.can_upload.clone(), mock.seal_expires_at);
    Router::new()
        .route(
            "/can_upload",
            post(move |Json(body): Json<serde_json::Value>| async move {
                sizes.lock().unwrap().push(body["size_bytes"].as_u64().expect("size_bytes"));
                Json(verdict).into_response()
            }),
        )
        .route(
            "/v1/folder-shares/uploads",
            post(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
                if let Some(resp) = bearer_rejection(&headers) {
                    return resp;
                }
                let token_hash = body["token_hash"].clone();
                opens.lock().unwrap().push(body);
                (StatusCode::CREATED, Json(json!({ "token_hash": token_hash }))).into_response()
            }),
        )
        .route(
            "/v1/folder-shares/uploads/{token_hash}/complete",
            post(move |Path(_): Path<String>| async move {
                *seals.lock().unwrap() += 1;
                Json(json!({ "expires_at": expires })).into_response()
            }),
        )
        .route(
            "/v1/folder-shares/uploads/{token_hash}",
            delete(move |Path(token_hash): Path<String>| async move {
                aborts.lock().unwrap().push(token_hash);
                StatusCode::NO_CONTENT.into_response()
            }),
        )
}

/// Per-file init, chunk and complete.
fn upload_file_routes(mock: &UploadMock, rec: &UploadRecorded) -> Router {
    let (files, chunks, completes) = (rec.files.clone(), rec.chunks.clone(), rec.file_completes.clone());
    let next_id = Arc::new(AtomicU32::new(0));
    let fired = Arc::new(AtomicBool::new(false));
    let hook = mock.on_first_chunk.clone();
    Router::new()
        .route(
            "/v1/folder-shares/uploads/{token_hash}/files",
            post(move |Path(_): Path<String>, Json(body): Json<serde_json::Value>| async move {
                files.lock().unwrap().push(body);
                let id = format!("f{}", next_id.fetch_add(1, Ordering::SeqCst));
                Json(json!({ "file_id": id })).into_response()
            }),
        )
        .route(
            "/v1/folder-shares/uploads/{token_hash}/files/{file_id}/chunks/{n}",
            put(move |Path((_, file_id, n)): Path<(String, String, u32)>, body: axum::body::Bytes| async move {
                chunks.lock().unwrap().push((file_id, n, body.to_vec()));
                if !fired.swap(true, Ordering::SeqCst) {
                    match &hook {
                        OnFirstChunk::Nothing => {}
                        OnFirstChunk::Cancel(token) => token.cancel(),
                        OnFirstChunk::Grow(path) => {
                            use std::io::Write;
                            let mut f = std::fs::OpenOptions::new().append(true).open(path).expect("open to grow");
                            f.write_all(b"more bytes arrived").expect("grow");
                        }
                    }
                }
                StatusCode::NO_CONTENT.into_response()
            }),
        )
        .route(
            "/v1/folder-shares/uploads/{token_hash}/files/{file_id}/complete",
            post(move |Path((_, file_id)): Path<(String, String)>| async move {
                completes.lock().unwrap().push(file_id);
                StatusCode::NO_CONTENT.into_response()
            }),
        )
}

/// A served mock plus a state for `account`, with no drive rows: an outside
/// folder needs none.
async fn upload_harness(account: &str, caps: &str, mock: UploadMock) -> (AppState, UploadRecorded, Recorded, tempfile::TempDir) {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let (recorded, uploads) = (Recorded::default(), UploadRecorded::default());
    let options = MockOptions {
        capabilities: serde_json::from_str(caps).expect("caps json"),
        ..MockOptions::default()
    };
    let router = share_router(options, recorded.clone())
        .merge(upload_lifecycle_routes(&mock, &uploads))
        .merge(upload_file_routes(&mock, &uploads));
    let base = serve(router).await;
    seed_account(&pool, account, &base).await;
    (make_state(pool, account), uploads, recorded, dir)
}

/// `T2-KD/` as Finder would hand it over: two real files (one spanning two
/// 8 MiB chunks), an empty subfolder, and the things the walk must skip.
fn outside_folder() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let root = dir.path().join("T2-KD");
    std::fs::create_dir_all(root.join("sub")).expect("sub");
    std::fs::create_dir_all(root.join("empty")).expect("empty");
    std::fs::write(root.join("a.txt"), b"hello").expect("a");
    std::fs::write(root.join("sub/b.bin"), vec![0x5a; 9 * 1024 * 1024]).expect("b");
    std::fs::write(root.join(".DS_Store"), b"skip").expect("hidden");
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("a.txt"), root.join("alias.txt")).expect("link");
    (dir, root)
}

fn share_request(folder: &std::path::Path, cancel: CancellationToken) -> OutsideFolderShare<'_> {
    OutsideFolderShare {
        folder,
        ttl: ShareTtl::Days7,
        choice: ShareChoice::Public,
        progress: None,
        cancel,
    }
}
```

Route names and shapes follow `contract.md`. If PART 1's `file_id` is numeric, change
`Path<(String, String, u32)>` to use `u64` for it and emit a number from the files route.

#### 6b: Success path (written first in Task 3 Step 1)

```rust
/// The whole upload through the real funnel: one open declaring exactly the
/// visible tree (empty folder kept, hidden file and symlink not), every file
/// initialised, chunked and completed, one seal, and a `#k=` link whose key
/// opens the uploaded ciphertext. The keystore holds that key, so the
/// shares page can rebuild the link.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_folder_share_uploads_every_file_then_seals() {
    let account = "5UploadOkAcct";
    let (state, rec, _, _db) = upload_harness(account, CAPS_UPLOADS_ON, UploadMock::default()).await;
    let (_tree, root) = outside_folder();
    let seen: Arc<Mutex<Vec<ShareProgress>>> = Arc::default();
    let sink = seen.clone();
    let mut request = share_request(&root, CancellationToken::new());
    request.progress = Some(Arc::new(move |p: ShareProgress| sink.lock().unwrap().push(p)));

    let link = share_outside_folder(&state, account, request).await.expect("share");

    let open = rec.opens.lock().unwrap().first().cloned().expect("one open");
    assert_eq!(open["display_name"], "T2-KD");
    assert_eq!(open["file_count"], 2);
    assert_eq!(open["total_bytes"], 5 + 9 * 1024 * 1024);
    assert_eq!(open["dirs"], json!(["empty"]));
    assert_eq!(open["ttl"], "7d");
    assert_eq!(open["token_hash"], folder_share_token_hash(&link.share_token), "open names this link");

    let mut declared: Vec<String> = rec.files.lock().unwrap().iter().map(|f| f["relative_path"].as_str().unwrap().to_owned()).collect();
    declared.sort();
    assert_eq!(declared, vec!["a.txt", "sub/b.bin"], "hidden file and symlink are not uploaded");
    assert_eq!(rec.file_completes.lock().unwrap().len(), 2);
    assert_eq!(*rec.seals.lock().unwrap(), 1);
    assert!(rec.aborts.lock().unwrap().is_empty());

    // Chunk count per file matches what it declared (b.bin spans two).
    for file in rec.files.lock().unwrap().iter() {
        let id_chunks = rec.chunks.lock().unwrap().iter().filter(|(_, _, b)| !b.is_empty()).count();
        assert!(id_chunks >= file["total_chunks"].as_u64().unwrap() as usize);
    }

    // The fragment key opens the ciphertext the server was handed, and the
    // plaintext is nowhere on the wire.
    let (_, key) = link.share_url.split_once("#k=").expect("#k= link");
    let key: [u8; 32] = URL_SAFE_NO_PAD.decode(key).expect("b64").try_into().expect("32 bytes");
    let small = rec.chunks.lock().unwrap().iter().find(|(_, _, b)| b.len() < 1024).cloned().expect("a.txt chunk");
    assert_ne!(small.2, b"hello");
    assert_eq!(hcfs_client::crypto::decrypt_small(&small.2, &key).expect("decrypts"), b"hello");

    assert_eq!(link.expires_at.as_deref(), Some("2026-10-09T00:00:00+00:00"), "expiry comes from the seal");
    let keystore = SqliteShareKeystore::new(state.pool().unwrap().clone());
    assert_eq!(keystore.get(&link.share_token).unwrap(), Some(ShareSecret::Public(key)));

    let seen = seen.lock().unwrap();
    assert!(matches!(seen.last().map(|p| p.phase), Some(SharePhase::Finalizing)), "ends finalizing");
    assert!(
        seen.iter().any(|p| matches!(p.phase, SharePhase::Uploading) && p.bytes_done == p.bytes_total && p.bytes_total > 0),
        "uploading reaches its total, summed across files"
    );
}
```

Tighten the per-file chunk loop to group by `file_id` once PART 1's chunk numbering is
known: it should assert exactly `total_chunks` PUTs per `file_id`. As written it is only a
lower bound. The `decrypt_small` assertion assumes PART 1's single-chunk framing is the same
one `folder_shares_real_backend.rs` decrypts with (`hcfs_client::crypto::decrypt_small`). If
PART 1 frames differently, use the decrypt function it exports for the recipient page.

#### 6c: Failure paths

```rust
/// Cancel mid-upload tears the half-built link down on the server (abort
/// DELETE), never seals it, and reports the Finder cancel wording.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_mid_upload_aborts_the_half_built_link() {
    let account = "5UploadCancelAcct";
    let cancel = CancellationToken::new();
    let mock = UploadMock {
        on_first_chunk: OnFirstChunk::Cancel(cancel.clone()),
        ..UploadMock::default()
    };
    let (state, rec, _, _db) = upload_harness(account, CAPS_UPLOADS_ON, mock).await;
    let (_tree, root) = outside_folder();

    let err = share_outside_folder(&state, account, share_request(&root, cancel)).await.expect_err("cancelled");

    assert!(matches!(&err, AppError::Validation(m) if m == SHARE_CANCELLED), "{err:?}");
    let opened = rec.opens.lock().unwrap()[0]["token_hash"].as_str().unwrap().to_owned();
    assert_eq!(*rec.aborts.lock().unwrap(), vec![opened], "the open link is aborted");
    assert_eq!(*rec.seals.lock().unwrap(), 0, "a cancelled link is never sealed");
}

/// Over the plan: refused at the pre-flight with the copy's REAL size, and
/// nothing is opened, so no half-built link and no billing hold.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_quota_refusal_stops_the_share_before_any_upload() {
    let account = "5UploadQuotaAcct";
    let mock = UploadMock {
        can_upload: json!({ "result": false, "error": "drive_quota_exceeded" }),
        ..UploadMock::default()
    };
    let (state, rec, _, _db) = upload_harness(account, CAPS_UPLOADS_ON, mock).await;
    let (_tree, root) = outside_folder();

    let err = share_outside_folder(&state, account, share_request(&root, CancellationToken::new()))
        .await
        .expect_err("over quota");

    assert!(matches!(err, AppError::NotReady(NotReadyKind::StorageLimitReached)), "{err:?}");
    assert_eq!(*rec.can_upload_sizes.lock().unwrap(), vec![5 + 9 * 1024 * 1024], "gated on the copy's bytes");
    assert!(rec.opens.lock().unwrap().is_empty(), "nothing opened");
}

/// A server that predates uploaded copies: refused with the "isn't
/// available yet" wording before the disk is walked or quota asked.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_without_uploaded_copies_refuses_before_any_work() {
    let account = "5UploadCapsAcct";
    let (state, rec, recorded, _db) = upload_harness(account, r#"{"shares":true,"folder_shares":true}"#, UploadMock::default()).await;
    let (_tree, root) = outside_folder();

    let err = share_outside_folder(&state, account, share_request(&root, CancellationToken::new()))
        .await
        .expect_err("capability missing");

    assert!(matches!(&err, AppError::Validation(m) if m == UPLOAD_FOLDER_SHARES_UNAVAILABLE), "{err:?}");
    assert_eq!(*recorded.capability_hits.lock().unwrap(), 1);
    assert!(rec.can_upload_sizes.lock().unwrap().is_empty(), "no quota pre-flight");
    assert!(rec.opens.lock().unwrap().is_empty(), "no open");
}

/// A file still being written: the share fails, names the file, and the
/// half-built link is aborted rather than sealed with bytes that no longer
/// match the source.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_that_changes_mid_upload_fails_the_share_naming_it() {
    let account = "5UploadGrowAcct";
    let tree = tempfile::TempDir::new().expect("tempdir");
    let root = tree.path().join("Downloads-in-progress");
    std::fs::create_dir_all(&root).expect("root");
    let growing = root.join("movie.part");
    std::fs::write(&growing, vec![1u8; 4096]).expect("seed");
    let mock = UploadMock {
        on_first_chunk: OnFirstChunk::Grow(growing),
        ..UploadMock::default()
    };
    let (state, rec, _, _db) = upload_harness(account, CAPS_UPLOADS_ON, mock).await;

    let err = share_outside_folder(&state, account, share_request(&root, CancellationToken::new()))
        .await
        .expect_err("source changed");

    assert!(matches!(&err, AppError::Validation(m) if m.contains("\u{201c}movie.part\u{201d}")), "{err:?}");
    assert_eq!(rec.aborts.lock().unwrap().len(), 1, "the link is aborted");
    assert_eq!(*rec.seals.lock().unwrap(), 0);
}

/// An empty folder is refused locally: no quota question, no open.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_empty_outside_folder_is_refused_before_any_request() {
    let account = "5UploadEmptyAcct";
    let (state, rec, _, _db) = upload_harness(account, CAPS_UPLOADS_ON, UploadMock::default()).await;
    let tree = tempfile::TempDir::new().expect("tempdir");

    let err = share_outside_folder(&state, account, share_request(tree.path(), CancellationToken::new()))
        .await
        .expect_err("empty");

    assert!(matches!(&err, AppError::Validation(m) if m.contains("no files")), "{err:?}");
    assert!(rec.can_upload_sizes.lock().unwrap().is_empty());
    assert!(rec.opens.lock().unwrap().is_empty());
}
```

#### 6d: Listing source (Task 5's behaviour through the real client)

```rust
/// The owner listing as the server sends it after an outside-folder share:
/// an upload row with "" drive identity and `source: "upload"`, next to a
/// drive row whose server predates `source`. Both parse, and each row
/// reaches the FE under the key Rust chose.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_listing_carries_each_rows_source() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5ListSourceAcct";
    let row = |hash: &str, folder_hash: serde_json::Value, source: Option<&str>| {
        let mut r = json!({
            "token_hash": hash, "folder_hash": folder_hash, "path_prefix": "",
            "display_name": "T2-KD", "created_at": "2026-10-02T00:00:00Z",
            "expires_at": null, "revoked_at": null,
        });
        if let Some(s) = source {
            r["source"] = json!(s);
        }
        r
    };
    let list = json!([
        row(&"ab".repeat(32), json!("0123456789abcdef"), None),
        row(&"cd".repeat(32), json!(""), Some("upload")),
    ]);
    let base = serve(share_router(MockOptions { list, ..MockOptions::default() }, Recorded::default())).await;
    seed_account(&pool, account, &base).await;
    let state = make_state(pool, account);

    let rows = list_folder_shares_inner(&state, account).await.expect("list");
    let json = serde_json::to_value(&rows).expect("serialize");
    assert_eq!(json[0]["source"], "drive", "a row without source is a drive link");
    assert_eq!(json[1]["source"], "uploadedCopy");
    assert_eq!(json[1]["folderHash"], "");
}
```

Also add a sibling test, `an_upload_row_with_null_drive_identity_still_parses`. It is the
same setup with `json!(null)` for `folder_hash` and `path_prefix` on the upload row, and it
asserts that the listing still succeeds and `json[0]["folderHash"] == ""`. It pins that the
NEW client tolerates the server mistake that Contract deviation 8 forbids. If PART 1 decides
not to tolerate `null`, delete this test and say so in the PR.

**Run:** `cd src-tauri && cargo test --test shares_server_mock`
Expected: `test result: ok.`, with the 7 new tests and every existing test passing.

To check the tests can fail, run three experiments one at a time and revert each:
- In `share_outside_folder`, move `require_eligible` after the upload call: the quota test
  fails (`nothing opened`).
- In `dispatch.rs`, wrap the outside branch in `until_cancelled`: the wiring pin from Task 4
  fails. The mock cancel test cannot see the dispatcher, which is why that pin exists.
- Pass `CancellationToken::new()` instead of `request.cancel` to the client: the cancel test
  hangs or completes and seals. It fails on `seals == 0`.

**Commit**

```
Test the uploaded-copy folder share against a mock server

Covers what a user would notice: the link opens the uploaded ciphertext,
Cancel aborts the half-built link instead of sealing it, an over-plan
account uploads nothing, an older server says "isn't available yet",
a growing file fails the share by name, and listing rows keep their
source.
```

---

### Task 7: CHANGELOG and the rules file

**Files:** `CHANGELOG.md`, `.claude/rules/shares-and-shared-drives.md:473`,
`.claude/rules/testing.md:23`

**Step 1: CHANGELOG.** Under `## [Unreleased]` → the first `### Added` heading (about line
162), insert as the first bullet:

```markdown
- **Share any folder from Finder as a link, even one outside your Hippius
  drives.** The copy is removed when the link expires.
```

**Step 2: The rules file.** In `shares-and-shared-drives.md` line 473, replace the sentence
"An OUTSIDE-drive folder from Finder is refused ("Only folders inside a synced Hippius
drive…")." with:

> An OUTSIDE-drive folder from Finder is uploaded as a copy through `shares/outside_folder.rs::share_outside_folder` (capability `upload_folder_shares` → `folder_scan` with the drive-upload skip rules from `pathops::visible_children` → `require_eligible(Sharing, total_bytes)` → hcfs `create_upload_folder_share` → `push_folder_for_account`; order pinned in that module). Its Cancel is cooperative — the token goes into the upload so the client can `DELETE` the half-built link; every other Finder mint is dropped by `dispatch::until_cancelled` (pinned in `tests/folder_share_wiring.rs`). Listing rows carry `source` (`FolderShareOrigin`, `"uploadedCopy"`): the shares page labels them "Uploaded copy" and the badge index skips them, since their `folder_hash`/`path_prefix` are `""`.

In `testing.md` line 23, append to the folder-shares bullet: "Uploaded-copy shares:
`shares_server_mock.rs` (open/files/chunks/seal, cancel→abort, quota, capability,
mid-upload change, listing `source`) and scenario 4 of `folder_shares_real_backend.rs`."

Run the rule probe from CLAUDE.md with
`claude -p "Read src-tauri/src/shares/outside_folder.rs and reply DONE"`. Expected:
`shares-and-shared-drives.md` with `"load_reason":"path_glob_match"`.

**Step 3: Commit**

```
Note outside-folder sharing in the changelog and rules

Users can now share any Finder folder as a link; the rules file
records the funnel order and why its cancel is cooperative so the next
change to the Finder mint path keeps the server-side abort.
```

---

### Task 8: Live lane scenario (service behaviour mocks cannot prove)

Under `docs/testing-policy.md`, endpoint semantics and real ciphertext belong in
`*_real_backend.rs`, and the lane must pass on the pin bump.

**File:** `src-tauri/tests/folder_shares_real_backend.rs` (new scenario after line 715's
test; reuse `live_env`, `live_pool`, `seed_account`, `make_state`, `split_share_url`, and
`anon_get`). Add these imports:
`tauri_project_lib::shares::outside_folder::{OutsideFolderShare, share_outside_folder}`,
`tauri_project_lib::shares::commands::revoke_folder_share_inner` (if not already imported),
and `tokio_util::sync::CancellationToken`.

```rust
// ── Scenario 4: an outside folder uploaded as a copy ───────────────────────

/// The Finder outside-folder share against a real server: the uploaded
/// copy is browsable anonymously (empty subfolder included), the `#k=`
/// key decrypts the blob route's bytes, the owner listing marks the row
/// `uploadedCopy`, and a revoke cuts recipients off immediately. Revoke
/// runs even after a failed assertion via the captured-then-asserted
/// order this file's header recommends.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "live-lane: needs HCFS_DESKTOP_E2E_SERVER_URL + HCFS_DESKTOP_E2E_BEARER + HCFS_DESKTOP_E2E_SS58 and a running hcfs-server with upload_folder_shares"]
async fn outside_folder_copy_round_trips_browse_decrypt_list_and_revoke() {
    let Some(env) = live_env() else { return };
    let _home = &*TEST_HOME;
    let http = reqwest::Client::new();

    let tree = tempfile::TempDir::new().expect("tree");
    let root = tree.path().join(unique_label("outside"));
    std::fs::create_dir_all(root.join("empty")).expect("empty");
    let plaintext: &[u8] = b"an uploaded copy must open with its own key";
    std::fs::write(root.join("hello.txt"), plaintext).expect("file");

    let dir = tempfile::TempDir::new().expect("db");
    let pool = live_pool(dir.path()).await;
    seed_account(&pool, &env).await;
    let state = make_state(pool, &env.ss58);

    let request = OutsideFolderShare {
        folder: &root,
        ttl: ShareTtl::Hours24,
        choice: ShareChoice::Public,
        progress: None,
        cancel: CancellationToken::new(),
    };
    let link = share_outside_folder(&state, &env.ss58, request).await.expect("live share");
    let (token, key) = split_share_url(&link.share_url, "#k=");
    let key: [u8; 32] = key.try_into().unwrap_or_else(|v: Vec<u8>| panic!("key len {}", v.len()));

    // Capture everything first, revoke, then assert.
    let browse = anon_get(&http, &format!("{}/v1/folder-shares/{token}/browse", env.server_url)).await;
    let browse_status = browse.status().as_u16();
    let browse: serde_json::Value = browse.json().await.unwrap_or_default();
    let blob = anon_get(&http, &format!("{}/v1/folder-shares/{token}/blob?path=hello.txt", env.server_url)).await;
    let blob_bytes = blob.bytes().await.map_err(reqwest::Error::without_url).expect("blob body");
    let rows = list_folder_shares_inner(&state, &env.ss58).await.expect("list");
    revoke_folder_share_inner(&state, &env.ss58, &token).await.expect("revoke");
    let after = anon_get(&http, &format!("{}/v1/folder-shares/{token}/meta", env.server_url)).await;

    assert_eq!(browse_status, 200, "{browse}");
    let names: Vec<&str> = browse["files"].as_array().into_iter().flatten().filter_map(|f| f["name"].as_str()).collect();
    assert!(names.contains(&"hello.txt"), "{browse}");
    assert!(browse.to_string().contains("empty"), "the empty subfolder is listed: {browse}");
    assert_eq!(hcfs_client::crypto::decrypt_small(&blob_bytes, &key).expect("decrypt"), plaintext);
    let row = rows.iter().find(|r| r.token_hash == folder_share_token_hash(&token)).expect("listed");
    assert_eq!(serde_json::to_value(row.source).unwrap(), "uploadedCopy");
    assert_eq!(after.status().as_u16(), 404, "revoked: recipients are cut off");
}
```

`browse`'s folder field name and the root-level listing shape are whatever PART 1/2 settle
on for folder links today. Adjust the empty-folder assertion to the real key (for example
`browse["folders"]`). The `to_string().contains` check above is only a deliberately loose
placeholder until that key is known.

Run: `cd src-tauri && cargo test --test folder_shares_real_backend -- --list`, which should
show the scenario as ignored. Then run the lane:
`gh workflow run e2e-live.yml --ref <branch> -f suite=folder_shares`.

**Commit**

```
Prove the uploaded-copy folder link against a live server

Mocks cannot show that the server browses an upload-source link, serves
ciphertext the fragment key opens, lists the row as an uploaded copy,
and cuts recipients off on revoke; the live lane can, and it runs on
the pin bump.
```

---

### Requested item → task map

| Request | Task |
|---|---|
| 1 hcfs pin + wire pins + live lane note | 1 (live lane: 1 Step 6, 8) |
| 2 scan | 2 |
| 3 `share_outside_folder` | 3 |
| 4 dispatch routing, progress, chooser size | 4 |
| 5 listing `source` + FE label | 5 |
| 6 mock-server tests | 3 Step 1 (success, red first) + 6 |
| 7 CHANGELOG | 7 |

### Final verification (before the PR)

```bash
cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test
cd .. && nvm use 22 && pnpm typecheck && pnpm lint && pnpm test
gh workflow run e2e-live.yml --ref <branch> -f suite=all   # must be green before merge
```

Do the macOS dogfood step on a packaged staging build: right-click `~/Downloads/<folder>`,
then Share with Hippius. The chooser should show a size and the copy notice. Share the
folder and open the link in a private browser window. Back in Shared links, the row should
read "Uploaded copy". Click Cancel during a large share; the row must not appear.

PR target: `staging`. Run the adversarial self-review per the global rules. The PR body
says what the code does now.

---

### Open risks

1. **Cross-repo listing break (high).** If PART 1's server sends `null` for an upload row's
   `folder_hash`/`path_prefix`, every shipped desktop (production `main`, beta) and console
   fails to parse its whole folder-share list. Shared links goes empty and folder badges
   disappear as soon as one upload row exists. The server has to emit `""` (deviation 8).
   PART 1 should pin that with a serialization test.
2. **Window close mid-upload.** Closing the window drops the confirm command future, so no
   abort is sent. The half-built link and its billing hold then last until the 60-minute
   idle reaper runs. That is accepted, but it is visible as briefly reserved quota.
3. **Mid-upload quota race.** `/can_upload` is a pre-flight. A concurrent upload elsewhere
   can push the account over during a large share, and the server's per-chunk hold refuses
   it. The desktop maps that refusal to a generic `Hcfs` error, not to the plans dialog. If
   PART 1 surfaces a typed quota error (for example `FolderShareError::QuotaExceeded`), map
   it to `NotReady(StorageLimitReached)` in `map_upload_folder_share_error`.
4. **macOS privacy prompts.** Reading `~/Downloads`, `~/Desktop` and `~/Documents` needs
   TCC consent. Today's outside-file share already triggers it. A walk may hit a declined
   folder only partway down. The scan fails and names that folder; it does not skip it.
   The message points at System Settings, but it cannot reopen the prompt.
5. **The chooser scans twice.** The chooser runs a scan with a 2 s budget, and the confirm
   runs another. Between the two, the folder can change, so the chooser's size may differ
   from the billed size. The per-file stat re-check in the client covers correctness, not
   that number. On very large trees the chooser opens without a size.
6. **Many small files.** Up to 50,000 files means at least 150,000 requests (init, chunk,
   complete) at 4 in flight. The progress bar reports bytes, so many tiny files can look
   stalled. If dogfood shows a long flat bar, PART 1 could add a per-file tick.
7. **PART 1 surface not final.** Variant names (`SourceChanged`, `Cancelled`), `file_id`
   type, chunk numbering, the open-route `token_hash` (client-generated token), and the
   small-file framing that `decrypt_small` assumes are all taken from `contract.md`.
   Tasks 3 and 6 name the exact lines to adjust.
8. **`pathops` visibility widened** from `pub(super)` to `pub(crate)`. Only
   `visible_children`, `VisibleEntry` and `VisibleKind` are `pub(crate)`. The other
   helpers keep their narrower visibility, but a reviewer should confirm that no other
   item became reachable by accident.

---
