import { describe, it, expect } from "vitest";
import { shouldOfferExcludedFilter } from "../excludedFilterVisibility";

const opts = (over: Partial<Parameters<typeof shouldOfferExcludedFilter>[0]> = {}) => ({
  driveLabel: "Documents",
  hasExclusions: true,
  excludedOnly: false,
  ...over,
});

describe("shouldOfferExcludedFilter", () => {
  it("offers the filter on a drive that actually excludes something", () => {
    expect(shouldOfferExcludedFilter(opts())).toBe(true);
  });

  // The chip was shown to everyone, so most accounts carried a filter that
  // could only ever return nothing.
  it("hides it on a drive with no exclude rules", () => {
    expect(shouldOfferExcludedFilter(opts({ hasExclusions: false }))).toBe(false);
  });

  // Exclusions are a property of a synced folder on this machine.
  it("hides it where exclusions cannot exist", () => {
    expect(
      shouldOfferExcludedFilter(opts({ driveLabel: null, hasExclusions: false })),
    ).toBe(false);
    expect(
      shouldOfferExcludedFilter(opts({ driveLabel: null, hasExclusions: true })),
    ).toBe(false);
  });

  // Hiding the control while its filter is applied leaves the list filtered
  // with no way to clear it.
  it("keeps it while the filter is applied, whatever else is true", () => {
    expect(
      shouldOfferExcludedFilter({
        driveLabel: null,
        hasExclusions: false,
        excludedOnly: true,
      }),
    ).toBe(true);
  });
});
