import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  USAGE_CRITICAL_PERCENT,
  USAGE_WARN_PERCENT,
  formatPercentLabel,
  formatPlanPrice,
  getCapacitySourceLabel,
  getPlanView,
  getStorageOverviewView,
  getUsageTone,
  getUsedBytesDisplay,
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
      getStorageOverviewView({
        showSkeleton: true,
        isError: true,
        source: "subscription",
      }),
    ).toBe("skeleton");
  });

  it("error wins over data — a failed fetch must not render as data", () => {
    expect(
      getStorageOverviewView({
        showSkeleton: false,
        isError: true,
        source: "subscription",
      }),
    ).toBe("error");
    expect(
      getStorageOverviewView({ showSkeleton: false, isError: true, source: "free" }),
    ).toBe("error");
  });

  it("both plan- and free-tier-backed capacity render the usage bar", () => {
    expect(
      getStorageOverviewView({
        showSkeleton: false,
        isError: false,
        source: "subscription",
      }),
    ).toBe("usage");
    expect(
      getStorageOverviewView({
        showSkeleton: false,
        isError: false,
        source: "free",
      }),
    ).toBe("usage");
  });

  it("missing data renders the no-plan state", () => {
    expect(
      getStorageOverviewView({
        showSkeleton: false,
        isError: false,
        source: undefined,
      }),
    ).toBe("no-plan");
  });
});

describe("getUsedBytesDisplay", () => {
  // Pure projection of Rust's usedPending flag. The card must never
  // invent this from usedBytes === 0 (that is also the true-empty
  // state); Rust owns the indexer-vs-local lag decision.
  it("shows pending instead of a confident 0 B while the indexer lags", () => {
    expect(getUsedBytesDisplay(true, 0)).toEqual({ kind: "pending" });
    expect(getUsedBytesDisplay(true, 46)).toEqual({ kind: "pending" });
  });

  it("shows the indexer bytes when not pending, including a true empty", () => {
    expect(getUsedBytesDisplay(false, 0)).toEqual({ kind: "bytes", bytes: 0 });
    expect(getUsedBytesDisplay(false, 46)).toEqual({
      kind: "bytes",
      bytes: 46,
    });
  });
});

describe("getPlanView (plan card + top-bar chip)", () => {
  it("holds the skeleton until the decision settles — no heading flash", () => {
    expect(
      getPlanView({ showSkeleton: true, isError: false, source: undefined }),
    ).toBe("skeleton");
    expect(
      getPlanView({ showSkeleton: true, isError: false, source: "subscription" }),
    ).toBe("skeleton");
  });

  it("maps each source to its variant, plan winning over free by construction", () => {
    expect(
      getPlanView({ showSkeleton: false, isError: false, source: "subscription" }),
    ).toBe("plan");
    expect(
      getPlanView({ showSkeleton: false, isError: false, source: "free" }),
    ).toBe("free");
    expect(
      getPlanView({ showSkeleton: false, isError: false, source: undefined }),
    ).toBe("none");
  });

  it("resolves an error to none (the storage card owns the error copy)", () => {
    expect(
      getPlanView({ showSkeleton: false, isError: true, source: undefined }),
    ).toBe("none");
  });
});

describe("getCapacitySourceLabel", () => {
  it("names the plan when subscribed", () => {
    expect(getCapacitySourceLabel("subscription", "Pro")).toBe("Pro plan");
    expect(getCapacitySourceLabel("subscription", null)).toBe("Active plan");
    expect(getCapacitySourceLabel("subscription", "")).toBe("Active plan");
  });

  it("the free tier is labelled as such, never as a paid plan", () => {
    expect(getCapacitySourceLabel("free", null)).toBe(
      "Included with the free plan",
    );
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

describe("formatPlanPrice", () => {
  it("abbreviates month and passes other intervals through", () => {
    expect(formatPlanPrice(12, "month")).toBe("12$/mo.");
    expect(formatPlanPrice(99, "year")).toBe("99$/year");
  });
});

describe("storage card renders Rust labels (H-109)", () => {
  it("does not formatBytes the raw counts", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../storage-overview/index.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/\bformatBytes\b/);
    expect(src).toContain("overview.usedDisplay");
    expect(src).toContain("overview.totalDisplay");
    expect(src).toContain("overview.freeDisplay");
  });
});
