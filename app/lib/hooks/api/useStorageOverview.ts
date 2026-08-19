import { LIVE_DATA_REFRESH_MS } from "@/lib/constants";
import {
  DEV_BASE_OVERVIEW,
  applyStorageOverviewDevOverride,
  readStorageOverviewDevOverride,
} from "@/app/lib/dev/storageOverviewDevOverride";
import { useInvokeQuery } from "./useInvokeQuery";

/**
 * TanStack Query key for the home page's storage/plan cards and the top-bar
 * chip, exported so sync flows can invalidate it alongside
 * `DRIVE_STORAGE_STATS_QUERY_KEY` when uploads/deletes change the totals.
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
  const query = useInvokeQuery<StorageOverview>({
    command: "get_storage_overview",
    queryKey: (addr) => [STORAGE_OVERVIEW_QUERY_KEY, addr],
    options: {
      staleTime: LIVE_DATA_REFRESH_MS,
      refetchOnWindowFocus: true,
      refetchInterval: LIVE_DATA_REFRESH_MS,
    },
  });

  // Dev-only state simulator (no-op in production builds) — see
  // `app/lib/dev/storageOverviewDevOverride.ts` for the localStorage recipe
  // to fake plan / credits / none states. It short-circuits loading/error
  // too, NOT just the data: the simulator must work even when the IPC is
  // unavailable (Rust side mid-rebuild, or a plain browser without Tauri),
  // which a `select`-based merge could never do.
  const override = readStorageOverviewDevOverride();
  if (override) {
    return {
      ...query,
      data: applyStorageOverviewDevOverride(
        query.data ?? DEV_BASE_OVERVIEW,
        override,
      ),
      isLoading: false,
      isError: false,
    } as typeof query;
  }

  return query;
}
