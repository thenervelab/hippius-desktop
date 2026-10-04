# Sharing a Folder Outside a Drive — Implementation Plan (desktop part)

> **Status: shipped.** This file keeps only the hippius-desktop part (Part 3) of
> the original three-part plan, plus the decisions that bound all three parts.
> The hcfs part (server + hcfs-client) shipped in
> [thenervelab/hcfs#547](https://github.com/thenervelab/hcfs/pull/547) and the
> console part in
> [thenervelab/hippius-console#1023](https://github.com/thenervelab/hippius-console/pull/1023);
> their plans are not repeated here. The plan predates parts of the hcfs and
> desktop code it describes: **where the plan and the code differ, the code
> wins.**

**Goal:** Finder's "Share with Hippius" on a folder outside every synced drive
uploads a copy under the link's own key and mints a live folder link that
behaves exactly like an in-drive one, and the copy is deleted when the link
expires or is revoked.

**Design:** hcfs's
[`docs/plans/2026-10-02-outside-folder-share-design.md`](https://github.com/thenervelab/hcfs/blob/main/docs/plans/2026-10-02-outside-folder-share-design.md)
is the canonical design, as implemented; this repo's
[`2026-10-02-outside-folder-share-design.md`](2026-10-02-outside-folder-share-design.md)
only summarizes it for the desktop.

---

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
