# Shared drives parity (desktop ↔ console)

Branch: `feat/shared-drives-parity`  
Worktree: `/Users/ahmadrao/Documents/hippius/hippius-desktop-shared-drives`  
Base: `origin/staging`  
**Do not push until explicitly asked.**

## Status legend

- `[x]` done on this branch
- `[~]` partial / deferred with note
- `[ ]` still TODO

## Batch A — small frontend

| # | Item | Status |
|---|---|---|
| 1 | Reset search + filters when open drive or folder changes (console #920) | `[x]` |
| 2 | Size labels: "Drive size" inside shared drive; "Storage Used" on own drives (not "Total Storage"). "Total size" on Shared with me list N/A — desktop has no list toolbar totals yet | `[~]` |
| 3 | Remove-member confirm names the **drive**, not the member ss58 | `[x]` |

## Batch B — Rust + UI

| # | Item | Status |
|---|---|---|
| 4 | Pass through HCFS fields: `member_count`, `owner_name`, member name/email, `uploaded_by_name`, invite `minted_by_name`, `frozen`/`frozen_until` | `[x]` |
| 5 | Member count beside owner on Shared with me (`Owner · 4 members`); never fake `0` on load failure | `[x]` |
| 6 | Shared `accountDisplayName` helper for Shared by, members, Created by, File Details | `[x]` |
| 7 | Sharing badge: use listing `member_count`; only fetch invites when members==0 | `[x]` |
| 8 | "Added by" filter inside shared drives (`uploaded_by` in Rust search + UI picker) | `[~]` Rust `uploaded_by` search param + narrowing filter done; FE picker / Not recorded UI still TODO |
| 9 | Frozen drives read-only (`frozen` through; hide write actions via `driveWriteRefusal`) | `[x]` |

## Batch C — larger

| # | Item | Status |
|---|---|---|
| 10 | Seal invite tokens after mint; Links tab re-show (copy, locked, loading). Never show `#k=` | `[ ]` |
| 11 | Editors/Managers share folder by link in someone else's drive (`member_folder_shares`) | `[ ]` |
| 12 | Email invites manager-side (field, Links statuses, Approve + X25519 sealing) | `[ ]` |

## Flag / docs (item 13)

| # | Item | Status |
|---|---|---|
| 13 | Document `SHARED_DRIVES_ENABLED` vs console create/use split; fix rules doc that said "true on every lane" | `[x]` Left as one flag (`enabledFrom("beta")`); TODO noted to match console split without silently enabling create on prod |

### Flag decision

- Desktop today: one flag `SHARED_DRIVES_ENABLED = enabledFrom("beta")` (off prod, on beta/staging).
- Console: `SHARED_DRIVES` (use: on prod) + `SHARED_DRIVES_CREATE` (create: off prod).
- **Prefer matching console split if straightforward**; otherwise leave TODO — do **not** silently enable create on production.
- Rules file and featureFlags comment corrected.

## Already done elsewhere (do not redo)

- 3-dot menu doesn't select row
- `?owner=` on existing manager calls
- Regional HCFS hosts
- Item 8b recipient email-invite (console only)
- Uploads / Manage access on unsynced shared drive (#475)

## Notes

- Prefer finishing A+B solidly over half-baking C.
- Small focused commits; no Co-authored-by / Cursor / Made-with trailers.
- Main worktree `hippius-desktop` on `fix/overview-over-quota-ux` must stay untouched.
