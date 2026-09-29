import type { CapacitySource } from "@/app/lib/hooks/api/useStorageOverview";

/**
 * Why an upload / sync click must not open a picker.
 *
 * Distinct from the live `/can_upload` pre-flight: that check fail-opens on
 * network blips and is asked with `bytes: 0` from the polled gate, which
 * can still look "eligible" for an access-key account with no plan. The
 * overview already knows that account has no capacity (`source: "none"`),
 * so the UI gate keys on this first.
 */
export type UploadBlockReason = "no-plan" | "over-capacity";

export interface UploadRoomOverview {
  source?: CapacitySource;
  /** Rust-authored; present only when used > total. */
  overDisplay?: string | null;
  usedBytes?: number;
  totalBytes?: number;
}

/**
 * Whether the account cannot start an upload from what Overview already
 * knows — no plan, past capacity, or exactly full.
 *
 * Pure so every surface (header, Local view, context menu, remote, drop)
 * can share one rule and unit tests pin access-key `none` without a
 * server.
 */
export function getUploadBlockReason(
  overview: UploadRoomOverview | null | undefined,
): UploadBlockReason | null {
  if (!overview?.source) return null;

  // Access-key with no subscription: zero free allowance. Banner already
  // says so; the buttons must not open a picker that will only fail.
  if (overview.source === "none") return "no-plan";

  if (overview.overDisplay) return "over-capacity";

  const used = overview.usedBytes;
  const total = overview.totalBytes;
  if (
    typeof used === "number" &&
    typeof total === "number" &&
    total > 0 &&
    used >= total
  ) {
    return "over-capacity";
  }

  return null;
}

/** True when a click must open subscribe/upgrade instead of a picker. */
export function isUploadBlocked(
  overview: UploadRoomOverview | null | undefined,
  eligibilitySaysIneligible?: boolean,
): boolean {
  if (getUploadBlockReason(overview) !== null) return true;
  return eligibilitySaysIneligible === true;
}
