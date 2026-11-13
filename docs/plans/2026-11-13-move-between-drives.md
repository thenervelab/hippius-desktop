# Moving files and folders between drives

Code: `src-tauri/src/sync/fileops/drive_move/`. Server contract:
`docs/public/api/drive-moves.md` in hcfs (behind `HCFS_FEATURE_DRIVE_MOVES`,
advertised as `drive_moves` on `/v1/capabilities`).

## The move

Every drive has its own key and the server holds none, so a move is a copy
encrypted again under the destination's key, staged on a server-side move,
then one commit that swaps everything or changes nothing:

1. `POST /v1/drive_moves` opens the move.
2. Per file: read the plaintext, encrypt it in ONE read (`copy::seal` hashes
   the same bytes with both owners' salts as they pass), check the source
   salted hash equals the row the commit will name, open a copy session on
   the move, send the chunks, finalize (which stages it).
3. `POST /v1/drive_moves/{id}/commit` with every source `path_hash` and the
   folders moved whole.

Cancel, and every failure before the commit, aborts the move: nothing
changes on either drive. A commit that gets no answer is asked again (a
repeated commit answers the first one's result) and is never aborted, since
it may have landed; the person is told to check both drives.

Everything the webview must ask is asked before the long part starts: the
`preflight` call returns name clashes (Keep both or Skip; Replace is not
offered because the commit refuses an occupied target, so a replace could
not be part of the atomic step) and then what moving a shared folder turns
off. Caps (2,000 files, 100 folders per commit) are refused up front:
a folder must move whole in one commit, so a move over the cap cannot be
split without moving part of a folder, and splitting by item would break
"nothing changes on failure".

**Screen recordings keep their mark.** A copy's session declares no
`capture`: the commit gives the destination row the copy's capture kind when
it declares one, else the source's (hcfs#1313), and the Free plan's
recording count follows the same rule. The desktop cannot read a file's kind
(`get_state` does not carry it, and a recording may be tagged after upload),
so any declaration would be a guess, and one on an ordinary video would make
it a recording. Pinned by `a_recordings_copy_declares_no_capture_so_it_keeps_the_source_kind`.

The webview shows each file on the remote-upload rows the sync widget
already renders, and a toast with Cancel. Closing the dialog does not cancel.

## Synced drives

Either drive may be synced to a folder here. Two goals: no second transfer,
and no state the engines disagree with, including after a crash.

**Reading.** A synced source's plaintext is its own file. Because the seal
reads it once and the source salted hash must equal the server row's, a
file with local edits not yet uploaded (or a newer server revision not yet
downloaded) is refused rather than moved over the newer version, and the
commit's `expected_revision_id` catches a server change after the read. A
file not on disk (excluded, never downloaded) is downloaded and verified.

**After the commit**, while holding each synced drive's sync lock (the
per-drive `DriveManager` mutex a sync cycle holds for its whole run; waited
for up to a minute), `local::place_after_commit` does on disk what the two
engines' next cycles would end in, without their transfers:

- the destination file is put at its new path from plaintext already here:
  the source file itself (a rename on one volume; a copy through a hidden
  `.hippius-incoming-*` sibling otherwise), or the copy downloaded to
  re-encrypt it. hcfs's planner classifies local and remote present with the
  same content hash and no merge base as "both created, same content":
  nothing is transferred and `update_synced_tree` records the base at the
  server's revision. The salted hash matches because the copy's manifest
  hash is salted with the destination's wire owner, as the engine's scan is;
- the source file is removed. Local and remote are then both absent over a
  merge base: "both deleted", nothing to do, base dropped. No remote delete is
  planned, so the mass-delete hold never sees it, and when the move emptied
  the drive on the server the empty-listing confirmation is written for it.

A source file that changed since it was read (size or modified time) is not
touched, so its engine raises the usual "changed here, deleted on Hippius"
question. A destination path that is already taken is not overwritten, so its
engine reconciles it against the copy. Empty moved folders are removed with
`remove_dir` only.

**Why this is safe to stop at any point.** Nothing local is touched before
the commit. After it, every step is one an engine would take itself, so
whatever is not done (the app quits, a disk error, a cycle held the lock
past the wait) is done by the next cycles, by download and delete. The worst
case is the cost the plain "let the engines reconcile" design always pays.

Rejected: placing the copy in the destination folder before the commit
(the engine would upload it as a new file, and the commit would then refuse
`target_exists`), and deleting the source before the commit (the engine
would delete the server file and the commit would refuse `revision_mismatch`).

Proved against the pinned engine in `tests/drive_move_local_sync.rs`
(destination, source, both synced, and a control showing the stand-in sees
the download when nothing is placed). The flow against a stand-in server is
`tests/drive_move_server_mock.rs`.

## Not done

- A move left open by a crash before its commit is freed by the server's
  hourly sweep after 24 hours; until then it holds the destination's quota.
- Empty folders alone (no files) are refused: the commit needs at least one
  file. Empty subfolders of a moved folder move with it.
- Drag and drop between drives is out of scope.
