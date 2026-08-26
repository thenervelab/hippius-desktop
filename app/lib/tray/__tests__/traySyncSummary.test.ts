import { describe, expect, it } from "vitest";
import { getTraySyncSummary } from "../traySyncSummary";
import {
  EMPTY_SNAPSHOT,
  type FileProgress,
  type SyncSnapshot,
} from "@/app/lib/types/syncSnapshot";

function snap(overrides: Partial<SyncSnapshot>): SyncSnapshot {
  return { ...EMPTY_SNAPSHOT, ...overrides };
}

function errorFile(fileName: string, error: string): FileProgress {
  return {
    path: `/${fileName}`,
    fileName,
    label: "default",
    action: "upload",
    status: "error",
    progressPercent: 0,
    bytesEncrypted: 0,
    bytesTransferred: 0,
    totalBytes: 0,
    error,
  };
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

  it("appends the shared reason when every failed file failed the same way", () => {
    const reason = "Insufficient credits — needs $1.00, you have $0.12.";
    const out = getTraySyncSummary(
      snap({
        totalFiles: 2,
        actualTotal: 2,
        failedFiles: 2,
        statusVariant: "error",
        effectiveCompleted: true,
        widgetVisible: true,
        files: [errorFile("a.txt", reason), errorFile("b.txt", reason)],
      }),
    );
    expect(out).toMatchObject({
      tone: "failed",
      detail: `2 of 2 files failed · ${reason}`,
    });
  });

  it("keeps a bare count when failed files have differing reasons", () => {
    const out = getTraySyncSummary(
      snap({
        totalFiles: 2,
        actualTotal: 2,
        failedFiles: 2,
        statusVariant: "error",
        effectiveCompleted: true,
        widgetVisible: true,
        files: [
          errorFile("a.txt", "Couldn't reach the server — will retry."),
          errorFile("b.txt", "Server error (500). Please try again."),
        ],
      }),
    );
    expect(out?.detail).toBe("2 of 2 files failed");
  });

  it("reports the preparing state", () => {
    const out = getTraySyncSummary(snap({ widgetState: "preparing" }));
    expect(out).toMatchObject({ tone: "preparing", statusLabel: "Preparing" });
    expect(out?.detail).toBe("Preparing sync…");
  });

  it("shows the startup local-pending summary in the preparing detail", () => {
    const out = getTraySyncSummary(
      snap({
        widgetState: "preparing",
        preparingPendingFiles: 1240,
        preparingPendingBytes: 8_300_000_000,
      }),
    );
    expect(out).toMatchObject({ tone: "preparing", statusLabel: "Preparing" });
    expect(out?.detail).toContain("1,240 files");
    expect(out?.detail).toContain("pending");
  });

  it("shows the live scan counter in the preparing detail", () => {
    const out = getTraySyncSummary(
      snap({
        widgetState: "preparing",
        preparingScannedFiles: 1234,
      }),
    );
    expect(out).toMatchObject({ tone: "preparing", statusLabel: "Preparing" });
    expect(out?.detail).toBe("1,234 files scanned");
  });

  it("shows the live fetch progress when scanning is done", () => {
    const out = getTraySyncSummary(
      snap({
        widgetState: "preparing",
        preparingFetchedEntries: 40,
        preparingFetchTotalEntries: 90,
      }),
    );
    expect(out?.detail).toBe("40 of 90 entries checked");
  });

  it("prefers the startup pending summary over the live counters", () => {
    const out = getTraySyncSummary(
      snap({
        widgetState: "preparing",
        preparingPendingFiles: 1240,
        preparingPendingBytes: 8_300_000_000,
        preparingScannedFiles: 55,
      }),
    );
    expect(out?.detail).toContain("pending");
    expect(out?.detail).not.toContain("scanned");
  });

  it("clamps a stray out-of-range percent", () => {
    const out = getTraySyncSummary(
      snap({ totalFiles: 1, actualTotal: 1, overallPercent: 140, effectiveInProgress: true }),
    );
    expect(out?.percent).toBe(100);
  });
});
