import { describe, expect, it } from "vitest";
import {
  isExcludedSyncStatus,
  omitsBilledSize,
} from "../syncStatusDisplay";

describe("isExcludedSyncStatus", () => {
  it("matches excluded only — Hidden is a different chip", () => {
    expect(isExcludedSyncStatus("excluded")).toBe(true);
    expect(isExcludedSyncStatus("hidden")).toBe(false);
    expect(isExcludedSyncStatus("synced")).toBe(false);
    expect(isExcludedSyncStatus(undefined)).toBe(false);
  });
});

describe("omitsBilledSize", () => {
  it("covers excluded and hidden so both size cells can share one rule", () => {
    expect(omitsBilledSize("excluded")).toBe(true);
    expect(omitsBilledSize("hidden")).toBe(true);
    expect(omitsBilledSize("pending")).toBe(false);
  });
});
