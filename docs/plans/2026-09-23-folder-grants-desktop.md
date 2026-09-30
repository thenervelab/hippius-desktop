# Folder grants (desktop)

Date: 2026-09-23
Status: ready for PR — create / list / revoke shipped on `feat/folder-grants`
Issue: thenervelab/hippius-desktop#489

Decisions (2026-09-23):
- Do **not** wait for George / do not gate on a disabled prod flag — feature is on.
- Invite **join is console-only**; desktop only creates / manages / copies links
  (opens console URL when needed).
- First-cut UX: Share folder from folder row / context menu + Manage access.

## Scope (this PR)

- **Owner / manager create & manage only.** Mint folder invites with
  `path_prefix`, list them on Links (path shown), list grant holders under
  Folder access, revoke via remove. Capability-gated on
  `capabilities.folder_grants`.
- **No invite join on desktop.** Recipients open the console invite URL.
- **First-cut UX:** “Share folder” on folder row / context menu + Manage
  access panel.

## Explicitly later

- Grant-holder sync engine (scoped tree, no uploads, rehydrate from
  `folder_grants`).
- Rename/delete of a granted folder updating grants in the same action.
- Finder context menu for folder grants.
- `replace_folder_grants` UI (PUT) — IPC exists; panel remove only for now.

## Contract reminders

- Fragment `#k=` = **derived file key**, never drive entropy.
- Response must echo `path_prefix` or refuse (old server = whole-drive mint).
- Always single-use / at most 30 days; Viewer, or Editor where the server
  allows writer folder grants.
- A folder is only ever minted through `create_folder_invite`, which requires
  the path; the drive command takes no folder.

## Folder roles (behind `FOLDER_ROLES_ENABLED`, staging only)

Follows HCFS #475 (not merged yet), kept in ONE place: the module doc of
`src-tauri/src/shared_drives/folder_roles.rs`. Folder roles are Viewer and
Editor only; Manager is not a folder role. Inside the flag nothing waits on a
capability: the UI is always there and the server's refusals read as "coming
soon" (folder invites off, Editor off, email off), so each piece lights up on
its own. `folder_grant_writes` is a hint only.

- Owner / drive Manager: Viewer / Editor picker and the email option on Share
  folder; Folder access list with names and role, Change folders (keeps the
  role) and Remove. No role change for a holder: remove and invite again.
- Holder: granted folders in Shared with me as their own rows, browsed
  remotely rooted at the grant (`grant:` browse label, `rooted_path` in Rust),
  Open and Leave. An Editor may upload, add folders, rename and share by link
  inside the folder; the desktop has no remote delete. Joining stays in the
  console.
- Out of scope: syncing a granted folder to disk.
- After #475 merges, bump the hcfs pin: it changes `hcfs-client`'s sync flow
  to materialize files at the server `relative_path`.
