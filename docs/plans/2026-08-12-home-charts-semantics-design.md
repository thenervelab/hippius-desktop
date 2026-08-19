# Home page charts: correct semantics

**Date:** 2026-08-12
**Status:** implemented

## Problem

Both charts on the home page plot something other than what their card says.

### Left card — "Available Credits"

The headline is the live credit balance (`get_user_credits` → billing API
`/api/billing/credits/balance/`). The chart underneath is
`get_drive_credits_chart`, which reads the indexer's
`/user-credits-by-storage-history?storage_type=drive` event feed, filters to
`CreditsConsumed`, and **cumulatively sums** it
(`src-tauri/src/billing/drive_credits.rs:194`).

So a card titled "Available Credits" draws a *rising cumulative spend* curve.
The two numbers move in opposite directions by construction.

**Wanted:** a declining line that is, at every point, the credits available then.

### Right card — "Storage Usage"

`get_drive_storage_chart` already returns the daily *level* of `drive_files_size`
— latest snapshot per day, carry-forwarded across quiet days. That is the
cumulative curve we want. The frontend then **diffs it back into per-day
deltas** (`storageDeltaUtils.ts:54`, `cumulativeToDeltas`) to draw
"bytes added on day N" bars, and clamps negatives to zero so deletions vanish.

**Wanted:** the cumulative total — each upload adds to the previous value.
The backend already produces it; the frontend undoes it.

## Data sources (verified, not assumed)

| Need | Where it lives | Verified |
|---|---|---|
| Credit balance history | indexer `/credits/free-credits` → table `credits_free_credits` | `hippius-indexer-api/src/api/credits.rs:69`, SQL at `src/db/repositories.rs:2280` |
| That table being written | `credits_free_credits_profiles_poller_v2_consumer.ts`, 8s poll | `hippius-indexer/src/consumers/…:119` |
| Storage level history | indexer `/user-extended-storage-metrics?storage=drive` | already in use by `drive_storage.rs` |

The poller inserts a row **only when the balance actually changes**
(`WHERE latest.last_credits IS DISTINCT FROM c.credits`). So
`credits_free_credits` is a compact balance change-log, not an 8s sample
stream. Two consequences the implementation depends on:

- Quiet days have **no rows**, so the chart must carry the last known balance
  forward. This is the same shape as the storage chart, not the credits-spend
  chart (which accumulates).
- Row volume per account is low, so paging the whole history is cheap.

`credits` is a Postgres `NUMERIC` surfaced as `bigdecimal::BigDecimal`, which
serializes through `collect_str` — a JSON **string** of planck units. The
desktop's existing (currently unused) `CreditRow` already types it as
`Option<String>`, which is correct.

**Scope: desktop-only.** No indexer, console, hcfs, or chain change is needed.

## Known risk

The headline comes from the billing API (`{"balance": "1.5"}`, HIP units); the
chart comes from the indexer's chain-derived free credits. These *should* be the
same quantity, but the billing service is not in any local repo, so agreement is
unproven. If they diverge, the line will not land exactly on the headline.

Mitigation: verify against a live account as the first implementation step. A
divergence is still fixable desktop-side (point the headline at the same
source). This is called out rather than assumed because "tile and chart disagree"
is a defect class this repo has already fought twice — see the module docs on
`drive_storage.rs:1-19`.

## Backend design

### New: `src-tauri/src/billing/credit_balance.rs`

`get_credit_balance_chart(account_id, range) -> Vec<ChartPoint>`.

Deliberately modelled on `drive_storage.rs`, because the problem is identical —
a *level* series assembled from paginated indexer snapshots:

- Paginated walk with a `MAX_PAGES` safety cap. No process-wide cache — see
  evaluation finding E1.
- Parse `credits` planck string → HIP; sort by **full timestamp** ascending.
  Sorting by date alone is insufficient for the same reason documented at
  `drive_storage.rs:172`: `sort_by_key` is stable, so equal-date rows would keep
  the indexer's `block_number DESC` order and the collapse would keep the
  *oldest* reading of each day.
- Collapse to one point per day keeping the **latest** reading, then
  carry-forward.
- Seed from the latest reading strictly before the window, so a window opening
  on a quiet day shows the balance already in place rather than 0.
- Clamp the window start to the first real row (`data_start`), mirroring
  `drive_credits.rs:218` — otherwise `MAX` paints a flat plateau back to the
  hardcoded 2025-03-11 service-creation date.

### Changed: `drive_storage.rs`

Add the same `data_start` clamp to `build_storage_chart`. It is currently
absent, and only becomes *visible* once we stop drawing bars: on `MAX` / `1 YEAR`
the line would trail a long flat-zero prefix back to 2025 before the first
snapshot. The bar downsampler was hiding it.

### Changed: `charts.rs`

Two helpers move here so the new module does not duplicate them:

- `planck_str_to_credits` (from `drive_credits.rs`) — one planck→HIP parse with
  one `warn!` on malformed input.
- `parse_timestamp_to_datetime` (from `drive_storage.rs`) — the full-instant
  sister of `parse_timestamp_to_date`.

Both are lifted, not copied; the original call sites import from `charts.rs`.

### Unchanged: `drive_credits.rs`

The Billing page's chart is titled **"Drive Credit Usage"** — cumulative spend is
the correct semantics there. `get_drive_credits_chart` keeps serving it, so
nothing is orphaned by this change.

## Frontend design

- **New** `useCreditBalanceChart.ts` → `get_credit_balance_chart`, exporting
  `CREDIT_BALANCE_CHART_QUERY_KEY`. Same range options as today.
- **`available-credits/index.tsx`** — swap the hook; update the info tooltip and
  `tooltipValueLabel` ("Drive credits used" → "Available credits"), since the
  chart is no longer drive-scoped spend.
- **`storage-usage-bars/index.tsx`** — render `chartData` straight into the
  shared area chart. Drops `buildStorageDeltaBars`, `getBarCount` and
  `useIsNarrow`. The directory is renamed `storage-usage`, since after this it
  draws no bars and the old name would misdirect the next reader.
- **Delete** `storageDeltaUtils.ts` and `StorageBarChart.tsx` (~220 lines of
  delta/monthly-aggregation/downsampling machinery that existed only to feed
  bars). `StorageRange` moves to `useDriveStorageChart.ts`.

### Ripples found while scoping

1. `app/lib/utils/__tests__/chartAnimation.test.ts:55` is a **source-inspection
   wiring pin** that `readFileSync`s `StorageBarChart.tsx`; deleting the file
   makes it throw `ENOENT`. Its `charts` array must drop that entry.
2. `useSyncEvents.ts:145` invalidates the storage chart after a sync — the new
   credit-balance key belongs there too, since uploads spend credits.
3. `CreditGraph.tsx:93` tells users its figure is "the same figure as the home
   page". That stops being true; copy fix.

## Design evaluation

A critical pass over the above, before implementing. Seven findings; five changed
the design.

**E1 — Drop the single-flight cache from the new module.** `drive_credits.rs`
justifies its process-wide cache by three commands sharing one fetch. The new
module has exactly one consumer, and the FE hook's `staleTime: 30_000` already
prevents refetch storms. Adding the cache would also add a *third* module-level
`OnceLock` static, which is a standing audit finding against `AppState`
centralisation. Cut it.

**E2 — No float round-trip when formatting.** `drive_credits.rs:254` reconstructs
a planck string from an f64 (`(clamped * 1e18) as u128`) because its source is a
summed f64. Our source *is already* a planck string, so `format_balance(raw, 6)`
can be called on it directly. f64 is then only needed for plot geometry. Strictly
better precision and less code.

**E3 — The shared chart needs a `yTickFormat` prop (UI regression, caught late).**
`AvailableCreditsChart` renders y-axis labels through its own
`formatYTickValue`, which abbreviates with **credit** units (`K`/`M`, line 67).
Feeding it bytes would label 53 GB as `53809.1M`. `StorageBarChart` avoided this
with a `yTickFormat={(v) => formatBytes(v, 1)}` prop. So reusing the area chart
requires adding an optional `yTickFormat`, threaded into `computeYAxisWidth` too
(axis width is derived from label length, and `"53.8 GB"` is wider than a bare
number). Without this the right card ships with a wrong axis.

**E4 — `get_credits` becomes dead code and should go.** It reads the *same*
`/credits/free-credits` endpoint, has no frontend caller (verified), and is fully
superseded by the new command. Leaving it means two divergent parsers of one
endpoint. Delete it and its `main.rs` registration. (`format_credits_chart` is
also unused, but for unrelated reasons — flagged, not touched.)

**E5 — Single-point series is safe.** An account whose balance has never changed
has one row, so the clamped window yields one point. The chart already handles
this (`len === 1` centres the point, line 214). Accepted, no work.

**E6 — OFFSET pagination over a live-appending table** can skip or duplicate a
row across page boundaries while the 8s poller inserts. Tolerable: we collapse to
one reading per day, so a lost intra-day row changes nothing. Identical property
to the existing storage chart. No work.

**E7 — The line is not *strictly* declining, and shouldn't be.** A top-up
(`MintedAccountCredits`) steps it up. This satisfies the actual requirement —
"always is the available credits" — but is worth stating so the upward step is
not later filed as a regression.

**E8 — (found during implementation) the new command needed a session guard.**
`tests/account_authority_guard.rs` failed on first run: the command took a
frontend-supplied `account_id` and queried the indexer with it, so a crafted IPC
call could read another account's balance history. The sibling chart commands are
allowlisted there on the grounds that the FE sends the header-selected
`activeWallet` — but that rationale does not hold for this one, because
`useCreditBalanceChart` leaves `addressSource` at its `"auth"` default and only
ever sends the session address. So the fix was to *guard* it
(`require_session_account`), not to extend the allowlist. Deleting `get_credits`
also left two stale allowlist entries, now removed.

## Testing

Rust, inline per module convention:

- latest-reading-of-day collapse (fed in shuffled order, so a date-only sort
  fails it)
- sub-second timestamp ordering
- pre-window seed carry-forward
- `data_start` clamp on `MAX` for both the new module and `drive_storage`
- real-payload deserialization pin (planck-as-string, null `credits`)
- a declining-balance shape assertion: spend-only history is non-increasing

Frontend:

- `chartAnimation.test.ts` pin updated
- a test that the storage card renders the cumulative level rather than deltas,
  so the FE cannot silently reintroduce the diff
