import { LIVE_DATA_REFRESH_MS } from "@/lib/constants";
import { useInvokeQuery } from "./useInvokeQuery";

/**
 * TanStack Query key for the home page's storage/plan cards and the top-bar
 * chip, exported so sync flows can invalidate it on every
 * `hcfs_sync_completed` (including zero-file cycles — empty indexer data
 * is success + 0 bytes, so a no-op cycle still has to re-probe). Always
 * invalidated in lockstep with `DRIVE_STORAGE_STATS_QUERY_KEY`: both read
 * the same indexer row, so refreshing one alone makes the two surfaces
 * disagree about one number.
 */
export const STORAGE_OVERVIEW_QUERY_KEY = "storage-overview";

/** Which source won the capacity decision (decided once, in Rust). */
export type CapacitySource = "subscription" | "credits" | "none";

export interface PlanInfo {
  name: string;
  amount: number;
  interval: string;
  storageBytes: number;
}

/** Shape returned by the Rust `get_storage_overview` IPC (camelCase). */
export interface StorageOverview {
  usedBytes: number;
  /** Effective capacity in bytes; 0 when source is "none". */
  totalBytes: number;
  /** used/total * 100, clamped to [0, 100] in Rust; 0 when no capacity. */
  percent: number;
  source: CapacitySource;
  /** Present when source is "subscription". */
  plan: PlanInfo | null;
  /** Pre-formatted HIP credit balance; null if the balance fetch failed. */
  creditsHip: string | null;
  /**
   * Indexer row is 0 but this device already has files. The card shows
   * "Updating…" instead of a confident "0 B". Never inferred on the FE
   * from `usedBytes === 0` — that is also the true-empty state.
   */
  usedPending: boolean;
  /**
   * Used / total / free labels authored in Rust so they cannot disagree
   * about units or rounding. Render these; do not `formatBytes` the raw
   * counts (that is H-109: "5.03 TB used" next to "5 TB free").
   */
  usedDisplay: string;
  totalDisplay: string;
  freeDisplay: string;
}

/**
 * Plan/credits-aware overview: bytes used vs the effective capacity, plus
 * the plan-or-credits decision, composed in one Rust round-trip
 * (`billing/storage_overview.rs`). The priority chain — subscription →
 * credits-derived → none — lives in Rust so the storage card, plan card,
 * and top-bar chip all render from the SAME decision and cannot disagree.
 *
 * Polling mirrors `useDriveStorageStats`: the indexer ingests asynchronously,
 * so a block-cadence refetch keeps the cards converging without ever being
 * the bottleneck once the indexer catches up.
 */
export function useStorageOverview() {
  return useInvokeQuery<StorageOverview>({
    command: "get_storage_overview",
    queryKey: (addr) => [STORAGE_OVERVIEW_QUERY_KEY, addr],
    options: {
      staleTime: LIVE_DATA_REFRESH_MS,
      refetchOnWindowFocus: true,
      refetchInterval: LIVE_DATA_REFRESH_MS,
    },
  });
}
