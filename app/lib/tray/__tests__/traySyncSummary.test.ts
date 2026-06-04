import { describe, expect, it } from "vitest";
import { getTraySyncSummary } from "../traySyncSummary";
import { EMPTY_SNAPSHOT, type SyncSnapshot } from "@/app/lib/types/syncSnapshot";

function snap(overrides: Partial<SyncSnapshot>): SyncSnapshot {
  return { ...EMPTY_SNAPSHOT, ...overrides };
}

describe("getTraySyncSummary", () => {
  it("returns null when idle (no session/activity)", () => {
    expect(getTraySyncSummary(EMPTY_SNAPSHOT)).toBeNull();
  });

  it("reports an in-progress session with synced/remaining counts", () => {
    const out = getTraySyncSummary(
      snap({
        totalFiles: 5,
        actualTotal: 5,
        syncedCount: 2,
        overallPercent: 40,
        effectiveInProgress: true,
        widgetVisible: true,
      }),
    );
    expect(out).toEqual({
      tone: "active",
      percent: 40,
      statusLabel: "In Progress",
      detail: "2 of 5 synced · 3 remaining",
    });
  });

  it("reports completion at 100%", () => {
    const out = getTraySyncSummary(
      snap({
        totalFiles: 3,
        actualTotal: 3,
        syncedCount: 3,
        overallPercent: 100,
        effectiveCompleted: true,
        widgetVisible: true,
      }),
    );
    expect(out).toMatchObject({
      tone: "completed",
      percent: 100,
      statusLabel: "Complete",
      detail: "3 of 3 files synced",
    });
  });

  it("reports failures (failure outranks completion)", () => {
    const out = getTraySyncSummary(
      snap({
        totalFiles: 4,
        actualTotal: 4,
        syncedCount: 3,
        failedFiles: 1,
        statusVariant: "error",
        effectiveCompleted: true,
        widgetVisible: true,
      }),
    );
    expect(out).toMatchObject({
      tone: "failed",
      statusLabel: "Failed",
      detail: "1 of 4 files failed",
    });
  });

  it("reports the preparing state", () => {
    const out = getTraySyncSummary(snap({ widgetState: "preparing" }));
    expect(out).toMatchObject({ tone: "preparing", statusLabel: "Preparing" });
  });

  it("clamps a stray out-of-range percent", () => {
    const out = getTraySyncSummary(
      snap({ totalFiles: 1, actualTotal: 1, overallPercent: 140, effectiveInProgress: true }),
    );
    expect(out?.percent).toBe(100);
  });
});
