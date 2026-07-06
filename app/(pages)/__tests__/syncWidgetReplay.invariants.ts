/**
 * Replay-harness primitives for the sync widget.
 *
 * The widget's recurring defects (AUDIT_SYNC_WIDGET_2026-06-22.md) are not
 * "does a button work" bugs — they are data-projection bugs that only surface
 * across a *sequence* of snapshot frames (a stuck-high smoothed percent, a
 * header byte source that diverges from the ring, a stale frame that freezes).
 * Single hand-built-snapshot tests (SyncStatusDialog.test.tsx) cannot reach
 * them because the author builds the one frame they already understand.
 *
 * This module supplies the pieces a replay test needs:
 *   - {@link ReplaySession} — the fixture shape (also what the dev recorder
 *     in `app/lib/sync/syncEventRecorder.ts` dumps, so a REAL captured session
 *     drops straight in).
 *   - DOM readers that pull the user-visible numbers out of the rendered card.
 *   - per-frame invariants that must hold after EVERY frame of any replay.
 *
 * It is deliberately free of React/Tauri imports so the invariants can be
 * reasoned about (and unit-tested) in isolation from the mount harness.
 */
import { selectLiveTransferBytes } from "../syncStatusDialogLogic";
import { formatBytes } from "@/lib/utils/formatBytes";
import type { SyncSnapshot } from "@/lib/types/syncSnapshot";

/**
 * One recorded/scenario sync session: the bootstrap snapshot the widget seeds
 * from (`sp_get_snapshot`, may be null/absent) followed by the ordered stream
 * of `sync_progress_snapshot` event payloads. Replaying `frames` in order
 * through the real listener reproduces exactly what the backend pushed.
 */
export interface ReplaySession {
  seed: SyncSnapshot | null;
  frames: SyncSnapshot[];
}

/** Mirror of the dialog's private `formatCompactBytes` (formatBytes, spaces
 *  stripped). Kept here so an invariant can recompute the EXACT string the
 *  header must show without importing the component. */
export function compactBytes(value: number): string {
  return formatBytes(value).replace(/\s+/g, "");
}

/** The ring's percent label as the user reads it: a number (0–100),
 *  `"indeterminate"` for the "--" pulsing state, or null if no ring is on
 *  screen (minimized/hidden). */
export type RingReading = number | "indeterminate" | null;

export function readRingPercent(container: HTMLElement): RingReading {
  const label = container.querySelector(
    '[data-testid="overall-progress-label"]',
  );
  const text = label?.textContent?.trim();
  if (!text) return null;
  if (text === "--") return "indeterminate";
  const match = text.match(/^(\d+)%$/);
  return match ? Number(match[1]) : null;
}

/**
 * The header "transferred / total" line ("41.6MB/260.07MB"), or null when it
 * isn't shown. Distinguished from the per-file meta ("2.5MB / 5MB", which has
 * spaces around the slash and only renders in the expanded body) and from the
 * speed text ("4.03MB/s", no leading digit after the slash) by requiring a
 * digit-led byte token on BOTH sides of a space-less slash.
 */
const TRANSFER_LINE = /^\d[\d.]*[A-Za-z]+\/\d[\d.]*[A-Za-z]+$/;

export function readTransferLine(container: HTMLElement): string | null {
  for (const span of Array.from(container.querySelectorAll("span"))) {
    const text = span.textContent?.trim() ?? "";
    if (TRANSFER_LINE.test(text)) return text;
  }
  return null;
}

/** A single invariant breach: which rule, on which frame, and the detail. */
export interface InvariantViolation {
  rule: string;
  detail: string;
}

/**
 * Invariants that must hold after rendering ANY single frame, regardless of
 * the session. Each targets a confirmed audit bug:
 *
 *   - BYTE_SOURCE (Bug 1, the "0B / 16%" screenshot): the rendered header
 *     transferred/total, whenever shown, must be sourced from
 *     `selectLiveTransferBytes` (progressBytes/bytesExpected — the SAME pair
 *     the ring is weighted on). Rerouting it to the intent overlay (reads 0B
 *     mid-file) or the doubled `combined*` total breaks this exact-string
 *     equality.
 *   - RING_RANGE: the ring never shows a nonsensical percent (NaN, negative,
 *     >100). A guard against smoothing/format regressions.
 *   - COMPLETE_AT_100 (Bug 7 tail): once the backend marks the session
 *     effectively complete, the ring must read 100 — never a stale
 *     high/low-water mark left by the smoother.
 */
export function checkFrameInvariants(
  container: HTMLElement,
  snapshot: SyncSnapshot,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const ring = readRingPercent(container);
  const transfer = readTransferLine(container);

  if (transfer !== null) {
    const bytes = selectLiveTransferBytes(snapshot);
    // The component only renders this line when selectLiveTransferBytes is
    // non-null, so a rendered line with a null source is itself a breach.
    if (!bytes) {
      violations.push({
        rule: "BYTE_SOURCE",
        detail: `header shows "${transfer}" but selectLiveTransferBytes(snapshot) is null`,
      });
    } else {
      const expected = `${compactBytes(bytes.progress)}/${compactBytes(bytes.expected)}`;
      if (transfer !== expected) {
        violations.push({
          rule: "BYTE_SOURCE",
          detail: `header shows "${transfer}", expected "${expected}" (progressBytes=${snapshot.progressBytes}, bytesExpected=${snapshot.bytesExpected})`,
        });
      }
    }
  }

  if (typeof ring === "number" && (ring < 0 || ring > 100)) {
    violations.push({
      rule: "RING_RANGE",
      detail: `ring shows ${ring}% (outside 0–100)`,
    });
  }

  if (snapshot.effectiveCompleted && ring !== 100 && ring !== null) {
    violations.push({
      rule: "COMPLETE_AT_100",
      detail: `snapshot.effectiveCompleted but ring shows ${ring}`,
    });
  }

  return violations;
}

// ── Scenario fixtures ──────────────────────────────────────────────────────
//
// Hand-authored sequences that encode the *triggering shape* of each audit
// bug (traced from production code in AUDIT_SYNC_WIDGET_2026-06-22.md). These
// have teeth today via the cross-frame stateful bugs; once the dev recorder
// captures a real session, that JSON drops in beside these with no harness
// change.

const SESSION_TS = 1_700_000_000_000;

/** Base snapshot with the fields the harness varies; everything else inert. */
function frame(over: Partial<SyncSnapshot>): SyncSnapshot {
  return {
    isActive: true,
    overallPercent: 0,
    progressBytes: 0,
    bytesExpected: 0,
    totalFiles: 1,
    completedFiles: 0,
    failedFiles: 0,
    retryInSecs: 0,
    lastError: null,
    expectedUploads: 1,
    expectedDownloads: 0,
    expectedLocalDeletes: 0,
    expectedRemoteDeletes: 0,
    startedAt: SESSION_TS,
    completedAt: null,
    files: [],
    widgetState: "active",
    widgetVisible: true,
    combinedProgressBytes: 0,
    combinedBytesExpected: 0,
    deletedCount: 0,
    syncedCount: 0,
    actualTotal: 1,
    statusVariant: "progress",
    syncDirection: "upload",
    effectiveInProgress: true,
    effectiveCompleted: false,
    ...over,
  };
}

/** One in-flight file row at a given byte position (drives `hasActiveFile`
 *  so the header transfer line is shown). */
function inFlightFile(
  name: string,
  transferred: number,
  total: number,
): SyncSnapshot["files"][number] {
  return {
    path: `/${name}`,
    fileName: name,
    label: "default",
    action: "upload",
    status: "inProgress",
    progressPercent: total > 0 ? Math.round((transferred / total) * 100) : 0,
    bytesEncrypted: 0,
    bytesTransferred: transferred,
    totalBytes: total,
  };
}

/**
 * BUG 1 as a stream: a single 260 MB upload climbing 0 → 100 %. At every
 * non-trivial position the intent overlay still reports 0 completed bytes
 * (no whole file done), so a regression that sourced the header from the
 * intent overlay would render "0B/260.07MB" while the ring climbs — the exact
 * screenshot. The BYTE_SOURCE invariant pins the header to the byte-granular
 * pair on every frame.
 */
export function scenarioSingleLargeUpload(): ReplaySession {
  const TOTAL = 260_070_000;
  const positions = [0, 0.05, 0.16, 0.47, 0.88];
  const frames = positions.map((p) => {
    const transferred = Math.round(TOTAL * p);
    return frame({
      overallPercent: Math.round(p * 100),
      progressBytes: transferred,
      bytesExpected: TOTAL,
      combinedProgressBytes: transferred,
      combinedBytesExpected: TOTAL * 2,
      files: [inFlightFile("Air-261.dmg", transferred, TOTAL)],
      intentTotalFiles: 1,
      intentCompletedFiles: 0,
      intentTotalBytes: TOTAL,
      intentCompletedBytes: 0,
      intentActive: true,
    });
  });
  const done = frame({
    isActive: false,
    overallPercent: 100,
    progressBytes: TOTAL,
    bytesExpected: TOTAL,
    combinedProgressBytes: TOTAL * 2,
    combinedBytesExpected: TOTAL * 2,
    totalFiles: 1,
    completedFiles: 1,
    syncedCount: 1,
    files: [
      {
        path: "/Air-261.dmg",
        fileName: "Air-261.dmg",
        label: "default",
        action: "upload",
        status: "completed",
        progressPercent: 100,
        bytesEncrypted: 0,
        bytesTransferred: TOTAL,
        totalBytes: TOTAL,
      },
    ],
    widgetState: "completed",
    statusVariant: "success",
    effectiveInProgress: false,
    effectiveCompleted: true,
    intentTotalFiles: 1,
    intentCompletedFiles: 1,
    intentTotalBytes: TOTAL,
    intentCompletedBytes: TOTAL,
    intentActive: false,
  });
  return { seed: null, frames: [...frames, done] };
}

/**
 * BUG 7 (smoother sticks high): a plan at ~60 % is re-planned when more bytes
 * are queued mid-session (`bytesExpected` and `totalFiles` both grow), which
 * legitimately LOWERS overallPercent to ~35 %. The fix re-seeds the smoother
 * on a re-plan; a regression to upward-only `Math.max` pins the ring at 60 %.
 * Asserted by {@link scenarioReplanFollowsDown} in the test (the post-re-plan
 * ring must follow the percent DOWN), not by a per-frame invariant — within a
 * stable plan the smoother is allowed to clamp upward, so "ring ≤ raw" is not
 * universally true.
 */
export function scenarioReplanLowersPercent(): ReplaySession {
  const before = frame({
    overallPercent: 60,
    progressBytes: 60_000_000,
    bytesExpected: 100_000_000,
    combinedProgressBytes: 60_000_000,
    combinedBytesExpected: 200_000_000,
    totalFiles: 2,
    actualTotal: 2,
    files: [inFlightFile("a.bin", 60_000_000, 100_000_000)],
  });
  // Re-plan: a third file's bytes are added to the same session. progressBytes
  // unchanged, bytesExpected jumps 100MB → 170MB, so overallPercent ≈ 35.
  const afterReplan = frame({
    overallPercent: 35,
    progressBytes: 60_000_000,
    bytesExpected: 170_000_000,
    combinedProgressBytes: 60_000_000,
    combinedBytesExpected: 340_000_000,
    totalFiles: 3,
    actualTotal: 3,
    files: [inFlightFile("a.bin", 60_000_000, 170_000_000)],
  });
  return { seed: null, frames: [before, afterReplan] };
}

/** The smoothed percent the ring should show after the re-plan frame. */
export const REPLAN_EXPECTED_PERCENT = 35;
/** The stale high-water value a regressed (upward-only) smoother would pin. */
export const REPLAN_STALE_PERCENT = 60;
