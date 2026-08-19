# In-app folder share via link — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add "Share via link" for folders to the app's own menus, producing the
same zip-snapshot link the macOS Finder right-click already produces.

**Architecture:** The zip-and-share engine already exists
(`shares::commands::share_directory_as_zip`) but is reachable only from the
Finder dispatcher. This adds two Tauri commands in front of it — one to mint,
one to preflight size — plus a settled-folder guard shared with folder rename,
a size cap that also closes an existing unbounded-walk limitation on the Finder
path, and menu wiring across the three surfaces that already carry Rename.

**Tech Stack:** Rust (Tauri 2, sqlx, tokio, zip crate), TypeScript (Next.js 15,
Jotai, TanStack Query, Vitest + Testing Library).

**Design doc:** `docs/plans/2026-08-13-in-app-folder-share-design.md`

**Worktree:** `.worktrees/feat-folder-share` on branch `feat/in-app-folder-share`.

---

## Background you need before Task 1

Read these before writing code. They are the load-bearing pieces.

- `src-tauri/src/shares/commands.rs` — `create_share_inner` (the file path),
  `share_directory_as_zip` (the folder path), `sync_root_for_label`,
  `resolve_inside_sync_root`, `require_shares_supported`.
- `src-tauri/src/shares/zip_dir.rs` — `zip_directory_to_temp` / `zip_dir_into`.
  Note exactly which entries the walk skips: **symlinks** (`file_type()` does
  not traverse them, so a symlink matches neither `is_dir` nor `is_file`) and
  **non-UTF-8 names**. Dotfiles ARE included.
- `src-tauri/src/sync/fileops/files/rename.rs:102-131` — the unsettled-folder
  guard this feature reuses.
- `src-tauri/src/sync/fileops/files/synced_state.rs` — `synced_paths_for_label`,
  the map both the guard and the file browser's `pending` badge read.
- `app/components/page-sections/drive/ShareFileModal.tsx` — the modal whose
  lifecycle is reused unchanged.
- `app/lib/utils/renameGating.ts` — the gating module this mirrors.

**Two traps this plan exists to avoid:**

1. `sync::fileops::files::dir_stats::dir_stats_recursive` looks like the right
   thing to back the preflight. It is NOT: it skips dotfiles and follows
   symlinks (`entry.metadata()`), the opposite of the zip walk on both counts.
   The preflight number must be measured by the same rules that decide what
   lands in the archive, or the modal will say "within limits" for a folder the
   backend then refuses (or vice versa).
2. A folder row's drive-relative path is **not** `file.actualFileName`. For
   nested rows that field holds only the basename; the containing path lives in
   `file.parentRelativePath` (expanded tree) or the table's
   `currentSubfolderPath` (subfolder view). Compare `getFolderKey` in
   `app/components/page-sections/drive/files-table/index.tsx:265-272`, which
   resolves through `resolveRelativePath`. Passing `actualFileName` to the IPC
   would share the wrong folder — `Trips/Photos` would resolve to a root-level
   `Photos`.

**Commands:**

```bash
# Rust (run from src-tauri/)
SQLX_OFFLINE=true cargo test --lib shares::            # unit tests in the module
SQLX_OFFLINE=true cargo clippy --all-targets --all-features -- -D warnings
cargo fmt                                              # NEVER `cargo fmt --all`
# Frontend (run from the worktree root)
pnpm test <path>                                       # single vitest file
pnpm lint
npx tsc --noEmit
```

---

### Task 1: Measure a directory by the packer's own rules

**Files:**
- Modify: `src-tauri/src/shares/zip_dir.rs`

**Step 1: Write the failing tests**

Add to the existing `mod tests` in `zip_dir.rs`:

```rust
#[test]
fn measure_counts_nested_files_and_bytes() {
    let dir = TempDir::new().expect("temp dir");
    fs::write(dir.path().join("a.txt"), b"12345").expect("write a");
    fs::create_dir(dir.path().join("sub")).expect("mkdir");
    fs::write(dir.path().join("sub/b.txt"), b"123").expect("write b");

    let measured = measure_directory(dir.path()).expect("measure");
    assert_eq!(measured.file_count, 2);
    assert_eq!(measured.total_bytes, 8);
}

#[test]
fn measure_includes_dotfiles_because_the_archive_does() {
    // `dir_stats_recursive` skips dotfiles; the zip walk does not. Measuring
    // must match the ARCHIVE, or the preflight under-reports and the cap
    // rejects a folder the UI called shareable.
    let dir = TempDir::new().expect("temp dir");
    fs::write(dir.path().join(".env"), b"secret=1").expect("write dotfile");

    let measured = measure_directory(dir.path()).expect("measure");
    assert_eq!(measured.file_count, 1, "a dotfile is packed, so it must be counted");
    assert_eq!(measured.total_bytes, 8);
}

#[cfg(unix)]
#[test]
fn measure_skips_symlinks_because_the_archive_does() {
    let dir = TempDir::new().expect("temp dir");
    fs::write(dir.path().join("real.txt"), b"1234").expect("write real");
    std::os::unix::fs::symlink(dir.path().join("real.txt"), dir.path().join("link.txt")).expect("symlink");

    let measured = measure_directory(dir.path()).expect("measure");
    assert_eq!(measured.file_count, 1, "symlinks are skipped by zip_dir_into");
    assert_eq!(measured.total_bytes, 4);
}

#[test]
fn measure_agrees_with_the_archive_entry_count() {
    // The invariant that matters: whatever `measure_directory` counts is what
    // `zip_dir_into` writes. Assert them against each other rather than
    // against two hand-maintained numbers that can drift apart.
    let dir = TempDir::new().expect("temp dir");
    fs::write(dir.path().join(".hidden"), b"a").expect("write hidden");
    fs::write(dir.path().join("plain.txt"), b"bb").expect("write plain");
    fs::create_dir(dir.path().join("nested")).expect("mkdir");
    fs::write(dir.path().join("nested/deep.bin"), b"ccc").expect("write deep");

    let measured = measure_directory(dir.path()).expect("measure");
    let archived = zip_then_read(dir.path());
    assert_eq!(measured.file_count as usize, archived.len());
}
```

**Step 2: Run the tests to verify they fail**

```bash
cd src-tauri && SQLX_OFFLINE=true cargo test --lib shares::zip_dir
```

Expected: FAIL — `cannot find function measure_directory in this scope`.

**Step 3: Implement**

Add above `zip_dir_into` in `zip_dir.rs`:

```rust
/// Plaintext size and file count of what [`zip_dir_into`] would pack.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DirMeasurement {
    pub total_bytes: u64,
    pub file_count: u64,
}

/// Measure `src_dir` using the SAME walk rules as [`zip_dir_into`]: symlinks
/// and non-UTF-8 names skipped, dotfiles included.
///
/// Deliberately NOT `sync::fileops::files::dir_stats::dir_stats_recursive`,
/// which answers a different question — it skips dotfiles and follows symlinks
/// via `metadata()`. Reusing it would let the preflight report a size the cap
/// then disagrees with, so the UI would call a folder shareable and the mint
/// would refuse it.
///
/// Synchronous (`std::fs`) to match the packer; both callers already run it on
/// a `spawn_blocking` thread.
pub(crate) fn measure_directory(src_dir: &Path) -> Result<DirMeasurement> {
    let mut total_bytes: u64 = 0;
    let mut file_count: u64 = 0;

    let mut stack: Vec<PathBuf> = vec![src_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if entry.file_name().to_str().is_none() {
                continue;
            }
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                total_bytes = total_bytes.saturating_add(entry.metadata()?.len());
                file_count += 1;
            }
        }
    }

    Ok(DirMeasurement { total_bytes, file_count })
}
```

**Step 4: Run the tests to verify they pass**

```bash
cd src-tauri && SQLX_OFFLINE=true cargo test --lib shares::zip_dir
```

Expected: PASS, all tests in the module.

**Step 5: Commit**

```bash
git add src-tauri/src/shares/zip_dir.rs
git commit -m "feat(shares): measure a directory by the zip packer's own rules

The preflight and the size cap both need to know how big a folder share
would be. dir_stats_recursive is the wrong source: it skips dotfiles and
follows symlinks, the opposite of the zip walk on both counts, so its
number would disagree with what the archive actually contains."
```

---

### Task 2: Cap the folder-share size in the packer

**Files:**
- Modify: `src-tauri/src/shares/zip_dir.rs`

**Step 1: Write the failing tests**

```rust
#[test]
fn limits_accept_a_folder_at_the_boundary() {
    let at_limit = DirMeasurement { total_bytes: MAX_FOLDER_SHARE_BYTES, file_count: MAX_FOLDER_SHARE_ENTRIES };
    assert!(enforce_folder_share_limits(at_limit).is_ok(), "the limit itself is allowed");
}

#[test]
fn limits_reject_an_oversized_folder_and_name_the_number() {
    let too_big = DirMeasurement { total_bytes: MAX_FOLDER_SHARE_BYTES + 1, file_count: 1 };
    let err = enforce_folder_share_limits(too_big).expect_err("must refuse");
    let message = err.to_string();
    assert!(message.contains("2 GB"), "message must state the limit, got: {message}");
}

#[test]
fn limits_reject_too_many_entries() {
    let too_many = DirMeasurement { total_bytes: 1, file_count: MAX_FOLDER_SHARE_ENTRIES + 1 };
    let err = enforce_folder_share_limits(too_many).expect_err("must refuse");
    assert!(err.to_string().contains("10,000"), "message must state the entry limit");
}
```

**Step 2: Run to verify failure**

```bash
cd src-tauri && SQLX_OFFLINE=true cargo test --lib shares::zip_dir
```

Expected: FAIL — `cannot find value MAX_FOLDER_SHARE_BYTES`.

**Step 3: Implement**

```rust
/// Largest folder, in plaintext bytes, that may be shared as a zip.
///
/// The archive is built into a temp file before upload, so an unbounded walk
/// fills the temp disk and starts an upload nobody can cancel except by
/// quitting. The credit eligibility gate is a positive-balance floor, not a
/// byte budget, so it does not bound this.
pub(crate) const MAX_FOLDER_SHARE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Largest entry count for the same reason: 200k tiny files is a slow walk and
/// a zip central directory nothing downstream wants.
pub(crate) const MAX_FOLDER_SHARE_ENTRIES: u64 = 10_000;

/// Refuse a folder share that would exceed either limit, naming the actual
/// value so the message is actionable rather than a bare "too large".
pub(crate) fn enforce_folder_share_limits(measured: DirMeasurement) -> Result<()> {
    if measured.total_bytes > MAX_FOLDER_SHARE_BYTES {
        return Err(crate::error::AppError::Validation(format!(
            "This folder is {} and can't be shared as a link (limit 2 GB). Share a smaller folder, or share files individually.",
            crate::billing::charts::format_bytes(measured.total_bytes as f64)
        )));
    }
    if measured.file_count > MAX_FOLDER_SHARE_ENTRIES {
        return Err(crate::error::AppError::Validation(format!(
            "This folder has {} files and can't be shared as a link (limit 10,000).",
            measured.file_count
        )));
    }
    Ok(())
}
```

Check `format_bytes`'s real signature in `src-tauri/src/billing/charts.rs`
first; if it is not `pub(crate)` or takes a different argument type, inline a
small local formatter rather than widening its visibility for one call site.

**Step 4: Run to verify pass**

```bash
cd src-tauri && SQLX_OFFLINE=true cargo test --lib shares::zip_dir
```

**Step 5: Enforce it in the shared entry point**

In `src-tauri/src/shares/commands.rs::share_directory_as_zip`, inside the
existing `spawn_blocking` closure, measure and enforce BEFORE packing:

```rust
let temp = tokio::task::spawn_blocking(move || {
    let measured = crate::shares::zip_dir::measure_directory(&src)?;
    crate::shares::zip_dir::enforce_folder_share_limits(measured)?;
    crate::shares::zip_dir::zip_directory_to_temp(&src)
})
.await
.map_err(|e| AppError::Io(std::io::Error::other(e)))??;
```

Then delete the `KNOWN LIMITATION` paragraph from that function's doc comment
and replace it with a line pointing at the constants. Both entry points — the
new in-app command and the existing Finder dispatcher — go through this
function, so the Finder path gains the cap for free.

**Step 6: Verify and commit**

```bash
cd src-tauri && SQLX_OFFLINE=true cargo test --lib shares:: && SQLX_OFFLINE=true cargo clippy --all-targets --all-features -- -D warnings
git add src-tauri/src/shares/
git commit -m "feat(shares): cap folder-share size before packing

share_directory_as_zip carried a KNOWN LIMITATION: no size or entry cap, so
a click on a large tree filled the temp disk and began an unbounded upload.
The cap sits in the packer, so the Finder right-click gains it too."
```

---

### Task 3: Extract the settled-folder guard

The unsettled-folder check in `rename.rs:117-131` answers exactly the question
folder-share needs. Extract it so the two cannot drift.

**Files:**
- Modify: `src-tauri/src/sync/fileops/files/synced_state.rs`
- Modify: `src-tauri/src/sync/fileops/files/rename.rs:117-131`

**Step 1: Write the failing test**

In `synced_state.rs`, add a `mod tests`:

```rust
#[test]
fn settled_when_every_synced_child_is_on_disk() {
    let root = TempDir::new().expect("temp dir");
    std::fs::create_dir_all(root.path().join("trips/2024")).expect("mkdir");
    std::fs::write(root.path().join("trips/2024/a.jpg"), b"x").expect("write");

    let synced = vec!["trips/2024/a.jpg".to_string()];
    assert_eq!(folder_settlement(root.path(), "trips", Some(&synced)), FolderSettlement::Settled);
}

#[test]
fn unsettled_when_a_synced_child_is_missing_on_disk() {
    let root = TempDir::new().expect("temp dir");
    std::fs::create_dir_all(root.path().join("trips")).expect("mkdir");

    // Known to the drive, absent from disk — the same condition that makes
    // the file browser render this child as `pending`.
    let synced = vec!["trips/2024/a.jpg".to_string()];
    assert_eq!(folder_settlement(root.path(), "trips", Some(&synced)), FolderSettlement::Pending);
}

#[test]
fn unknown_when_the_drive_has_no_synced_map() {
    let root = TempDir::new().expect("temp dir");
    // Drive paused or logged out. Unknown must NOT read as settled: that would
    // let pausing a drive unlock sharing a half-downloaded folder.
    assert_eq!(folder_settlement(root.path(), "trips", None), FolderSettlement::Unknown);
}

#[test]
fn a_sibling_sharing_a_name_prefix_is_not_treated_as_a_child() {
    let root = TempDir::new().expect("temp dir");
    std::fs::create_dir_all(root.path().join("trips")).expect("mkdir");

    // "trips2/x" must not count as a child of "trips".
    let synced = vec!["trips2/x.jpg".to_string()];
    assert_eq!(folder_settlement(root.path(), "trips", Some(&synced)), FolderSettlement::Settled);
}
```

**Step 2: Run to verify failure**

```bash
cd src-tauri && SQLX_OFFLINE=true cargo test --lib synced_state
```

Expected: FAIL — `cannot find function folder_settlement`.

**Step 3: Implement**

```rust
/// Whether a folder's contents are all present on this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FolderSettlement {
    /// Every rel-path the drive knows under this folder exists on disk.
    Settled,
    /// At least one known child is missing locally — the same condition that
    /// makes `list_sync_folder_grouped` report `sync_status: "pending"`.
    Pending,
    /// No synced map available (drive paused, logged out, cold start).
    Unknown,
}

/// Classify `folder_rel` under `sync_root` against the drive's synced rel-paths.
///
/// Callers must treat `Unknown` as "refuse", never as "allow": a paused drive
/// returns `None` here, and allowing on unknown would let pause become a way to
/// bypass the check.
pub(crate) fn folder_settlement(sync_root: &Path, folder_rel: &str, synced_rel_paths: Option<&[String]>) -> FolderSettlement {
    let Some(rel_paths) = synced_rel_paths else {
        return FolderSettlement::Unknown;
    };
    // Trailing slash so a sibling with a shared name prefix ("trips2/x") is not
    // mistaken for a child of "trips".
    let prefix = format!("{}/", folder_rel.trim_end_matches('/'));
    for rel in rel_paths {
        if rel.starts_with(&prefix) && !sync_root.join(rel).exists() {
            return FolderSettlement::Pending;
        }
    }
    FolderSettlement::Settled
}
```

**Step 4: Run to verify pass, then rewire rename**

Replace the inline loop at `rename.rs:117-131` with a `folder_settlement` call,
keeping rename's existing behaviour exactly: rename refuses on `Pending` with
its current message and, because it already passes `Option<&[String]>`,
continues to ALLOW on `Unknown` (its guard is `if let Some(...)` today — do not
change rename's risk posture in this task).

**Step 5: Verify rename's own tests still pass**

```bash
cd src-tauri && SQLX_OFFLINE=true cargo test --lib rename
```

Expected: PASS, including
`rename_entry_inner_folder_blocks_when_synced_children_missing_on_disk` and
`rename_entry_inner_unsettled_guard_ignores_sibling_prefix_folders`. If either
fails, the extraction changed behaviour — fix the helper, not the test.

**Step 6: Commit**

```bash
git add src-tauri/src/sync/fileops/files/
git commit -m "refactor(sync): extract the settled-folder guard

Folder share needs the same question folder rename already asks. One helper
so the two cannot drift; rename's behaviour is unchanged, pinned by its
existing tests."
```

---

### Task 4: `hcfs_create_folder_share`

**Files:**
- Modify: `src-tauri/src/shares/commands.rs`
- Modify: `src-tauri/src/main.rs` (command registration)

**Step 1: Write the failing tests**

Put these in `commands.rs`'s test module (or create one). They target the
resolution + guard layer, which is what can silently do the wrong thing —
minting itself needs a live server and is covered by the existing share tests.

```rust
#[tokio::test]
async fn folder_share_rejects_a_path_escaping_the_drive() {
    let root = TempDir::new().expect("temp dir");
    let err = resolve_inside_sync_root(root.path(), "../outside").await.expect_err("must refuse");
    assert!(matches!(err, AppError::Validation(_)));
}

#[tokio::test]
async fn folder_share_rejects_a_file_path() {
    let root = TempDir::new().expect("temp dir");
    std::fs::write(root.path().join("a.txt"), b"x").expect("write");
    let resolved = resolve_inside_sync_root(root.path(), "a.txt").await.expect("resolve");
    let meta = tokio::fs::metadata(&resolved).await.expect("stat");
    assert!(!meta.is_dir(), "a file must not satisfy the folder-share dir check");
}
```

**Step 2: Run to verify they fail (or compile-fail)**

```bash
cd src-tauri && SQLX_OFFLINE=true cargo test --lib shares::commands
```

**Step 3: Implement the command**

```rust
/// Mint a share link for a FOLDER inside a synced drive.
///
/// The share engine shares one byte stream, so the folder is packed into a
/// single `<name>.zip` and that blob is shared — a snapshot, not a live view.
/// This is the same call the macOS Finder right-click makes, deliberately: the
/// two entry points must never produce different artifacts.
///
/// Refuses a folder that is not fully present on this device. A recipient must
/// never receive an archive that is quietly missing files, so a folder with any
/// child the drive knows about but this device has not downloaded is rejected
/// rather than zipped incomplete.
#[tauri::command]
pub async fn hcfs_create_folder_share(
    state: tauri::State<'_, AppState>,
    folder_label: String,
    relative_path: String,
    ttl: String,
    visibility: String,
    password: Option<String>,
    on_progress: Channel<ShareProgress>,
) -> Result<ShareLink> {
    let account_id = state.current_account_id()?;
    let ttl = parse_ttl(&ttl)?;
    let choice = ShareChoice::parse(&visibility, password)?;

    let pool = state.pool()?;
    let sync_root = sync_root_for_label(pool, &account_id, &folder_label).await?;
    let dir_path = resolve_inside_sync_root(&sync_root, &relative_path).await?;
    if !tokio::fs::metadata(&dir_path).await?.is_dir() {
        return Err(AppError::Validation("This entry is not a folder".into()));
    }

    // Settled check before any packing: it is the cheapest rejection and the
    // most likely one during an active sync.
    let synced = crate::sync::fileops::files::synced_state::synced_paths_for_label(&state.sync, &folder_label).await;
    let synced_keys: Option<Vec<String>> = synced.map(|map| map.into_keys().collect());
    match folder_settlement(&sync_root, &relative_path, synced_keys.as_deref()) {
        FolderSettlement::Settled => {}
        FolderSettlement::Pending | FolderSettlement::Unknown => {
            return Err(AppError::Validation(
                "This folder isn't fully synced on this device yet. Wait for sync to finish, then share.".into(),
            ));
        }
    }

    let progress = share_progress_forwarder(on_progress);
    let link = share_directory_as_zip(&state, &account_id, &dir_path, ttl, choice, Some(progress)).await?;

    // Origin sidecar so the folder row shows the same "Shared" badge a file
    // does. Best-effort, exactly like the file path: the link is already live,
    // and a failed sidecar write only costs the badge.
    let owner = account_key(&account_id);
    if let Err(e) = origin::record(pool, &link.share_token, &owner, &folder_label, &relative_path).await {
        warn!(share_token = %link.share_token, error = %e, "Failed to record share_origin for folder share");
    }

    Ok(link)
}
```

Notes for the implementer:
- `share_directory_as_zip` already runs `require_shares_supported` +
  `require_eligible`. Do not duplicate those here.
- `synced_paths_for_label` is `pub(super)` within `sync::fileops::files`. Widen
  it to `pub(crate)` (and re-export at `crate::sync::files` if that is how the
  module facade exposes siblings — follow whatever the neighbouring
  re-exports do in `mod.rs`).
- `share_directory_as_zip` is `#[cfg(any(unix, windows))]`. That covers every
  target this app builds for, so no cfg widening is needed — but if a build
  fails on the Linux CI job, widen the cfg rather than duplicating the function.

**Step 4: Register the command**

In `src-tauri/src/main.rs`, next to `crate::shares::commands::hcfs_create_share`
(around line 347), add `crate::shares::commands::hcfs_create_folder_share,`.

Do NOT run `cargo fmt --all` on `main.rs` — it recurses the module tree and
produces an enormous unrelated diff. Use `cargo fmt` on the touched file only.

**Step 5: Verify**

```bash
cd src-tauri && SQLX_OFFLINE=true cargo test --lib shares:: && SQLX_OFFLINE=true cargo clippy --all-targets --all-features -- -D warnings
```

**Step 6: Commit**

```bash
git add src-tauri/src/shares/commands.rs src-tauri/src/main.rs src-tauri/src/sync/
git commit -m "feat(shares): add hcfs_create_folder_share

Mints a zip-snapshot link for a folder inside a synced drive, via the same
share_directory_as_zip call the Finder right-click makes. Refuses a folder
with any child not yet present locally rather than zipping it incomplete."
```

---

### Task 5: `hcfs_folder_share_preflight`

**Files:**
- Modify: `src-tauri/src/shares/commands.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/tests/hcfs_contract.rs` (camelCase pin)

**Step 1: Write the failing test**

In `hcfs_contract.rs`, next to the existing wire-shape pins:

```rust
#[test]
fn folder_share_preflight_stays_camel_case() {
    // The FE reads these keys directly; a serde rename would silently blank the
    // modal's size line and its disabled state.
    let json = serde_json::to_value(FolderSharePreflight {
        total_bytes: 12,
        file_count: 3,
        within_limits: true,
        limit_bytes: 2 * 1024 * 1024 * 1024,
        limit_files: 10_000,
    })
    .expect("serialize");

    let keys: BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        BTreeSet::from(["totalBytes", "fileCount", "withinLimits", "limitBytes", "limitFiles"]),
    );
}
```

**Step 2: Run to verify failure**

```bash
cd src-tauri && SQLX_OFFLINE=true cargo test --test hcfs_contract
```

**Step 3: Implement**

```rust
/// What the share modal shows before the user commits to a folder share.
///
/// `within_limits` is decided here, against the same constants the mint
/// enforces, so the modal's disabled state cannot drift from what the backend
/// will accept.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSharePreflight {
    pub total_bytes: u64,
    pub file_count: u64,
    pub within_limits: bool,
    pub limit_bytes: u64,
    pub limit_files: u64,
}

/// Measure a folder so the share modal can show its size and refuse early.
///
/// Measured by the packer's own walk rules, not `dir_stats_recursive` — see
/// `zip_dir::measure_directory`.
#[tauri::command]
pub async fn hcfs_folder_share_preflight(
    state: tauri::State<'_, AppState>,
    folder_label: String,
    relative_path: String,
) -> Result<FolderSharePreflight> {
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    let sync_root = sync_root_for_label(pool, &account_id, &folder_label).await?;
    let dir_path = resolve_inside_sync_root(&sync_root, &relative_path).await?;

    let measured = tokio::task::spawn_blocking(move || crate::shares::zip_dir::measure_directory(&dir_path))
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e)))??;

    Ok(FolderSharePreflight {
        total_bytes: measured.total_bytes,
        file_count: measured.file_count,
        within_limits: crate::shares::zip_dir::enforce_folder_share_limits(measured).is_ok(),
        limit_bytes: crate::shares::zip_dir::MAX_FOLDER_SHARE_BYTES,
        limit_files: crate::shares::zip_dir::MAX_FOLDER_SHARE_ENTRIES,
    })
}
```

Register it in `main.rs` alongside Task 4's command.

**Step 4: Verify and commit**

```bash
cd src-tauri && SQLX_OFFLINE=true cargo test --test hcfs_contract && SQLX_OFFLINE=true cargo clippy --all-targets --all-features -- -D warnings
git add src-tauri/src/shares/commands.rs src-tauri/src/main.rs src-tauri/tests/hcfs_contract.rs
git commit -m "feat(shares): add hcfs_folder_share_preflight

Size and file count for the share modal, measured by the packer's own walk
rules and judged against the same constants the mint enforces."
```

---

### Task 6: Frontend IPC wrappers

**Files:**
- Modify: `app/lib/tauri/shares.ts`

**Step 1: Implement** (no test of its own — a thin `invoke` wrapper; Task 9's
modal test asserts it is called correctly)

```ts
/**
 * Size and file count of a folder share, plus whether it is within the
 * backend's limits. `withinLimits` is decided in Rust against the constants
 * the mint enforces, so the modal never disables on a rule the backend
 * doesn't apply — or offers one it will reject.
 */
export interface FolderSharePreflight {
  totalBytes: number;
  fileCount: number;
  withinLimits: boolean;
  limitBytes: number;
  limitFiles: number;
}

export async function folderSharePreflight(
  folderLabel: string,
  relativePath: string,
): Promise<FolderSharePreflight> {
  return invoke<FolderSharePreflight>("hcfs_folder_share_preflight", {
    folderLabel,
    relativePath,
  });
}

/**
 * Mint a share link for a folder. The folder is packed into one `<name>.zip`
 * and that archive is shared — a snapshot, so later changes to the folder do
 * not appear in the link. Same `Channel` progress mechanics as
 * {@link createShare}.
 */
export async function createFolderShare(
  folderLabel: string,
  relativePath: string,
  choice: ShareChoice,
  onProgress?: (progress: ShareProgress) => void,
): Promise<ShareLink> {
  const onProgressChannel = new Channel<ShareProgress>();
  if (onProgress) onProgressChannel.onmessage = onProgress;
  return invoke<ShareLink>("hcfs_create_folder_share", {
    folderLabel,
    relativePath,
    ttl: choice.ttl,
    visibility: choice.visibility,
    password: choice.password ?? null,
    onProgress: onProgressChannel,
  });
}
```

**Step 2: Verify the IPC-name guard still passes**

There is a contract test that checks every `invoke("…")` name in the frontend
against the Rust command registry (it once caught six dead VPN command refs).

```bash
pnpm test app/lib/__tests__   # find the exact file with: rg -l "generate_handler|invoke name" app --glob '*.test.ts'
```

Expected: PASS — both new names exist in `main.rs` after Tasks 4 and 5.

**Step 3: Commit**

```bash
git add app/lib/tauri/shares.ts
git commit -m "feat(shares): frontend wrappers for the folder-share commands"
```

---

### Task 7: Folder gating + relative-path resolution

**Files:**
- Create: `app/lib/utils/folderShareGating.ts`
- Create: `app/lib/utils/__tests__/folderShareGating.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  canShareFolder,
  folderShareRelativePath,
} from "@/app/lib/utils/folderShareGating";

const folder = (over: Partial<FormattedUserFile> = {}): FormattedUserFile =>
  ({
    name: "Photos",
    isFolder: true,
    isAssigned: true,
    source: "/Users/me/Drive/Photos",
    createdAt: 0,
    arionHash: "",
    arionCid: "",
    minerIds: [],
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    ...over,
  }) as FormattedUserFile;

describe("canShareFolder", () => {
  it("allows a settled local folder", () => {
    expect(canShareFolder(folder())).toBe(true);
  });

  it("refuses a folder still being uploaded", () => {
    expect(canShareFolder(folder({ isAssigned: false }))).toBe(false);
  });

  it("refuses a cloud-only folder with nothing on disk", () => {
    // A search / other-device hit: carries a server fileId but no local path,
    // so there is nothing to zip.
    expect(canShareFolder(folder({ fileId: "abc", source: undefined }))).toBe(false);
  });

  it("refuses a folder whose contents are still pending", () => {
    expect(canShareFolder(folder({ syncStatus: "pending" }))).toBe(false);
  });

  it("refuses a file", () => {
    expect(canShareFolder(folder({ isFolder: false }))).toBe(false);
  });
});

describe("folderShareRelativePath", () => {
  it("uses the name alone at the drive root", () => {
    expect(folderShareRelativePath(folder(), "")).toBe("Photos");
  });

  it("prefixes the containing folder for a nested row", () => {
    // The trap this function exists for: a nested folder row's name is only
    // the basename, so passing it straight to the IPC would target a
    // root-level "Photos" instead of "Trips/Photos".
    expect(folderShareRelativePath(folder({ parentRelativePath: "Trips" }), "")).toBe("Trips/Photos");
  });

  it("prefixes the table's subfolder path when the row carries no parent", () => {
    expect(folderShareRelativePath(folder(), "Trips/2024")).toBe("Trips/2024/Photos");
  });

  it("leaves an already-qualified name alone", () => {
    expect(folderShareRelativePath(folder({ actualFileName: "Trips/Photos" }), "Trips")).toBe("Trips/Photos");
  });

  it("strips stray leading and trailing slashes", () => {
    expect(folderShareRelativePath(folder({ name: "/Photos/" }), "/Trips/")).toBe("Trips/Photos");
  });
});
```

**Step 2: Run to verify failure**

```bash
pnpm test app/lib/utils/__tests__/folderShareGating.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement**

```ts
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * Single gate for whether a folder row's "Share via link" action is enabled.
 * Shared by the files-table menu, card view, and the right-click context menu
 * so the three surfaces can't drift. Mirrors `canRenameFile`.
 *
 * A folder share zips the folder from disk, so it needs the entry to actually
 * be on this device and at rest:
 *
 * - `!isAssigned`: still mid-upload, no settled server identity.
 * - `fileId && !source`: a cloud-only row (search / recent-uploads hit with no
 *   local path) — nothing on disk to pack.
 * - explicit non-"synced" status: pending download or upload. `undefined`
 *   status (plain local listings that never set one) stays shareable.
 *
 * Rust re-checks all of this and additionally verifies every child is present;
 * this gate is for the menu's disabled state, not for security.
 */
export function canShareFolder(file: FormattedUserFile): boolean {
  if (!file.isFolder) return false;
  if (!file.isAssigned) return false;
  if (file.fileId && !file.source) return false;
  if (file.syncStatus !== undefined && file.syncStatus !== "synced") return false;
  return true;
}

export const FOLDER_SHARE_DISABLED_TOOLTIP =
  "Only folders fully synced on this device can be shared as a link. Wait for sync to finish and try again.";

/**
 * Resolve a folder row's drive-relative path for the share IPC.
 *
 * A folder row's `actualFileName` is NOT always the full path: the
 * inline-expanded tree stores only the basename and carries the containing
 * path in `parentRelativePath`, while the subfolder view supplies it as
 * `basePath`. Handing the bare name to the backend would resolve a nested
 * `Trips/Photos` to a root-level `Photos` and share the wrong folder.
 *
 * Mirrors `resolveRelativePath` in the files table, which computes the same
 * value for folder keys.
 */
export function folderShareRelativePath(
  file: FormattedUserFile,
  basePath: string,
): string {
  const trim = (value: string) => value.replace(/^\/+|\/+$/g, "");
  const name = trim(file.actualFileName || file.name);
  const base = trim(file.parentRelativePath ?? basePath ?? "");
  if (!base) return name;
  if (name === base || name.startsWith(`${base}/`)) return name;
  if (name.includes("/")) return name;
  return `${base}/${name}`;
}
```

**Step 4: Run to verify pass**

```bash
pnpm test app/lib/utils/__tests__/folderShareGating.test.ts
```

**Step 5: Commit**

```bash
git add app/lib/utils/folderShareGating.ts app/lib/utils/__tests__/folderShareGating.test.ts
git commit -m "feat(shares): folder-share gating and relative-path resolution

A nested folder row's name is only its basename, so the share IPC needs the
path resolved against parentRelativePath or the table's subfolder path —
otherwise Trips/Photos targets a root-level Photos."
```

---

### Task 8: Carry an explicit relative path in the share atom

The modal currently guesses the path with `file.actualFileName || file.name`.
That is correct for files and wrong for nested folders (Task 7). Make the
surface that opens the modal state the path it means.

**Files:**
- Modify: `app/lib/global-atoms/sharesAtoms.ts`
- Modify: `app/components/page-sections/drive/ShareFileModal.tsx`
- Modify: `app/components/page-sections/drive/files-table/index.tsx`
- Modify: `app/components/page-sections/drive/card-view/index.tsx`
- Modify: `app/components/page-sections/drive/DriveContent.tsx`
- Modify: `app/components/page-sections/drive/__tests__/ShareFileModal.test.tsx`

**Step 1: Change the atom**

```ts
/**
 * Open `ShareFileModal` for this entry. `null` means closed.
 *
 * `relativePath` is resolved by the surface that opens the modal, not derived
 * inside it: a nested folder row's `actualFileName` is only the basename, so
 * the modal has no way to know the containing path on its own.
 */
export type ShareModalTarget = {
  file: FormattedUserFile;
  relativePath: string;
};

export const shareModalFileAtom = atom<ShareModalTarget | null>(null);
```

**Step 2: Update the modal**

- `const [target, setTarget] = useAtom(shareModalFileAtom);` then
  `const file = target?.file ?? null;`
- `startShare` uses `target.relativePath` instead of
  `file.actualFileName || file.name`.
- `sessionKey` becomes `file:${file.label}:${target.relativePath}`.
- The displayed filename stays `file.actualFileName || file.name` — the user
  wants the name, not the path.

**Step 3: Update the three surfaces**

Each already has its base path in scope:

- `files-table/index.tsx` — `normalizedSubfolderPath`; set
  `setShareModalFile({ file, relativePath: file.isFolder ? folderShareRelativePath(file, normalizedSubfolderPath) : (file.actualFileName || file.name) })`.
- `card-view/index.tsx` — same, using its own subfolder path prop.
- `DriveContent.tsx` (line ~538, the context-menu wiring) — uses
  `currentSubfolderPath`.

**Step 4: Run the existing modal tests and fix the fixtures**

```bash
pnpm test app/components/page-sections/drive/__tests__/ShareFileModal.test.tsx
```

They will fail on the atom's new shape. Update the seeds to
`{ file: FIXTURE, relativePath: "a.txt" }`. **Do not change what the tests
assert** — only the fixture shape.

**Step 5: Typecheck, lint, commit**

```bash
npx tsc --noEmit && pnpm lint
git add app/
git commit -m "refactor(shares): carry an explicit relative path in the share atom

The modal derived the path from actualFileName, which holds only a basename
for nested folder rows. The surface that opens the modal knows the base path;
make it say so."
```

---

### Task 9: Folder branch in the modal + menu wiring

**Files:**
- Modify: `app/components/page-sections/drive/ShareFileModal.tsx`
- Modify: `app/components/page-sections/drive/files-table/index.tsx:766-781`
- Modify: `app/components/page-sections/drive/card-view/index.tsx:335-355`
- Modify: `app/components/ui/context-menu/index.tsx:228-253`
- Modify: `app/components/page-sections/drive/__tests__/ShareFileModal.test.tsx`

**Step 1: Write the failing tests**

```tsx
it("mints a folder through createFolderShare, not createShare", async () => {
  // The two IPCs are not interchangeable: hcfs_create_share rejects a
  // directory outright.
  seedShareTarget({ file: FOLDER_FIXTURE, relativePath: "Trips/Photos" });
  render(<ShareFileModal />);

  await userEvent.click(screen.getByRole("button", { name: /create share link/i }));

  expect(createFolderShareMock).toHaveBeenCalledWith(
    "Drive",
    "Trips/Photos",
    expect.objectContaining({ ttl: "24h", visibility: "public" }),
    expect.any(Function),
  );
  expect(createShareMock).not.toHaveBeenCalled();
});

it("shows the folder's size and file count before minting", async () => {
  preflightMock.mockResolvedValue({
    totalBytes: 1_400_000_000,
    fileCount: 812,
    withinLimits: true,
    limitBytes: 2 * 1024 * 1024 * 1024,
    limitFiles: 10_000,
  });
  seedShareTarget({ file: FOLDER_FIXTURE, relativePath: "Photos" });
  render(<ShareFileModal />);

  expect(await screen.findByText(/812 files/)).toBeInTheDocument();
});

it("disables minting when the folder is over the backend's limit", async () => {
  preflightMock.mockResolvedValue({
    totalBytes: 31_000_000_000,
    fileCount: 240_000,
    withinLimits: false,
    limitBytes: 2 * 1024 * 1024 * 1024,
    limitFiles: 10_000,
  });
  seedShareTarget({ file: FOLDER_FIXTURE, relativePath: "Backups" });
  render(<ShareFileModal />);

  const create = await screen.findByRole("button", { name: /create share link/i });
  expect(create).toBeDisabled();
});

it("keeps minting available while the preflight is still in flight", async () => {
  // A slow stat must not block sharing a small folder; the Rust cap is the
  // real gate.
  preflightMock.mockReturnValue(new Promise(() => {}));
  seedShareTarget({ file: FOLDER_FIXTURE, relativePath: "Photos" });
  render(<ShareFileModal />);

  expect(screen.getByRole("button", { name: /create share link/i })).toBeEnabled();
});

it("does not preflight a file", () => {
  seedShareTarget({ file: FILE_FIXTURE, relativePath: "a.txt" });
  render(<ShareFileModal />);

  expect(preflightMock).not.toHaveBeenCalled();
});
```

**Step 2: Run to verify failure**

```bash
pnpm test app/components/page-sections/drive/__tests__/ShareFileModal.test.tsx
```

**Step 3: Implement the modal branch**

- Fetch the preflight in an effect when `file.isFolder`, keyed on
  `sessionKey`, storing `FolderSharePreflight | null`. Swallow errors to `null`
  — the mint re-checks and gives the authoritative message.
- Pass it to `ChoosingBody` as an optional `folderPreflight` prop. Render the
  size + count line and "Packed as `<name>.zip` — a snapshot of the folder
  right now"; when `withinLimits === false`, render the limit message and add
  `folderPreflight?.withinLimits === false` to the Create button's `disabled`.
- In `startShare`, call `createFolderShare` when `file.isFolder`, else
  `createShare`.

**Step 4: Wire the three menus**

Current condition (files-table, line 770):

```tsx
...(!file.isFolder && file.syncStatus === "synced" && shareEnabled ? [ … ] : [])
```

Becomes: files keep that rule; folders get an always-shown entry when
`shareEnabled`, with `disabled: !canShareFolder(file)` and
`tooltip: canShareFolder(file) ? undefined : FOLDER_SHARE_DISABLED_TOOLTIP`.
Apply the same change in the card view and in `context-menu/index.tsx`
(which currently hides the item for folders entirely — check its own
condition around line 228 and mirror the table's).

**Step 5: Verify**

```bash
pnpm test app/components/page-sections/drive
npx tsc --noEmit && pnpm lint
```

**Step 6: Commit**

```bash
git add app/
git commit -m "feat(shares): share a folder via link from the app's menus

Adds the folder branch to the share modal (preflight size, snapshot notice,
over-limit refusal) and enables the menu item for folders across the three
surfaces that already carry Rename."
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/plans/2026-08-13-in-app-folder-share-design.md`

**Step 1: CLAUDE.md**

Add to the shares area a paragraph covering: folder shares are a zip snapshot
minted by `hcfs_create_folder_share`, delegating to the same
`share_directory_as_zip` the Finder path uses; the cap constants live in
`zip_dir.rs` and apply to both entry points; a folder with any child not on
disk is refused via the shared `folder_settlement` helper (also used by folder
rename); and the FE must resolve a folder's relative path through
`folderShareRelativePath`, never `actualFileName` alone.

**Step 2: Amend the design doc**

Record the measurement decision made during implementation: the preflight is
backed by `zip_dir::measure_directory`, not `dir_stats_recursive`, because the
two walks disagree on dotfiles and symlinks.

**Step 3: Commit**

```bash
git add CLAUDE.md docs/plans/
git commit -m "docs: record the in-app folder-share wiring"
```

---

## Definition of done

```bash
cd src-tauri && SQLX_OFFLINE=true cargo test && SQLX_OFFLINE=true cargo clippy --all-targets --all-features -- -D warnings
cd .. && pnpm test && pnpm lint && npx tsc --noEmit
```

All green, with the frontend baseline still at or above 679 passing tests.

Manual check on macOS (`pnpm tauri:dev`), since no automated layer covers the
real mint:

1. Right-click a small synced folder in the files table → "Share via link" →
   size line shows → Create → link copied → open it in a browser and confirm the
   zip downloads and unpacks with the folder's files.
2. Right-click a folder with a pending child → item disabled with the tooltip.
   Force the backend path too (share while a download is mid-flight) and confirm
   the "isn't fully synced" message rather than a partial archive.
3. Right-click a very large folder → over-limit message, Create disabled.
4. Confirm the same folder still shares correctly from the macOS Finder
   right-click, and that a large folder is now refused there too.
