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
- Always reader / single-use / ≤30 days.
