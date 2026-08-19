import { describe, expect, it } from "vitest";

import {
  USAGE_CRITICAL_PERCENT,
  USAGE_WARN_PERCENT,
  formatPercentLabel,
  getStorageOverviewView,
  getUsageTone,
} from "../storage-overview/storageOverviewState";

describe("getUsageTone", () => {
  it("is ok below the warn threshold", () => {
    expect(getUsageTone(0)).toBe("ok");
    expect(getUsageTone(USAGE_WARN_PERCENT - 0.01)).toBe("ok");
  });

  it("warns from 80% and turns critical from 95%", () => {
    expect(getUsageTone(USAGE_WARN_PERCENT)).toBe("warn");
    expect(getUsageTone(USAGE_CRITICAL_PERCENT - 0.01)).toBe("warn");
    expect(getUsageTone(USAGE_CRITICAL_PERCENT)).toBe("critical");
    expect(getUsageTone(100)).toBe("critical");
  });
});

describe("getStorageOverviewView", () => {
  it("skeleton wins over everything until first settle", () => {
    expect(
      getStorageOverviewView({ showSkeleton: true, isError: true, hasPlan: true }),
    ).toBe("skeleton");
  });

  it("error wins over plan state — a failed fetch must not render as data", () => {
    expect(
      getStorageOverviewView({ showSkeleton: false, isError: true, hasPlan: true }),
    ).toBe("error");
    expect(
      getStorageOverviewView({ showSkeleton: false, isError: true, hasPlan: false }),
    ).toBe("error");
  });

  it("no plan renders the subscribe state, plan renders usage", () => {
    expect(
      getStorageOverviewView({ showSkeleton: false, isError: false, hasPlan: false }),
    ).toBe("no-plan");
    expect(
      getStorageOverviewView({ showSkeleton: false, isError: false, hasPlan: true }),
    ).toBe("usage");
  });
});

describe("formatPercentLabel", () => {
  it("rounds to whole percent", () => {
    expect(formatPercentLabel(30)).toBe("30%");
    expect(formatPercentLabel(29.6)).toBe("30%");
    expect(formatPercentLabel(0)).toBe("0%");
    expect(formatPercentLabel(100)).toBe("100%");
  });

  it("shows <1% for tiny-but-nonzero usage instead of a flat 0%", () => {
    expect(formatPercentLabel(0.2)).toBe("<1%");
    expect(formatPercentLabel(0.999)).toBe("<1%");
    expect(formatPercentLabel(1)).toBe("1%");
  });
});
