import { describe, expect, it } from "vitest";

import {
  applyStorageOverviewDevOverride,
  type StorageOverviewDevScenario,
} from "@/app/lib/hooks/api/storageOverviewDevOverride";
import { getUploadBlockReason } from "@/app/components/page-sections/drive/uploadRoomState";

const SCENARIOS: StorageOverviewDevScenario[] = [
  "none",
  "free-under",
  "free-over",
  "paid-under",
  "paid-over",
];

describe("applyStorageOverviewDevOverride", () => {
  it("leaves live data alone when scenario is null", () => {
    const live = {
      source: "free" as const,
      usedBytes: 1,
      totalBytes: 10,
      percent: 10,
      creditsHip: null,
      freeTierEntitled: true,
      usedPending: false,
      plan: null,
      planAction: "upgrade" as const,
      usedDisplay: "1 B",
      totalDisplay: "10 B",
      freeDisplay: "9 B",
      overDisplay: null,
    };
    expect(applyStorageOverviewDevOverride(live, null)).toBe(live);
  });

  it.each([
    ["none", "no-plan"],
    ["free-under", null],
    ["free-over", "over-capacity"],
    ["paid-under", null],
    ["paid-over", "over-capacity"],
  ] as const)("%s → block reason %s", (scenario, reason) => {
    const overview = applyStorageOverviewDevOverride(undefined, scenario);
    expect(getUploadBlockReason(overview)).toBe(reason);
  });

  it("covers every documented scenario", () => {
    for (const scenario of SCENARIOS) {
      expect(applyStorageOverviewDevOverride(undefined, scenario)).toBeTruthy();
    }
  });
});
