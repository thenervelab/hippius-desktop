# Shared Links Page Improvements

**Status:** Design approved, not yet implemented
**Scope:** `app/(pages)/shares/page.tsx`, `SharedLinkBadge.tsx`, new SQLite history table + Rust commands, `shares/page.tsx` history section
**Date:** 2026-04-30

## Problem

Four issues on the new Shared Links page (`/shares`) and the share-aware
file rows surface a mix of bugs and missing UX:

1. Some rows render `<unknown>` as the filename with the **Copy** button
   disabled even though the link hasn't expired. This looks like a bug but
   is actually the documented "share minted on a different device" case
   (the local keystore lacks the `#k=<key>` URL fragment, so the URL can't
   be reconstructed and the filename can't be decrypted). The current copy
   makes it feel broken instead of explaining the situation.
2. Expired links disappear from the list as soon as the server reaps them.
   Users want a history they can browse and clean up themselves.
3. **Revoke** fires immediately with no confirmation. Revoking is
   destructive and irreversible — anyone holding the URL loses access on
   the next request.
4. Files that are currently shared have no visible affordance in the file
   list/card view. The `SharedLinkBadge` component is wired but the icon
   is too subtle (14px primary-blue glyph) and the tooltip omits the
   expiry information that users actually need.

(Sidebar placement of `/shares` — also raised — is deferred to a separate
discussion.)

## Goals

- Make cross-device share rows self-explanatory without restructuring the
  page.
- Persist expired and revoked share rows on this device so users can
  audit and clean up history.
- Add a confirmation step before any Revoke fires.
- Make the file-row "shared" badge noticeable at a glance and surface the
  expiry on hover.

## Non-goals

- No server-side history. Sharing-link history is a per-device memory
  aid, not a cross-device audit log. Stays in this repo, no
  hcfs-server changes.
- No change to **Reshare**'s flow. Reshare is a deliberate rotate action
  with a tooltip that already discloses the revoke step; an extra
  confirmation dialog there is friction, not safety.
- No change to `/shares` placement (deferred).
- No "extend share" primitive. Reshare already covers the rotation case.
- No automated FE tests for the dialog/badge/history UI for this round —
  manual verification matrix below is cheaper at this size.

---

## Design

### #1 — Cross-device share row UX

Code reference: `app/(pages)/shares/page.tsx:135-198` (the `ShareRow`
function), and the docstring on `ShareSummary` in
`app/lib/tauri/shares.ts:38-43` documenting the null-`shareUrl` case.

The row keeps its current layout. Three small text changes:

- Filename slot: when `row.shareUrl === null` (the marker that the local
  keystore can't reconstruct the URL), render *"Shared from another
  device"* in `italic text-grey-50` instead of the literal `<unknown>`.
  The `<unknown>` string is an internal hcfs-client marker and shouldn't
  leak to users.
- Disabled-button tooltips:
  - **Copy** tooltip changes from *"Key not on this device"* to *"The
    link can only be copied from the device that created it."*
  - **Reshare** tooltip changes from *"Reshare unavailable: this device
    doesn't know which file the share came from"* to *"Reshare requires
    the device that created this link."*
- Subtitle (size · created · expires): **unchanged**. Those fields come
  from the server, no key needed.

**Revoke** stays enabled — the server only needs the token to revoke.

No `ⓘ` info icon. The italic label and the two friendly tooltips
already explain it; another affordance is overkill.

### #2 — Expired/revoked link history

#### Storage

New SQLite table maintained via `ensure_table_schema()` in
`utils/schema.rs` (this project does schema-by-code, not migration
files):

```sql
CREATE TABLE IF NOT EXISTS shared_link_history (
  account_id     TEXT NOT NULL,
  share_token    TEXT NOT NULL,
  filename       TEXT,            -- NULL for cross-device rows we never decrypted
  folder_label   TEXT,            -- NULL when origin sidecar was missing
  relative_path  TEXT,            -- NULL when origin sidecar was missing
  plaintext_size INTEGER,
  mime_type      TEXT,
  created_at     TEXT NOT NULL,   -- RFC 3339, copied from active row
  expires_at     TEXT NOT NULL,
  ended_at       TEXT NOT NULL,   -- RFC 3339, when this row left active
  end_reason     TEXT NOT NULL,   -- 'expired' | 'revoked_here' | 'revoked_elsewhere'
  PRIMARY KEY (account_id, share_token)
);
```

`PRIMARY KEY (account_id, share_token)` makes upserts idempotent, which
matters because three different code paths can write the same row.

Per-account scoping mirrors every other local table in the project (the
account boundary is the only privacy boundary the local DB respects).

#### Capture triggers

All three triggers run inside Rust so the FE doesn't need to track
"previous poll's row set" — the comparison happens once, in one place,
on every `hcfs_list_shares` IPC.

The Rust handler for `hcfs_list_shares` is the single capture point:

1. Call hcfs-server's list endpoint, collect the `Vec<ShareSummary>`.
2. Read the per-account "last seen active set" from
   `shared_link_history` (or an in-memory cache populated at boot from
   the same table — TBD during implementation, doesn't change behavior).
3. For each row in the *previous* set that is **not** in the current
   set:
   - If `expires_at` is in the past → `end_reason = 'expired'`.
   - Otherwise → `end_reason = 'revoked_elsewhere'`. (This is the
     "active row vanished before its TTL" case, which can only mean
     someone revoked it from another device.)
   - Upsert into `shared_link_history` with `ended_at = now()`.
4. For revoke flows (`hcfs_revoke_share`): on the success branch,
   snapshot the row from the in-memory list with
   `end_reason = 'revoked_here'` and `ended_at = now()`.
5. Return the current active list to the FE as before.

The FE never sees the diff logic — it just calls `listShares()` and
gets back the active rows. A separate `hcfs_list_share_history` IPC
returns the history rows.

#### Cleanup IPC

- `hcfs_remove_share_history(share_token)` — single-row removal.
- `hcfs_clear_share_history()` — bulk clear for the current account.

Both are "remove from history" operations only — they don't touch the
server (server already considers these tokens dead).

#### FE rendering

`/shares` grows two sections:

- **Active links** (existing list, unchanged except for #1 and #3
  changes).
- **History** (new, hidden when empty). One row per history entry, same
  visual layout as the active rows, but:
  - Status badge: `Expired` (current style), `Revoked` (red-tinted), or
    *"Revoked elsewhere"* (grey-tinted).
  - Buttons: only **Remove from history**. No Copy, Reshare, Revoke —
    all moot for a non-existent share.
  - When `filename` is NULL (we never knew the file), render *"Share
    from another device"* in the same italic grey-50 style as #1.
- A *"Clear all history"* link in the section header. Confirmation
  dialog reuses `ConfirmDialog` (`mode="alert"`, `variant="warning"`).

#### Why per-device, not server-side

Server-side history would require:

- A schema migration to hcfs-server adding a `state` column (active /
  expired / revoked) and an `ended_at`.
- Stop reaping expired rows; add tombstone retention.
- A new endpoint (or extended `list_shares?include=expired,revoked`).
- A "remove from history" endpoint that deletes the tombstone server-
  side.
- Coordinated deploy across hcfs-server and the desktop.

Per-device costs ~1 day, no cross-repo work, and covers the actual user
need ("did I share this, when did it expire, can I clean up the
list?"). If cross-device history becomes a real ask later, we can
graduate. The two paths don't conflict — server-side later would just
hydrate the local table differently.

#### Cross-device cleanup (acceptable behavior)

- Device A creates a share. Both A and B see it as active.
- User revokes from device B. B's history entry: `revoked_here`. A's
  history entry (next time A polls): `revoked_elsewhere`. Both devices
  end up with a history row, just with slightly different metadata.
- This is the cost of per-device history. Acceptable.

### #3 — Revoke confirmation

Reuse the existing `ConfirmDialog` component
(`app/components/ui/ConfirmDialog.tsx`). It has an `alert` mode with a
`danger` variant — red AlertTriangle icon, red confirm button. No new
component.

Wiring in `shares/page.tsx`:

- Local state: `tokenPendingRevoke: string | null`.
- The Revoke button no longer calls `onRevoke(token)` directly. It sets
  `tokenPendingRevoke = token`.
- A `<ConfirmDialog>` is rendered with `open={tokenPendingRevoke !== null}`.
- On confirm: call existing `onRevoke(tokenPendingRevoke)`, then clear
  the state. The dialog handles its own loading state via
  `isLoading={revoking}`.
- On cancel: clear `tokenPendingRevoke`.

Copy:

- **Title:** *"Revoke this link?"*
- **Description:** *"Anyone with the link will lose access immediately.
  This can't be undone."*
- **Confirm:** *"Revoke"* (red — `variant="danger"`)
- **Cancel:** *"Cancel"*

Reshare is **not** wrapped in a confirmation. The action is intended as
a rotate, the existing tooltip already names the revoke step (*"Revoke
this link and mint a new one with a fresh expiry"*), and the new URL
auto-copies on success.

### #5 — File badge polish

Current state: `SharedLinkBadge.tsx` renders a 14px primary-blue
`Link` icon next to the filename in `NameCell.tsx:158` (table view) and
`FileCard.tsx:330` (card view). It's wired correctly but easy to miss
in a dense list, and the tooltip says only *"Shared via public link"* —
no expiry, the field users actually want.

Two changes:

#### Visibility

- Icon: 14px → **16px**.
- Add a subtle pill background: `bg-primary-95 rounded-full p-1`.
- Same primary-50 icon color on top of the pill — a soft halo, not a
  loud badge. Matches the existing `AbstractIconWrapper` pattern used
  elsewhere on the page.

#### Tooltip with expiry

`SharedLinkBadge` currently calls `useSharedFiles().isShared(label,
relPath)` which only returns a boolean. Extend the hook to return the
matching `ShareSummary` row(s) instead — same poll, no new query, just
a richer projection.

Tooltip content is then derived per-file:

- **Single share** (the common case):
  ```
  Shared via public link · expires in 4d
  Apr 28, 2026 at 14:32
  ```
- **Multiple shares** (a file can have N active shares — `createShare`
  doesn't enforce uniqueness):
  ```
  Shared via 2 public links · soonest expires in 3h
  ```
  The absolute timestamp drops out for N≥2 to keep the tooltip
  one-line. Stacking N timestamps balloons the tooltip; the count + the
  soonest-expiry is enough to know "I should go look at /shares".

Reuse the relative-time formatter in `shares/page.tsx:280`
(`formatRelative`) — extract it to a shared util in
`app/lib/utils/timeRelative.ts` so the badge tooltip and the page
header agree on phrasing.

---

## Implementation notes (per-item complexity guide, not a step list)

### Backend (Rust)

- **#2 — history table.** Add `shared_link_history` schema to
  `utils/schema.rs::ensure_table_schema`. Add three commands:
  `hcfs_list_share_history`, `hcfs_remove_share_history`,
  `hcfs_clear_share_history`. Wire the diff logic into the existing
  `hcfs_list_shares` handler in `shares/commands.rs`. Snapshot on
  revoke success in `hcfs_revoke_share`.
- All commands must follow the project's `AppError` discipline (typed
  error, structured `Serialize` shape).
- Add a unit test for the diff function covering: row added, row
  removed before expiry (→ `revoked_elsewhere`), row removed after
  expiry (→ `expired`), row reappears (idempotent upsert).

### Frontend (TypeScript)

- **#1 + #3 + #5** all touch FE only.
- **#1**: ~30 lines in `shares/page.tsx`. Replace `{row.filename}` with
  a helper that returns the italic placeholder when `row.shareUrl ===
  null`. Update two tooltip strings.
- **#3**: ~30 lines. Add state, swap the Revoke `onClick`, render
  `ConfirmDialog`. No new component.
- **#5 visibility**: ~5 lines in `SharedLinkBadge.tsx`. Wrap icon in a
  pill `<span>`, bump size.
- **#5 tooltip**: extend `useSharedFiles` to expose `getSharesFor(label,
  relPath): ShareSummary[]`. Update `SharedLinkBadge` to call it.
  Extract `formatRelative` to a shared util.
- **#2 FE**: new history section in `shares/page.tsx` rendering
  history rows with single "Remove from history" button. New
  `app/lib/tauri/shareHistory.ts` typed wrapper around the three new
  IPCs. New TanStack query for history (separate cache key from
  `shares-list`).

### Logging

All Rust additions use `tracing` macros (`info!`, `debug!`, `warn!`,
`error!`) — never `println!`/`eprintln!`. Use module-path targets so
`RUST_LOG=hippius_desktop::shares=debug` filters cleanly.

---

## Testing

### Manual verification matrix

| Scenario                                                              | Expected                                                                                                |
|-----------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| Mint share on device A; view `/shares` on device A                    | Active row, filename visible, Copy/Reshare/Revoke all enabled.                                          |
| Mint share on device A; view `/shares` on device B                    | Row labeled *"Shared from another device"* in italic grey, Copy + Reshare disabled with new tooltips.   |
| Press Revoke on an active row                                         | Confirmation dialog with the new copy. Cancel = no-op. Confirm = row removed from active, added to history with `revoked_here`. |
| Wait for an active row to expire                                      | Row moves to history with `expired` reason, `Expired` badge.                                            |
| Revoke a row from device B; refresh on device A 30s later             | Row vanishes from device A's active, appears in device A's history with `revoked_elsewhere`.            |
| Press Remove from history on a history row                            | Row disappears from history. Server unaffected (no IPC to server).                                      |
| Press Clear all history                                               | Confirmation dialog. Confirm clears all history rows for current account. Other accounts unaffected.    |
| File with 1 active share — hover badge                                | Tooltip: 2 lines, relative + absolute expiry.                                                           |
| File with 2 active shares — hover badge                               | Tooltip: single line, count + soonest-expiry.                                                           |
| File with 1 active share, badge in table row                          | Visible at a glance from a normal scroll position (the visibility is the test).                         |

### Rust unit tests

- `shared_link_history::diff` — row added, removed-before-expiry,
  removed-after-expiry, idempotent upsert, multi-account isolation.

---

## Open questions / follow-ups

- **`/shares` placement** (originally raised, deferred). Likely lands
  inside the Drive page rather than the sidebar. Will be its own
  design.
- **Auto-pruning history.** Forever-until-removed is the right default
  but if real users hit thousands of rows the table grows unbounded.
  Worth revisiting if we see it; not a launch blocker.
- **Cross-device history hydration**. If/when hcfs-server gains a
  history endpoint, the local `shared_link_history` table can be
  hydrated from it without changing the FE shape. Path-of-graduation
  noted, not blocking.
