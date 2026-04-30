# Shared Links Page Improvements — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the four shared-links improvements designed in
`docs/plans/2026-04-30-shared-links-page-improvements-design.md`:
clearer cross-device row UX (#1), local history of expired/revoked
links (#2), revoke confirmation (#3), and a more visible file badge
with expiry tooltip (#5).

**Architecture:** FE-only changes for #1, #3, #5. #2 adds a Rust
SQLite table (`shared_link_history`), three new IPC commands, and a
diff-on-list-shares capture mechanism. No hcfs-server changes.

**Tech Stack:** TypeScript (Next.js + Radix UI), Rust (Tauri 2.0,
sqlx, tracing). Tests with vitest (FE) and `cargo test` (Rust).

**Sequence rationale:** Lowest-risk FE-only items first (#1 → #3 →
#5), then the bigger Rust+FE history work (#2). Each task is its own
commit and is independently shippable.

**Workflow notes:**
- Build runs require `SQLX_OFFLINE=true` (per `CLAUDE.md`).
- Commit style matches existing log: `feat(shares): …`, `fix(shares):
  …`, `refactor(shares): …`.
- After each task: run task-local tests + commit. Don't run the full
  Rust test suite each step (it's slow); run scoped tests only and
  let CI catch global regressions.
- Manual verification matrix lives in the design doc — don't repeat
  it here, run through it once at the end.

---

## Task 1 — #1: Cross-device share row UX

**Files:**
- Modify: `app/(pages)/shares/page.tsx` (the `ShareRow` function ~135-198)
- Create: `app/(pages)/shares/__tests__/shareRowDisplay.test.ts`
- Create: `app/(pages)/shares/shareRowDisplay.ts`

### Step 1: Write the failing test for the display helper

Create `app/(pages)/shares/shareRowDisplay.ts` later — first the test.

`app/(pages)/shares/__tests__/shareRowDisplay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pickShareRowDisplay } from "../shareRowDisplay";
import type { ShareSummary } from "@/app/lib/tauri/shares";

const baseRow: ShareSummary = {
  shareToken: "tok",
  filename: "report.pdf",
  plaintextSize: 1024,
  ciphertextSize: 1100,
  mimeType: "application/pdf",
  createdAt: "2026-04-30T10:00:00Z",
  expiresAt: "2026-05-07T10:00:00Z",
  shareUrl: "https://share.example/abc#k=def",
  folderLabel: "default",
  relativePath: "report.pdf",
};

describe("pickShareRowDisplay", () => {
  it("returns the row's filename when shareUrl is present", () => {
    expect(pickShareRowDisplay(baseRow)).toEqual({
      text: "report.pdf",
      isPlaceholder: false,
    });
  });

  it("returns the cross-device placeholder when shareUrl is null", () => {
    expect(pickShareRowDisplay({ ...baseRow, shareUrl: null })).toEqual({
      text: "Shared from another device",
      isPlaceholder: true,
    });
  });

  it("treats hcfs-client's literal '<unknown>' marker as cross-device", () => {
    // Belt-and-suspenders: if `shareUrl` is somehow non-null but the
    // filename came back as the marker, still render the placeholder.
    expect(
      pickShareRowDisplay({ ...baseRow, filename: "<unknown>", shareUrl: null }),
    ).toEqual({ text: "Shared from another device", isPlaceholder: true });
  });
});
```

### Step 2: Run the test, confirm it fails

```
pnpm test --run app/\(pages\)/shares/__tests__/shareRowDisplay.test.ts
```

Expected: FAIL — `Cannot find module '../shareRowDisplay'`.

### Step 3: Implement the helper

`app/(pages)/shares/shareRowDisplay.ts`:

```ts
// Returns what to render in a share row's filename slot, plus whether
// it's a placeholder (so the caller can apply italic styling).
//
// Cross-device shares — minted on a different device or after a local
// DB wipe — surface from Rust with `shareUrl: null` because the local
// keystore doesn't have the `#k=<key>` fragment. hcfs-client's filename
// decryption uses the same keystore lookup, so the filename also
// collapses to the marker `<unknown>`. The user can still revoke; the
// placeholder explains why Copy and Reshare are disabled.

import type { ShareSummary } from "@/app/lib/tauri/shares";

const CROSS_DEVICE_PLACEHOLDER = "Shared from another device";

export interface ShareRowDisplay {
  text: string;
  isPlaceholder: boolean;
}

export function pickShareRowDisplay(row: ShareSummary): ShareRowDisplay {
  if (row.shareUrl === null) {
    return { text: CROSS_DEVICE_PLACEHOLDER, isPlaceholder: true };
  }
  return { text: row.filename, isPlaceholder: false };
}
```

### Step 4: Run the test, confirm it passes

```
pnpm test --run app/\(pages\)/shares/__tests__/shareRowDisplay.test.ts
```

Expected: PASS — 3 tests.

### Step 5: Wire into `ShareRow` and update tooltips

In `app/(pages)/shares/page.tsx`, replace the filename rendering and
the two disabled-button tooltips:

```tsx
// Top of file
import { pickShareRowDisplay } from "./shareRowDisplay";

// Inside ShareRow, replace the filename span:
const display = pickShareRowDisplay(row);
// ...
<span
  className={cn(
    "text-sm truncate",
    display.isPlaceholder
      ? "italic text-grey-50"
      : "font-medium text-grey-10",
  )}
  title={display.text}
>
  {display.text}
</span>

// Update the two disabled tooltip strings on the Copy and Reshare buttons:
title={
  row.shareUrl
    ? "Copy link"
    : "The link can only be copied from the device that created it."
}
// ...
title={
  canReshare
    ? "Revoke this link and mint a new one with a fresh expiry"
    : "Reshare requires the device that created this link."
}
```

### Step 6: Verify the page still type-checks

```
pnpm lint
```

Expected: 0 errors.

### Step 7: Commit

```bash
git add app/\(pages\)/shares/shareRowDisplay.ts \
        app/\(pages\)/shares/__tests__/shareRowDisplay.test.ts \
        app/\(pages\)/shares/page.tsx
git commit -m "feat(shares): clarify cross-device share rows on /shares page"
```

---

## Task 2 — #3: Revoke confirmation dialog

**Files:**
- Modify: `app/(pages)/shares/page.tsx`

This task has no extracted helper (the change is pure UI wiring on
`ConfirmDialog`, which is itself well-tested in its own component).
Manual verification at the end.

### Step 1: Add state for the pending-revoke token

In `MySharesPage`, near the existing `useQueryClient` line:

```tsx
const [tokenPendingRevoke, setTokenPendingRevoke] = React.useState<string | null>(null);
const [revokeBusy, setRevokeBusy] = React.useState(false);
```

### Step 2: Replace immediate revoke with a queue-then-confirm flow

Change the existing `onRevoke` to *queue* the token instead of firing
immediately. Add a new `confirmRevoke` that does the actual work:

```tsx
const queueRevoke = (token: string) => setTokenPendingRevoke(token);

const confirmRevoke = async () => {
  if (!tokenPendingRevoke) return;
  setRevokeBusy(true);
  try {
    await revokeShare(tokenPendingRevoke);
    toast.success("Share revoked");
    queryClient.invalidateQueries({ queryKey: [SHARES_QUERY_KEY, polkadotAddress] });
  } catch (err) {
    toast.error(`Could not revoke share: ${errorMessage(err)}`);
  } finally {
    setRevokeBusy(false);
    setTokenPendingRevoke(null);
  }
};
```

Update the `ShareRow` prop to call `queueRevoke` instead of the old
`onRevoke`. (Rename the prop or pass `queueRevoke` as `onRevoke` —
either works; pick the smaller diff.)

### Step 3: Render the dialog

Below the rows-rendering `<div>`:

```tsx
import ConfirmDialog from "@/components/ui/ConfirmDialog";

// ...
<ConfirmDialog
  open={tokenPendingRevoke !== null}
  onOpenChange={(open) => {
    if (!open) setTokenPendingRevoke(null);
  }}
  variant="danger"
  title="Revoke this link?"
  description="Anyone with the link will lose access immediately. This can't be undone."
  confirmText="Revoke"
  cancelText="Cancel"
  onConfirm={confirmRevoke}
  isLoading={revokeBusy}
/>
```

`ConfirmDialog`'s alert mode resolves the AlertTriangle icon and red
button itself when `variant="danger"` is set — no further wiring.

### Step 4: Lint + manual smoke

```
pnpm lint
```

Manual: `pnpm tauri:dev`, log in, mint a test share, press Revoke,
confirm the dialog appears. Press Cancel — row stays. Press Revoke
again, confirm — row disappears.

### Step 5: Commit

```bash
git add app/\(pages\)/shares/page.tsx
git commit -m "feat(shares): require confirmation before revoking a share"
```

---

## Task 3 — #5a: Badge visibility tweak

**Files:**
- Modify: `app/components/page-sections/files/SharedLinkBadge.tsx`

Pure CSS tweak — no test, manual verification.

### Step 1: Bump icon size and add pill background

Replace the existing `<span>` wrapper:

```tsx
<span
  className={cn(
    "inline-flex items-center justify-center text-primary-50 flex-shrink-0",
    "bg-primary-95 rounded-full p-1",
    className,
  )}
  aria-label="Shared via public link"
>
  <LinkIcon className="size-4" />
</span>
```

(`size-4` = 16px; was `size-3.5` = 14px.)

### Step 2: Lint + manual

```
pnpm lint
```

Manual: open file list with at least one shared file, scroll past it,
confirm the badge stands out without dominating. Check both list view
(`NameCell.tsx`) and card view (`FileCard.tsx`).

### Step 3: Commit

```bash
git add app/components/page-sections/files/SharedLinkBadge.tsx
git commit -m "fix(shares): make shared-link badge more visible in file rows"
```

---

## Task 4 — #5b: Badge expiry tooltip

**Files:**
- Create: `app/lib/utils/timeRelative.ts`
- Create: `app/lib/utils/__tests__/timeRelative.test.ts`
- Create: `app/components/page-sections/files/__tests__/sharedBadgeTooltip.test.ts`
- Create: `app/components/page-sections/files/sharedBadgeTooltip.ts`
- Modify: `app/lib/hooks/useSharedFiles.ts`
- Modify: `app/components/page-sections/files/SharedLinkBadge.tsx`
- Modify: `app/(pages)/shares/page.tsx` (replace inline `formatRelative`
  with the shared util)

### Step 1: Extract `formatRelative` to a shared util

`app/lib/utils/timeRelative.ts`:

```ts
// Coarse "in 4d" / "12m ago" / "<1m" formatter for RFC 3339 timestamps.
//
// Returns the original string if unparseable so a wire-format change
// upstream doesn't blank a row. Shared by the /shares page and the
// shared-link badge tooltip so both surfaces agree on phrasing.

export function formatRelative(rfc3339: string): string {
  const ms = Date.parse(rfc3339);
  if (Number.isNaN(ms)) return rfc3339;
  const diffMs = ms - Date.now();
  const abs = Math.abs(diffMs);
  const future = diffMs > 0;
  if (abs < 60_000) return future ? "in <1m" : "<1m ago";
  if (abs < 3_600_000) {
    const m = Math.round(abs / 60_000);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (abs < 86_400_000) {
    const h = Math.round(abs / 3_600_000);
    return future ? `in ${h}h` : `${h}h ago`;
  }
  const d = Math.round(abs / 86_400_000);
  return future ? `in ${d}d` : `${d}d ago`;
}
```

`app/lib/utils/__tests__/timeRelative.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRelative } from "../timeRelative";

const NOW = new Date("2026-04-30T12:00:00Z").getTime();

describe("formatRelative", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => vi.useRealTimers());

  it("returns '<1m ago' for very recent past", () => {
    expect(formatRelative("2026-04-30T11:59:30Z")).toBe("<1m ago");
  });

  it("returns 'in <1m' for very near future", () => {
    expect(formatRelative("2026-04-30T12:00:30Z")).toBe("in <1m");
  });

  it("returns minutes for sub-hour gaps", () => {
    expect(formatRelative("2026-04-30T12:05:00Z")).toBe("in 5m");
    expect(formatRelative("2026-04-30T11:55:00Z")).toBe("5m ago");
  });

  it("returns hours for sub-day gaps", () => {
    expect(formatRelative("2026-04-30T15:00:00Z")).toBe("in 3h");
  });

  it("returns days for >=1d gaps", () => {
    expect(formatRelative("2026-05-04T12:00:00Z")).toBe("in 4d");
  });

  it("returns the input string for unparseable values", () => {
    expect(formatRelative("not-a-date")).toBe("not-a-date");
  });
});
```

### Step 2: Run the test, confirm it passes (helper is fully written)

```
pnpm test --run app/lib/utils/__tests__/timeRelative.test.ts
```

Expected: PASS — 6 tests.

### Step 3: Migrate `shares/page.tsx` to the shared util

Delete the inline `formatRelative` at the bottom of `shares/page.tsx`
and import from the new util. Don't combine this with #5b's badge
work in the same commit — keep the refactor isolated.

### Step 4: Commit the refactor

```bash
git add app/lib/utils/timeRelative.ts \
        app/lib/utils/__tests__/timeRelative.test.ts \
        app/\(pages\)/shares/page.tsx
git commit -m "refactor(shares): extract formatRelative to shared util"
```

### Step 5: Extend `useSharedFiles` to expose matching rows

In `app/lib/hooks/useSharedFiles.ts`:

- Change `SharedIndex` from `Map<string, Set<string>>` to
  `Map<string, Map<string, ShareSummary[]>>` (label → relPath →
  rows). One file can have N active shares, so the leaf is an array.
- Add `getSharesFor(label, relPath): ShareSummary[]` to the result.
  Returns `[]` for unshared files.
- Keep `isShared` derived from `getSharesFor(...).length > 0`.

```ts
type SharedIndex = Map<string, Map<string, ShareSummary[]>>;

const EMPTY_INDEX: SharedIndex = new Map();

function buildIndex(rows: ShareSummary[]): SharedIndex {
  const index: SharedIndex = new Map();
  for (const row of rows) {
    if (!row.folderLabel || !row.relativePath) continue;
    let folder = index.get(row.folderLabel);
    if (!folder) {
      folder = new Map();
      index.set(row.folderLabel, folder);
    }
    const list = folder.get(row.relativePath);
    if (list) {
      list.push(row);
    } else {
      folder.set(row.relativePath, [row]);
    }
  }
  return index;
}

interface UseSharedFilesResult {
  isShared: (label?: string | null, relativePath?: string | null) => boolean;
  getSharesFor: (label?: string | null, relativePath?: string | null) => ShareSummary[];
  isLoading: boolean;
}
```

### Step 6: Build the tooltip text generator (TDD)

`app/components/page-sections/files/__tests__/sharedBadgeTooltip.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSharedBadgeTooltip } from "../sharedBadgeTooltip";
import type { ShareSummary } from "@/app/lib/tauri/shares";

const NOW = new Date("2026-04-30T12:00:00Z").getTime();

const row = (overrides: Partial<ShareSummary> = {}): ShareSummary => ({
  shareToken: "tok",
  filename: "f.pdf",
  plaintextSize: 0,
  ciphertextSize: 0,
  mimeType: "application/pdf",
  createdAt: "2026-04-30T10:00:00Z",
  expiresAt: "2026-05-04T12:00:00Z",
  shareUrl: "https://x#k=y",
  folderLabel: "default",
  relativePath: "f.pdf",
  ...overrides,
});

describe("buildSharedBadgeTooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => vi.useRealTimers());

  it("returns null for empty input (caller should not render badge)", () => {
    expect(buildSharedBadgeTooltip([])).toBeNull();
  });

  it("formats a single share with relative + absolute expiry", () => {
    const lines = buildSharedBadgeTooltip([row()]);
    expect(lines).toEqual([
      "Shared via public link · expires in 4d",
      // The exact absolute string is locale-dependent; assert the
      // shape rather than the literal output.
      expect.stringMatching(/^Expires .+/),
    ]);
  });

  it("formats multiple shares with count + soonest-expiry only", () => {
    const lines = buildSharedBadgeTooltip([
      row({ shareToken: "a", expiresAt: "2026-04-30T15:00:00Z" }),
      row({ shareToken: "b", expiresAt: "2026-05-06T12:00:00Z" }),
    ]);
    expect(lines).toEqual([
      "Shared via 2 public links · soonest expires in 3h",
    ]);
  });
});
```

`app/components/page-sections/files/sharedBadgeTooltip.ts`:

```ts
// Build the tooltip lines for the SharedLinkBadge.
//
// Single-share rows get a two-line tooltip: relative time on top,
// absolute on detail. Multi-share rows collapse to one line — count
// plus the soonest-expiring relative time. Stacking N timestamps would
// balloon the tooltip; the count + soonest is enough signal that the
// user should go to /shares for the full picture.

import type { ShareSummary } from "@/app/lib/tauri/shares";
import { formatRelative } from "@/app/lib/utils/timeRelative";

export function buildSharedBadgeTooltip(rows: ShareSummary[]): string[] | null {
  if (rows.length === 0) return null;

  if (rows.length === 1) {
    const [r] = rows;
    const absolute = new Date(r.expiresAt).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    return [
      `Shared via public link · expires ${formatRelative(r.expiresAt)}`,
      `Expires ${absolute}`,
    ];
  }

  const soonest = rows.reduce((acc, r) =>
    Date.parse(r.expiresAt) < Date.parse(acc.expiresAt) ? r : acc,
  );
  return [
    `Shared via ${rows.length} public links · soonest expires ${formatRelative(soonest.expiresAt)}`,
  ];
}
```

### Step 7: Run the tooltip tests, confirm green

```
pnpm test --run app/components/page-sections/files/__tests__/sharedBadgeTooltip.test.ts
```

Expected: PASS — 3 tests.

### Step 8: Wire the tooltip into `SharedLinkBadge`

In `app/components/page-sections/files/SharedLinkBadge.tsx`:

- Pull `getSharesFor` from `useSharedFiles` instead of `isShared`.
- Compute `rows = getSharesFor(label, actualName)`.
- Compute `tooltipLines = buildSharedBadgeTooltip(rows)`. If null,
  return `null`.
- Replace the static `Tooltip.Content` text with the lines, joined by
  a `<br />` (or stack in two `<div>`s).

```tsx
const rows = getSharesFor(label, actualName);
const tooltipLines = buildSharedBadgeTooltip(rows);
if (!tooltipLines) return null;
// ...
<Tooltip.Content ... >
  {tooltipLines.map((line, i) => (
    <div key={i}>{line}</div>
  ))}
  <Tooltip.Arrow className="fill-white" />
</Tooltip.Content>
```

### Step 9: Lint + run the relevant FE tests

```
pnpm lint
pnpm test --run app/lib/utils/__tests__/timeRelative.test.ts \
                app/components/page-sections/files/__tests__/sharedBadgeTooltip.test.ts
```

Expected: 0 lint errors, all tests pass.

### Step 10: Commit

```bash
git add app/lib/hooks/useSharedFiles.ts \
        app/components/page-sections/files/sharedBadgeTooltip.ts \
        app/components/page-sections/files/__tests__/sharedBadgeTooltip.test.ts \
        app/components/page-sections/files/SharedLinkBadge.tsx
git commit -m "feat(shares): show expiry in shared-link badge tooltip"
```

---

## Task 5 — #2 backend: history table + diff + commands

**Files:**
- Modify: `src-tauri/src/utils/schema.rs`
- Create: `src-tauri/src/shares/history.rs`
- Modify: `src-tauri/src/shares/mod.rs`
- Modify: `src-tauri/src/shares/commands.rs`
- Modify: `src-tauri/src/main.rs` (register new commands)

This is the largest task; it splits cleanly into sub-tasks.

### Step 1: Add `shared_link_history` table to schema

In `src-tauri/src/utils/schema.rs`:

1. Append the table to `TABLE_SCHEMAS`:

```rust
(
    "shared_link_history",
    &[
        ("account_id", "TEXT NOT NULL"),
        ("share_token", "TEXT NOT NULL"),
        ("filename", "TEXT"),
        ("folder_label", "TEXT"),
        ("relative_path", "TEXT"),
        ("plaintext_size", "INTEGER"),
        ("mime_type", "TEXT"),
        ("created_at", "TEXT NOT NULL"),
        ("expires_at", "TEXT NOT NULL"),
        ("ended_at", "TEXT NOT NULL"),
        ("end_reason", "TEXT NOT NULL"),
        ("PRIMARY KEY", "(account_id, share_token)"),
    ],
),
```

(Check whether the existing `TABLE_SCHEMAS` macro supports a
`PRIMARY KEY` row. If not, add the table via a `CREATE TABLE` block
in the imperative section instead, mirroring how `share_origin` is
declared.)

2. Add `"shared_link_history"` to `EXPECTED_TABLES`.

### Step 2: Run the schema smoke tests

```
SQLX_OFFLINE=true cargo test -p hippius-desktop schema::tests::ensure_table_schema_creates_all_expected_tables \
  schema::tests::ensure_table_schema_is_idempotent
```

Expected: PASS — both tests green.

### Step 3: Define the history record type and `record_event`

`src-tauri/src/shares/history.rs`:

```rust
//! Local history of expired/revoked share links.
//!
//! Per-device snapshot table. Rows enter via three triggers:
//! - active-row's `expires_at` passes (`expired`)
//! - this device revokes via `hcfs_revoke_share` (`revoked_here`)
//! - active row vanishes from server's list before its TTL
//!   (`revoked_elsewhere`)
//!
//! Cleanup is user-driven: per-row `remove_one` and bulk
//! `clear_all`. Server is never touched — these tokens are already
//! dead server-side.

use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    Expired,
    RevokedHere,
    RevokedElsewhere,
}

impl EndReason {
    pub fn as_str(self) -> &'static str {
        match self {
            EndReason::Expired => "expired",
            EndReason::RevokedHere => "revoked_here",
            EndReason::RevokedElsewhere => "revoked_elsewhere",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub share_token: String,
    pub filename: Option<String>,
    pub folder_label: Option<String>,
    pub relative_path: Option<String>,
    pub plaintext_size: Option<i64>,
    pub mime_type: Option<String>,
    pub created_at: String,
    pub expires_at: String,
    pub ended_at: String,
    pub end_reason: EndReason,
}

/// Idempotent upsert. Re-recording the same `(account_id, share_token)`
/// with a newer `ended_at` overwrites — that matters when an
/// `expired` row is later revealed to actually be `revoked_elsewhere`
/// (or vice versa) on the next poll.
pub async fn record_event(/* … */) -> Result<(), sqlx::Error> { /* … */ }

pub async fn list_for_account(/* … */) -> Result<Vec<HistoryEntry>, sqlx::Error> { /* … */ }

pub async fn remove_one(/* … */) -> Result<(), sqlx::Error> { /* … */ }

pub async fn clear_all_for_account(/* … */) -> Result<(), sqlx::Error> { /* … */ }
```

Fill in the bodies with `INSERT INTO shared_link_history ... ON CONFLICT
(account_id, share_token) DO UPDATE SET ...` for `record_event` and
straightforward queries for the rest.

### Step 4: Write the diff function with TDD

In the same `history.rs` (or a sibling `diff.rs`):

```rust
/// Compute history events from two consecutive lists of active
/// summaries.
///
/// `now` is parameterised so tests can pin the clock; production uses
/// `chrono::Utc::now()`.
pub fn diff_active_lists(
    previous: &[ShareSummary],
    current: &[ShareSummary],
    now: chrono::DateTime<chrono::Utc>,
) -> Vec<HistoryEvent> { /* … */ }

pub struct HistoryEvent { /* token, end_reason, ended_at, snapshot fields */ }
```

Tests (in `history.rs` `#[cfg(test)] mod tests`):

```rust
#[test]
fn no_diff_for_unchanged_lists() {
    let now = chrono::Utc::now();
    let row = mk_summary("tok", "+1d");
    let events = diff_active_lists(&[row.clone()], &[row], now);
    assert!(events.is_empty());
}

#[test]
fn row_removed_after_expiry_is_expired() {
    let now = chrono::Utc::now();
    let row = mk_summary("tok", "-1m"); // already expired
    let events = diff_active_lists(&[row], &[], now);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].end_reason, EndReason::Expired);
}

#[test]
fn row_removed_before_expiry_is_revoked_elsewhere() {
    let now = chrono::Utc::now();
    let row = mk_summary("tok", "+1d"); // still future
    let events = diff_active_lists(&[row], &[], now);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].end_reason, EndReason::RevokedElsewhere);
}

#[test]
fn idempotent_upsert_under_repeat_diffs() {
    // Two consecutive diffs that produce the same event must result
    // in a single history row.
    let now = chrono::Utc::now();
    let row = mk_summary("tok", "-1m");
    let first = diff_active_lists(&[row.clone()], &[], now);
    let second = diff_active_lists(&[row], &[], now);
    assert_eq!(first.len(), 1);
    assert_eq!(second.len(), 1);
    // Caller upserts both into the same PRIMARY KEY — record_event
    // covers idempotency. This test pins the diff alone.
}
```

(`mk_summary("tok", "+1d")` is a small helper that builds a fake
`ShareSummary` with `expires_at = now + offset`. Define it in the
test module.)

### Step 5: Run the history tests

```
SQLX_OFFLINE=true cargo test -p hippius-desktop shares::history
```

Expected: PASS.

### Step 6: Wire the diff into `hcfs_list_shares`

In `src-tauri/src/shares/commands.rs`'s `hcfs_list_shares`:

- After the existing `summaries` is built but before the prune call,
  load the previous active set from `shared_link_history` (or from
  an in-memory cache keyed by account; use whichever shape is
  cleaner — TBD during implementation).
- Compute `diff_active_lists(previous, current, Utc::now())`.
- Upsert each event into `shared_link_history` via `record_event`.
- Update the previous-set cache so the *next* call has the right
  baseline.

The "previous active set" needs to live somewhere. Two options —
pick during implementation:

1. A new `shared_link_active_snapshot` table written every time
   `hcfs_list_shares` returns. Survives restarts.
2. An in-memory `HashMap<account_id, Vec<ShareSummary>>` on
   `AppState`. Lost on restart, but if a row vanishes during a
   restart we just lose the diff — acceptable trade-off, much
   simpler.

Option 2 is simpler and the lost-on-restart caveat is small. Use it
unless the implementation surfaces a reason to persist.

### Step 7: Snapshot on `hcfs_revoke_share` success

Before the existing success branch in `hcfs_revoke_share`:

- Load the row from the in-memory snapshot (if present) for filename
  + paths + timestamps.
- After the server revoke succeeds, call `record_event` with
  `end_reason = RevokedHere` and `ended_at = Utc::now()`.

If the in-memory snapshot doesn't have the row (rare race: revoke
fired before the first list_shares of the session), record a minimal
entry with `share_token` + `ended_at` + `end_reason` and `NULL`s for
the rest. The history row is informational; partial data is fine.

### Step 8: Add the three new IPC commands

In `src-tauri/src/shares/commands.rs`:

```rust
#[tauri::command]
pub async fn hcfs_list_share_history(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<HistoryEntry>> {
    let account_id = state.current_account_id().map_err(AppError::Other)?;
    let pool = state.pool()?;
    history::list_for_account(pool, &account_id).await.map_err(AppError::from)
}

#[tauri::command]
pub async fn hcfs_remove_share_history(
    state: tauri::State<'_, AppState>,
    share_token: String,
) -> Result<()> {
    let account_id = state.current_account_id().map_err(AppError::Other)?;
    let pool = state.pool()?;
    history::remove_one(pool, &account_id, &share_token).await.map_err(AppError::from)
}

#[tauri::command]
pub async fn hcfs_clear_share_history(
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let account_id = state.current_account_id().map_err(AppError::Other)?;
    let pool = state.pool()?;
    history::clear_all_for_account(pool, &account_id).await.map_err(AppError::from)
}
```

### Step 9: Register the new commands in `main.rs`

Append to the `tauri::generate_handler![ ... ]` list:

```rust
hcfs_list_share_history,
hcfs_remove_share_history,
hcfs_clear_share_history,
```

### Step 10: Run the full shares Rust test suite

```
SQLX_OFFLINE=true cargo test -p hippius-desktop shares
SQLX_OFFLINE=true cargo clippy --all -- -D warnings
```

Expected: 0 failures, 0 clippy warnings.

### Step 11: Commit

```bash
git add src-tauri/src/utils/schema.rs \
        src-tauri/src/shares/history.rs \
        src-tauri/src/shares/mod.rs \
        src-tauri/src/shares/commands.rs \
        src-tauri/src/main.rs
git commit -m "feat(shares): record history of expired and revoked links"
```

---

## Task 6 — #2 frontend: history section on `/shares`

**Files:**
- Create: `app/lib/tauri/shareHistory.ts`
- Modify: `app/(pages)/shares/page.tsx`

### Step 1: Typed wrapper for the new IPCs

`app/lib/tauri/shareHistory.ts`:

```ts
// Typed wrappers around the share-history IPCs added in
// `src-tauri/src/shares/commands.rs`. Per-device history of expired
// and revoked links — see the design doc for the capture model.

import { invoke } from "@tauri-apps/api/core";

export type HistoryEndReason = "expired" | "revoked_here" | "revoked_elsewhere";

export interface ShareHistoryEntry {
  shareToken: string;
  filename: string | null;
  folderLabel: string | null;
  relativePath: string | null;
  plaintextSize: number | null;
  mimeType: string | null;
  createdAt: string;
  expiresAt: string;
  endedAt: string;
  endReason: HistoryEndReason;
}

export async function listShareHistory(): Promise<ShareHistoryEntry[]> {
  return invoke<ShareHistoryEntry[]>("hcfs_list_share_history");
}

export async function removeShareHistory(shareToken: string): Promise<void> {
  await invoke<void>("hcfs_remove_share_history", { shareToken });
}

export async function clearShareHistory(): Promise<void> {
  await invoke<void>("hcfs_clear_share_history");
}
```

### Step 2: Add history query + section to `/shares`

In `app/(pages)/shares/page.tsx`:

- Add a `HISTORY_QUERY_KEY = "shares-history-list"` and a separate
  `useQuery` calling `listShareHistory`. Same `refetchInterval`.
  Invalidate on revoke success and on any "remove from history"
  operation.
- After the active list, render a new section:

```tsx
{shareEnabled && historyData && historyData.length > 0 && (
  <>
    <div className="flex items-center justify-between mt-6 mb-2">
      <h2 className="text-sm font-semibold text-grey-30">History</h2>
      <button
        onClick={() => setClearAllOpen(true)}
        className="text-xs text-grey-50 hover:text-grey-10"
      >
        Clear all history
      </button>
    </div>
    <div className="flex flex-col gap-2">
      {historyData.map((entry) => (
        <HistoryRow
          key={entry.shareToken}
          entry={entry}
          onRemove={onRemoveHistory}
        />
      ))}
    </div>
  </>
)}
```

### Step 3: Implement `HistoryRow`

A trimmed version of `ShareRow`:

- Same icon/title/subtitle structure.
- Filename uses the same `pickShareRowDisplay` helper from Task 1
  (extend it to accept `filename: string | null` for the history
  shape — `null` ⇒ "Shared from another device").
- Status badge: `Expired` (grey-90), `Revoked` (error-95), or
  `Revoked elsewhere` (grey-90 + italic).
- Actions: only **Remove from history**. Confirmation is light (no
  dialog) — history removal is fully reversible (it'll snapshot
  again on the next diff if the row is still relevant).

### Step 4: Add `Clear all history` confirmation

Reuse `ConfirmDialog`:

```tsx
<ConfirmDialog
  open={clearAllOpen}
  onOpenChange={setClearAllOpen}
  variant="warning"
  title="Clear all share history?"
  description={`This removes ${historyData?.length ?? 0} entries from this device's history. The shares are already revoked or expired — this only clears the local list.`}
  confirmText="Clear history"
  cancelText="Cancel"
  onConfirm={async () => {
    await clearShareHistory();
    queryClient.invalidateQueries({ queryKey: [HISTORY_QUERY_KEY, polkadotAddress] });
  }}
/>
```

### Step 5: Lint + manual smoke

```
pnpm lint
```

Manual: run through the verification matrix in the design doc, focus
on the "row vanishes / row expires / clear all" rows.

### Step 6: Commit

```bash
git add app/lib/tauri/shareHistory.ts \
        app/\(pages\)/shares/page.tsx
git commit -m "feat(shares): show history of expired and revoked links on /shares"
```

---

## Final pass

### Step 1: Run all shares-related tests once

```
pnpm test --run \
  app/\(pages\)/shares/__tests__/shareRowDisplay.test.ts \
  app/lib/utils/__tests__/timeRelative.test.ts \
  app/components/page-sections/files/__tests__/sharedBadgeTooltip.test.ts

SQLX_OFFLINE=true cargo test -p hippius-desktop shares
SQLX_OFFLINE=true cargo clippy --all -- -D warnings
```

### Step 2: Manual matrix from the design doc

Run the full verification table in the design doc — especially the
rows that exercise interactions between #1 (cross-device labels) and
#2 (history rows for cross-device shares).

### Step 3: Push and open PR

```bash
git push -u origin shared-links-improvements
gh pr create --base main --title "Shared Links page improvements" \
  --body "Implements the four items in docs/plans/2026-04-30-shared-links-page-improvements-design.md."
```
