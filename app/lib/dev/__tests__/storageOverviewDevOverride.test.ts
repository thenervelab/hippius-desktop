import { describe, expect, it } from "vitest";

import type { StorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { applyStorageOverviewDevOverride } from "../storageOverviewDevOverride";

const real: StorageOverview = {
  usedBytes: 100e9,
  totalBytes: 1e12,
  percent: 10,
  source: "subscription",
  plan: { name: "Pro", amount: 12, interval: "month", storageBytes: 1e12 },
  creditsHip: "5",
};

describe("applyStorageOverviewDevOverride", () => {
  it("returns the real data untouched when no override is set", () => {
    expect(applyStorageOverviewDevOverride(real, null)).toEqual(real);
  });

  it("merges partial overrides, keeping unspecified real fields", () => {
    const out = applyStorageOverviewDevOverride(real, { source: "credits" });
    expect(out.source).toBe("credits");
    expect(out.plan).toEqual(real.plan);
    expect(out.creditsHip).toBe("5");
  });

  it("recomputes (and clamps) percent from overridden bytes when not pinned", () => {
    const out = applyStorageOverviewDevOverride(real, {
      usedBytes: 850e9,
      totalBytes: 1e12,
    });
    expect(out.percent).toBeCloseTo(85);
    const over = applyStorageOverviewDevOverride(real, {
      usedBytes: 2e12,
      totalBytes: 1e12,
    });
    expect(over.percent).toBe(100);
    const none = applyStorageOverviewDevOverride(real, {
      source: "none",
      usedBytes: 0,
      totalBytes: 0,
    });
    expect(none.percent).toBe(0);
  });

  it("respects an explicitly pinned percent", () => {
    const out = applyStorageOverviewDevOverride(real, { percent: 97 });
    expect(out.percent).toBe(97);
  });
});
