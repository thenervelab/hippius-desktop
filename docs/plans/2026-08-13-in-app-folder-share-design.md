# In-app folder share via link

Date: 2026-08-13
Status: implemented (see the amendments at the end)

## Problem

A folder can be shared from the macOS Finder right-click ("Share with Hippius"),
but not from inside the app. The 3-dot menu in the files table offers "Share via
link" for single files only — the item is gated `!file.isFolder`, and the
backing IPC `hcfs_create_share` rejects a directory outright:

```rust
if !metadata.is_file() {
    return Err(AppError::Validation("Cannot share a directory".into()));
}
```

The engine work already exists. `shares::commands::share_directory_as_zip` packs
a directory into one `application/zip` temp archive and streams it through the
same `create_share` pipeline a file uses. It is `pub(crate)` and reachable only
from the Finder dispatcher (`finder_bridge/dispatch.rs:163`). The gap is an IPC
command, a settled-folder guard, a size cap, and menu wiring.

## Semantics

A folder share is a **zip snapshot**, identical to what the Finder entry point
produces today: the folder is packed into `<name>.zip` at mint time and one link
is minted for that blob. Later changes to the folder do not appear in the link.

The alternative — a live browsable folder link, where the recipient lists and
downloads files individually — was considered and rejected for this change. The
share engine shares exactly one byte stream; a live folder needs a new
folder-share entity in hcfs-server, a new console page, and desktop wiring. That
is a three-repo feature, not an in-app menu item.

Keeping the in-app path on the same `share_directory_as_zip` call as Finder is
deliberate: the two entry points cannot drift in what a recipient receives.

## Backend

### New command: `hcfs_create_folder_share`

Lives in `shares/commands.rs`, registered in `main.rs` next to
`hcfs_create_share`. Same parameters (`folder_label`, `relative_path`, `ttl`,
`visibility`, `password`, `on_progress: Channel<ShareProgress>`) and the same
`ShareLink` return, so the frontend modal's running/done/error lifecycle,
progress bar, auto-copy, and revoke are reused unchanged.

Order of operations:

1. `parse_ttl` + `ShareChoice::parse` — argument validation before any disk or
   network work, matching `hcfs_create_share`.
2. `require_shares_supported` + `require_eligible(.., Sharing, 0)`.
3. `sync_root_for_label` → `resolve_inside_sync_root` — the existing traversal
   guard, so a folder share cannot escape the drive root via `..` or a symlink.
4. Assert `metadata.is_dir()` — the mirror of the file command's directory
   rejection.
5. Settled-folder guard (below).
6. Size cap (below).
7. Delegate to `share_directory_as_zip`, which packs on `spawn_blocking` and
   streams the temp archive through `create_share`.

### Settled-folder guard

**Rule: a folder is shareable only when every file it contains is present on
this device. A folder with any pending child is refused, not silently zipped
without it.** A recipient must never receive an archive that is quietly missing
files.

The check reads `synced_paths_for_label(&state.sync, label)`, the drive's
rel-path → info map built from the engine's `synced` tree. This is the same
source the file browser's pending marker comes from:
`list_sync_folder_grouped` reports `sync_status: "pending"` for exactly those
entries that are in the map but absent from disk. Using it here means the UI's
badge and the backend's refusal agree by construction.

```
for rel in synced_rel_paths where rel starts_with "<folder_rel>/":
    if !sync_root.join(rel).exists()  ->  refuse
```

Refusal message: "This folder isn't fully synced on this device yet. Wait for
sync to finish, then share."

Consequences:

- A cloud-only folder (nothing on disk, surfaced from the rel-path or
  `folder_entries_local` overlay) fails the same check with no special case.
- When the map is `None` — drive not running, logged out, paused — the answer is
  *unknown*, and unknown refuses. Allowing on unknown would let a paused drive
  silently unlock sharing an unsettled folder.

`rename.rs:117-131` already asks the identical question for folder renames.
That block and this one become a single shared helper rather than two copies
that can drift.

### Size cap

`share_directory_as_zip` carries a `KNOWN LIMITATION` note: no size or entry cap.
Nothing bounds the walk, so a click on a large tree fills the temp disk and
starts an unbounded upload. The eligibility gate is a positive-balance floor, not
a byte budget.

The in-app entry point makes that far easier to hit — a drive root is one
right-click away in the files table. The cap therefore lands in `zip_dir.rs` as a
pre-walk check, so **both** entry points get it and the existing limitation is
closed for Finder as well:

```rust
pub(crate) const MAX_FOLDER_SHARE_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB
pub(crate) const MAX_FOLDER_SHARE_ENTRIES: u64 = 10_000;
```

Over either limit returns `AppError::Validation` naming the actual size or count
and the limit, so the message is actionable rather than a bare refusal.

### New command: `hcfs_folder_share_preflight`

Returns `{ totalBytes, fileCount, withinLimits, limitBytes, limitFiles }`,
backed by the already-cached `dir_stats_recursive` (per-mtime cache, so an
unchanged folder costs no walk). The modal renders this before the user commits
to a share.

`withinLimits` is computed in Rust against the same constants that enforce the
cap, so the disabled state in the UI cannot drift from what the backend accepts.

### Origin sidecar

In-app folder shares call `origin::record(token, owner, label, folder_rel_path)`
like the file path does. The Finder zip path skips it because an outside folder
has no drive identity; an in-drive folder has one. This gives the folder row the
same "Shared" badge as a file through the existing `useSharedFiles` index at no
extra cost.

## Frontend

### Gating

New `app/lib/utils/shareGating.ts`, mirroring `renameGating.ts`:

```ts
export function canShareFolder(file: FormattedUserFile): boolean
export const FOLDER_SHARE_DISABLED_TOOLTIP: string
```

Enabled when the row is a folder, `isAssigned`, locally present (`source` set, or
no `fileId`), and settled (`syncStatus` unset or `"synced"`). One gate, three
surfaces.

### Menu wiring

Today's condition is `!file.isFolder && file.syncStatus === "synced" &&
shareEnabled`. Files keep that rule unchanged. Folders show the item whenever
`shareEnabled`, `disabled: !canShareFolder(file)` with the tooltip — visible but
greyed, so the user learns the capability exists and why it is unavailable.

The three surfaces are exactly the set Rename already covers:

- `createTableItems` in `files-table/index.tsx` (drive table, recent files, and
  `ExpandedFolderRows`)
- the card-view menu
- `FileContextMenu`, wired from `DriveContent`

### Modal

`ShareFileModal` needs no new atom and no new state machine —
`shareModalFileAtom` already carries a `FormattedUserFile` with `isFolder`. Two
branches:

- `ChoosingBody` takes an optional `folderPreflight`. When present it renders the
  size and file count, the line "Packed as `<name>.zip` — a snapshot of the
  folder right now", and disables Create with the limit message when
  `withinLimits` is false.
- `startShare` calls `createFolderShare` instead of `createShare` when
  `file.isFolder`.

Everything else is untouched: `running` / `done` / `error`, the progress channel,
`sessionKey` reset, auto-copy, revoke.

The preflight fires when the modal opens on a folder. While it is in flight,
Create stays enabled with no size line — a slow stat must not block a small
folder's share, and the Rust cap is the real gate.

### IPC wrappers

`app/lib/tauri/shares.ts` gains `createFolderShare(folderLabel, relativePath,
choice, onProgress)` and `folderSharePreflight(folderLabel, relativePath)`,
keeping that file the only place in the frontend that talks to the share
commands.

## Tests

Rust:

- Settled guard: settled folder passes; one synced child missing on disk is
  refused; a `None` map is refused.
- Size cap: at the limit passes, over each of the two limits is refused with the
  actual value in the message.
- `is_dir` rejection for a file path; traversal rejection for `../`.
- camelCase serde pin for the preflight struct, next to the existing
  `ShareProgress` / `SharePhase` pins in `tests/hcfs_contract.rs`.

Frontend:

- `shareGating.test.ts` for `canShareFolder` across assigned / cloud-only /
  pending / synced rows.
- `ShareFileModal` folder tests: the preflight line renders, an over-limit
  preflight disables Create, and confirming calls `createFolderShare` rather than
  `createShare`.

## Documentation

`CLAUDE.md` gains the folder-share path in the shares section: the zip-snapshot
semantics, the two cap constants, the settled-folder rule, and the note that the
guard is shared with folder rename.

## Amendments made during implementation

Five things the design got wrong or left open. Recorded here so the doc matches
the shipped code.

1. **The preflight cannot reuse `dir_stats_recursive`.** The design named it as
   the backing measurement. It skips dotfiles and resolves symlinks through
   `metadata()`; the zip packer does the opposite on both counts. A measurement
   that disagrees with the archive would let the modal call a folder shareable
   that the mint then refuses. `zip_dir::measure_directory` walks by the
   packer's own rules instead, and a test asserts the two agree rather than
   pinning a second hand-maintained number.

2. **Tasks 1 and 2 could not be separate commits.** A measurement function with
   no caller is dead code, so the zero-warnings gate fails until the cap that
   uses it lands. They shipped together.

3. **The cap is decimal 2 GB, not 2 GiB**, and the Rust formatter is SI. The
   frontend's `formatBytes` is 1000-based, so a binary constant made the same
   limit render as two different numbers across the modal and the backend's
   refusal message.

4. **There are four share surfaces, not three.** `FileViewerLayout` also opens
   the modal. Separately, card view had no base path at all, so a folder shared
   from it inside a subfolder would have resolved against the drive root;
   `currentSubfolderPath` is now threaded in from `DriveContent`.

5. **The settled-folder helper reports three states, not two.** Folder share
   refuses on `Unknown` (paused drive, cold start) because it hands bytes to a
   third party; folder rename proceeds on it, as it always has, because the
   engine reconciles a local rename either way. Folding `Unknown` into either
   answer would have silently changed one of the two callers.

`cargo fmt` must not be run in this repo, including with an explicit path
argument: it walks the whole crate module tree, and the committed code is not
rustfmt-clean, so it rewrites ~66 unrelated files.

## Amendments from independent review

Four independent reviewers (Rust, frontend, security, conventions) audited the
branch after the first implementation pass. What they found, and what changed:

6. **Hidden files must not be shared.** The packer archived dotfiles. The sync
   engine never uploads them (`add.rs` mirrors hcfs-client's
   `should_skip_path`) and the file browser never lists them, so sharing a
   folder would have published `.env`, `.git/config` and `.ssh` — data the user
   has never seen in Hippius and that has never left their machine. Both walks
   now skip them. This also changes the pre-existing Finder folder-share, which
   had the same defect.

7. **The settled guard moved into `share_directory_as_zip`.** It was in the IPC
   command, so the file-manager right-click — which calls the zip funnel
   directly — never ran it, while the doc claimed the two entry points could not
   differ. The cap was already correctly placed in the funnel; the guard now
   sits beside it.

8. **The guard is fed a canonical path.** It compared the caller's raw string
   against the engine's rel-paths, so `trips//sub` or a case variant matched
   zero paths and reported "settled" having checked nothing — the same hole as
   the drive-root case, through another door. The drive and rel-path are now
   resolved from the canonicalized `dir_path`, and the origin sidecar is keyed
   on that too.

9. **The nested-folder share targeted the wrong folder.** `createTableItems`
   received the expanded subtree's path as `parentSubFolderPath` and every other
   path-sensitive item used it; the share item did not. Sharing `Trips/Photos`
   from an expanded row resolved to a root-level `Photos`. The right-click path
   had the same defect via an un-annotated row. Both fixed and pinned by source
   tests, because the pure resolver tests passed throughout.

10. **`folderShareRelativePath` collapsed same-named nesting.** `Trips/Trips`
    resolved to `Trips`, sharing the parent — a strict superset of what the user
    picked. The already-qualified short-circuit is now gated on the name
    actually containing a path.

11. **The cap is enforced during the pack, not only before it.** Measure and
    pack are separate walks, so a concurrent download landed in the archive
    uncounted. `zip_dir_into` now aborts on its own running totals.

Smaller items also addressed: the preflight gained the capability gate and the
`is_dir` check it was missing; the entry-limit message interpolates the constant
instead of a hardcoded "10,000"; backslash entry names are skipped (zip-slip on
some Windows extractors); stale `hippius-share-*.zip` archives left by a crash
are swept at startup; the right-click menu's disabled share row now looks
disabled; the modal shows a folder's full relative path so the confirmation step
identifies which folder is being published.

Two documentation claims were also corrected rather than defended: the "Shared"
badge does not appear for nested folder rows, and the settled guard cannot see
children that exist only on the server (a limitation `rename.rs` already
documented and this doc had overstated).
