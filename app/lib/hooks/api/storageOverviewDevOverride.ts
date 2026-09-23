import { atom } from "jotai";

import type { StorageOverview } from "@/app/lib/hooks/api/useStorageOverview";

/**
 * Dev-only scenarios for `get_storage_overview` UI.
 *
 * Read only when `process.env.NODE_ENV === "development"`. Production
 * builds never apply these overrides (see `useStorageOverview`).
 */
export type StorageOverviewDevScenario =
  | null
  | "none"
  | "free-under"
  | "free-over"
  | "paid-under"
  | "paid-over";

export const storageOverviewDevOverrideAtom =
  atom<StorageOverviewDevScenario>(null);

const GB = 1_000_000_000;

function baseOverview(
  partial: Partial<StorageOverview> &
    Pick<StorageOverview, "source" | "usedBytes" | "totalBytes" | "percent">,
): StorageOverview {
  return {
    creditsHip: null,
    freeTierEntitled: partial.source !== "none",
    usedPending: false,
    plan: null,
    planAction: partial.source === "subscription" ? "none" : "upgrade",
    usedDisplay: "",
    totalDisplay: "",
    freeDisplay: "",
    overDisplay: null,
    ...partial,
  };
}

/**
 * Pure mapper so tests can pin each scenario without mounting React.
 */
export function applyStorageOverviewDevOverride(
  real: StorageOverview | undefined,
  scenario: StorageOverviewDevScenario,
): StorageOverview | undefined {
  if (!scenario) return real;

  switch (scenario) {
    case "none":
      return baseOverview({
        source: "none",
        usedBytes: 0,
        totalBytes: 0,
        percent: 0,
        freeTierEntitled: false,
        usedDisplay: "0 B",
        totalDisplay: "0 B",
        freeDisplay: "0 B",
        planAction: "upgrade",
      });
    case "free-under":
      return baseOverview({
        source: "free",
        usedBytes: 3 * GB,
        totalBytes: 10 * GB,
        percent: 30,
        usedDisplay: "3.00 GB",
        totalDisplay: "10.00 GB",
        freeDisplay: "7.00 GB",
        planAction: "upgrade",
      });
    case "free-over":
      return baseOverview({
        source: "free",
        usedBytes: 12.56 * GB,
        totalBytes: 10 * GB,
        percent: 100,
        usedDisplay: "12.56 GB",
        totalDisplay: "10.00 GB",
        freeDisplay: "0.00 GB",
        overDisplay: "2.56 GB over your plan",
        planAction: "upgrade",
      });
    case "paid-under":
      return baseOverview({
        source: "subscription",
        usedBytes: 100 * GB,
        totalBytes: 500 * GB,
        percent: 20,
        usedDisplay: "100.00 GB",
        totalDisplay: "500.00 GB",
        freeDisplay: "400.00 GB",
        plan: {
          name: "Starter",
          code: "solo",
          amount: 10,
          interval: "month",
          storageBytes: 500 * GB,
          storageDisplay: "500.00 GB",
          funding: "card",
          renewsInDays: 20,
        },
        planAction: "none",
      });
    case "paid-over":
      return baseOverview({
        source: "subscription",
        usedBytes: 520 * GB,
        totalBytes: 500 * GB,
        percent: 100,
        usedDisplay: "520.00 GB",
        totalDisplay: "500.00 GB",
        freeDisplay: "0.00 GB",
        overDisplay: "20.00 GB over your plan",
        plan: {
          name: "Starter",
          code: "solo",
          amount: 10,
          interval: "month",
          storageBytes: 500 * GB,
          storageDisplay: "500.00 GB",
          funding: "card",
          renewsInDays: 20,
        },
        planAction: "upgrade",
      });
    default:
      return real;
  }
}
