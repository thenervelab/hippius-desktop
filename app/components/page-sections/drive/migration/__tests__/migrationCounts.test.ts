import { describe, it, expect } from "vitest";
import {
  getMigrationDisplayCounts,
  getMigrationTerminalState,
  type MigrationCountsInput,
} from "@/components/page-sections/drive/migration/migrationCounts";

const base: MigrationCountsInput = {
  status: "in_progress",
  total: 100,
  completed: 40,
  logical_file_count: null,
};

describe("getMigrationDisplayCounts", () => {
  it("falls back to the S3 object total when logical count is null", () => {
    expect(getMigrationDisplayCounts(base)).toEqual({
      displayTotal: 100,
      displayCompleted: 40,
    });
  });

  it("prefers the logical file count once available", () => {
    expect(
      getMigrationDisplayCounts({ ...base, logical_file_count: 9, completed: 4 })
    ).toEqual({ displayTotal: 9, displayCompleted: 4 });
  });

  it("clamps completed to the display total (never '12 of 9')", () => {
    expect(
      getMigrationDisplayCounts({ ...base, logical_file_count: 9, completed: 12 })
    ).toEqual({ displayTotal: 9, displayCompleted: 9 });
  });

  it("handles an empty migration (all zeros)", () => {
    expect(
      getMigrationDisplayCounts({ ...base, total: 0, completed: 0, logical_file_count: 0 })
    ).toEqual({ displayTotal: 0, displayCompleted: 0 });
  });
});

describe("getMigrationTerminalState", () => {
  it("marks a non-cancelled terminal status as succeeded", () => {
    expect(getMigrationTerminalState({ ...base, status: "completed" })).toEqual({
      succeeded: true,
      finalCount: 100,
      finalCompleted: 40,
    });
  });

  it("marks a cancelled status as not succeeded", () => {
    expect(getMigrationTerminalState({ ...base, status: "cancelled" }).succeeded).toBe(
      false
    );
  });

  it("treats a 'failed' terminal status as succeeded (preserved behavior — see code note)", () => {
    // Pins the documented quirk: only an explicit cancel is non-success, so a
    // hard 'failed' still reports succeeded:true. Tracked as a product follow-up.
    expect(getMigrationTerminalState({ ...base, status: "failed" }).succeeded).toBe(true);
  });

  it("uses the logical file count for the final numbers and clamps completed", () => {
    expect(
      getMigrationTerminalState({
        ...base,
        status: "completed",
        logical_file_count: 9,
        completed: 12,
      })
    ).toEqual({ succeeded: true, finalCount: 9, finalCompleted: 9 });
  });
});
