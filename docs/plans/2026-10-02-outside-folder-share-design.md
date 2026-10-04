# Sharing a Folder Outside a Drive — Design

**Status:** implemented. The canonical design, as built, is hcfs's
[`docs/plans/2026-10-02-outside-folder-share-design.md`](https://github.com/thenervelab/hcfs/blob/main/docs/plans/2026-10-02-outside-folder-share-design.md)
(shipped in [thenervelab/hcfs#547](https://github.com/thenervelab/hcfs/pull/547);
the console side in
[thenervelab/hippius-console#1023](https://github.com/thenervelab/hippius-console/pull/1023)).
This page only summarizes it for the desktop. Where it and the code differ,
the code wins.

## What it does

Finder's "Share with Hippius" on a folder outside every synced drive uploads
a copy of the folder's files under the link's own key and mints a
`/share/folder/{token}` link that recipients browse exactly like an in-drive
folder link. The copy never enters a drive, is billed against the Drive quota
while the link lives, and is deleted by the server when the link expires or is
revoked. It is a snapshot: later changes to the local folder do not reach it.

## Where it lives in the desktop

- `src-tauri/src/finder_bridge/dispatch.rs` routes a Finder click on an outside
  folder to the funnel, and tells the chooser it will upload a copy. The
  chooser opens at once; the folder's size, or the share's refusal of it,
  follows in `finder:share-facts`.
- `src-tauri/src/shares/folder_scan.rs` walks the folder with the drive
  upload's skip rules and enforces hcfs-shared's limits with user-facing
  sentences.
- `src-tauri/src/shares/outside_folder.rs` is the funnel: capability, scan,
  quota gate, `hcfs_client` `create_upload_folder_share` (which takes the
  modal's cancel token, so a cancel aborts the half-built link), then the
  owner wrap. A cancel that lands after the link is sealed revokes it.
- Listing rows carry `source`; the frontend labels an uploaded copy and never
  feeds it to drive badges.

The implementation plan for the desktop part is
[`2026-10-02-outside-folder-share.md`](2026-10-02-outside-folder-share.md).
