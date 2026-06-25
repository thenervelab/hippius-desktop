import type { SyncSnapshot } from "@/app/lib/types/syncSnapshot";
import { formatBytes } from "@/app/lib/utils/formatBytes";

/** Visual tone for the tray sync-summary row, driving its icon + accent color. */
export type TraySyncTone = "active" | "completed" | "failed" | "preparing";

export interface TraySyncSummary {
  tone: TraySyncTone;
  /** Overall progress, 0–100 (clamped/rounded). */
  percent: number;
  /** Short status word on the right ("In Progress", "Complete", "Failed", …). */
  statusLabel: string;
  /** Secondary line: synced vs. remaining counts, or — when failed and every
   *  failed file shares one cause — the count plus that failure reason. */
  detail: string;
}

/**
 * The single failure reason shared by every failed file in the snapshot, or
 * `null` when there are none or they differ. A shared cause (e.g. every file
 * 402'd on the same out-of-credits error) is worth surfacing verbatim; mixed
 * causes stay a bare count so the line never implies one wrong reason. The
 * reason strings are authored in Rust (`FileFailureKindPayload::display_reason`)
 * and ride the snapshot's per-file `error` field — the FE never parses them.
 */
function sharedFailureReason(files: SyncSnapshot["files"]): string | null {
  const reasons = new Set<string>();
  for (const file of files) {
    if (file.status !== "error") continue;
    const reason = file.error?.trim();
    if (reason) reasons.add(reason);
  }
  return reasons.size === 1 ? [...reasons][0] : null;
}

/**
 * Map a {@link SyncSnapshot} to the tray popover's sync-progress summary, or
 * `null` when there is no activity worth surfacing (idle, no session) so the
 * caller renders nothing.
 *
 * This mirrors the sidebar `SyncStatusDialog` header logic (status word,
 * percent, "X of Y" counts) so the tray popover and the sidebar widget read the
 * same. It is a pure function — the tray popover is provider-free and calls it
 * directly — and is unit-tested in `__tests__/traySyncSummary.test.ts`.
 */
export function getTraySyncSummary(
  snapshot: SyncSnapshot,
): TraySyncSummary | null {
  const {
    widgetState,
    widgetVisible,
    totalFiles,
    effectiveInProgress,
    effectiveCompleted,
    failedFiles,
    statusVariant,
    overallPercent,
    syncedCount,
    deletedCount,
    actualTotal,
  } = snapshot;

  const isPreparing = widgetState === "preparing";
  // Show whenever the engine reports any session/activity. When fully idle
  // (no session, nothing completed/visible) the summary is hidden and the file
  // list shows directly under the heading.
  const hasActivity =
    isPreparing ||
    widgetVisible ||
    effectiveInProgress ||
    effectiveCompleted ||
    totalFiles > 0;
  if (!hasActivity) return null;

  const clampPercent = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  const completedTotal = syncedCount + deletedCount;
  const total = actualTotal;
  // Files neither finished nor failed yet.
  const remaining = Math.max(0, total - completedTotal - failedFiles);
  const plural = (n: number) => (n === 1 ? "" : "s");

  if (isPreparing) {
    // At startup the backend attaches a local-pending summary (on-disk files not
    // yet in the synced baseline) so the user sees the scope of pending work
    // immediately, not a bare "Preparing sync…". Absent for file-watcher cycles.
    const pendingFiles = snapshot.preparingPendingFiles ?? 0;
    const detail =
      pendingFiles > 0
        ? `${pendingFiles.toLocaleString()} file${plural(pendingFiles)} · ${formatBytes(snapshot.preparingPendingBytes ?? 0)} pending`
        : "Preparing sync…";
    return {
      tone: "preparing",
      percent: clampPercent(overallPercent),
      statusLabel: "Preparing",
      detail,
    };
  }

  // Same precedence as the sidebar widget: a failure outranks completion.
  const hasFailed =
    statusVariant === "error" || (failedFiles > 0 && effectiveCompleted);
  if (hasFailed) {
    const countLine = `${failedFiles} of ${total} file${plural(total)} failed`;
    const reason = sharedFailureReason(snapshot.files);
    return {
      tone: "failed",
      percent: clampPercent(overallPercent),
      statusLabel: "Failed",
      detail: reason ? `${countLine} · ${reason}` : countLine,
    };
  }

  if (effectiveCompleted) {
    return {
      tone: "completed",
      percent: 100,
      statusLabel: "Complete",
      detail: `${completedTotal} of ${total} file${plural(total)} synced`,
    };
  }

  // In progress. Until a plan is known (total 0) show the preparing copy
  // rather than a misleading "0 of 0".
  return {
    tone: "active",
    percent: clampPercent(overallPercent),
    statusLabel: "In Progress",
    detail:
      total > 0
        ? `${completedTotal} of ${total} synced · ${remaining} remaining`
        : "Preparing sync…",
  };
}

export default getTraySyncSummary;
