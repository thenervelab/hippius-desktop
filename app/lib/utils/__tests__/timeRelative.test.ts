import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRelative } from "../timeRelative";

const NOW = new Date("2026-04-30T12:00:00Z").getTime();

describe("formatRelative", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => vi.useRealTimers());

  it("returns '<1m ago' for very recent past", () => {
    expect(formatRelative("2026-04-30T11:59:30Z")).toBe("<1m ago");
  });

  it("returns 'in <1m' for very near future", () => {
    expect(formatRelative("2026-04-30T12:00:30Z")).toBe("in <1m");
  });

  it("returns minutes for sub-hour gaps", () => {
    expect(formatRelative("2026-04-30T12:05:00Z")).toBe("in 5m");
    expect(formatRelative("2026-04-30T11:55:00Z")).toBe("5m ago");
  });

  it("returns hours for sub-day gaps", () => {
    expect(formatRelative("2026-04-30T15:00:00Z")).toBe("in 3h");
  });

  it("returns days for >=1d gaps", () => {
    expect(formatRelative("2026-05-04T12:00:00Z")).toBe("in 4d");
  });

  it("returns the input string for unparseable values", () => {
    expect(formatRelative("not-a-date")).toBe("not-a-date");
  });
});
