import { describe, expect, it } from "vitest";

import {
  getUploadBlockReason,
  isUploadBlocked,
} from "../uploadRoomState";

describe("getUploadBlockReason", () => {
  it("blocks access-key accounts with no plan", () => {
    expect(
      getUploadBlockReason({
        source: "none",
        usedBytes: 0,
        totalBytes: 0,
      }),
    ).toBe("no-plan");
  });

  it("does not treat missing overview as blocked (still loading)", () => {
    expect(getUploadBlockReason(undefined)).toBeNull();
    expect(getUploadBlockReason(null)).toBeNull();
    expect(getUploadBlockReason({})).toBeNull();
  });

  it("allows OAuth free under the allowance", () => {
    expect(
      getUploadBlockReason({
        source: "free",
        usedBytes: 5_000_000_000,
        totalBytes: 10_000_000_000,
      }),
    ).toBeNull();
  });

  it("blocks free at or over the allowance", () => {
    expect(
      getUploadBlockReason({
        source: "free",
        usedBytes: 10_000_000_000,
        totalBytes: 10_000_000_000,
      }),
    ).toBe("over-capacity");
    expect(
      getUploadBlockReason({
        source: "free",
        overDisplay: "2.56 GB over your plan",
        usedBytes: 12_560_000_000,
        totalBytes: 10_000_000_000,
      }),
    ).toBe("over-capacity");
  });

  it("allows a paid plan with room left", () => {
    expect(
      getUploadBlockReason({
        source: "subscription",
        usedBytes: 100,
        totalBytes: 500_000_000_000,
      }),
    ).toBeNull();
  });

  it("blocks a paid plan that is full or over", () => {
    expect(
      getUploadBlockReason({
        source: "subscription",
        usedBytes: 500_000_000_000,
        totalBytes: 500_000_000_000,
      }),
    ).toBe("over-capacity");
    expect(
      getUploadBlockReason({
        source: "subscription",
        overDisplay: "1.00 TB over your plan",
        usedBytes: 600_000_000_000,
        totalBytes: 500_000_000_000,
      }),
    ).toBe("over-capacity");
  });
});

describe("isUploadBlocked", () => {
  it("ORs the live eligibility refusal onto the overview rule", () => {
    expect(
      isUploadBlocked(
        { source: "free", usedBytes: 1, totalBytes: 10_000_000_000 },
        true,
      ),
    ).toBe(true);
    expect(
      isUploadBlocked(
        { source: "free", usedBytes: 1, totalBytes: 10_000_000_000 },
        false,
      ),
    ).toBe(false);
  });

  // The bug under test: /can_upload with 0 bytes (or fail-open) looked
  // eligible while Overview already knew the account had no plan.
  it("blocks no-plan even when eligibility has not said ineligible", () => {
    expect(
      isUploadBlocked(
        { source: "none", usedBytes: 0, totalBytes: 0 },
        false,
      ),
    ).toBe(true);
  });
});
