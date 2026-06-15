import { describe, expect, it } from "vitest";
import { formatUploadedDate } from "../formatUploadedDate";

// Fixed reference instant: 2026-06-15 12:00:00 local time. Buckets are tested
// relative to this so the assertions don't depend on the wall clock.
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const ago = (ms: number) => NOW - ms;

describe("formatUploadedDate", () => {
  it("returns empty string for missing / invalid timestamps", () => {
    expect(formatUploadedDate(0, NOW)).toBe("");
    expect(formatUploadedDate(Number.NaN, NOW)).toBe("");
    expect(formatUploadedDate(-1, NOW)).toBe("");
  });

  it("shows 'Just now' only within the first ~20 seconds", () => {
    expect(formatUploadedDate(ago(5_000), NOW)).toBe("Just now");
    expect(formatUploadedDate(ago(19_999), NOW)).toBe("Just now");
  });

  it("shows seconds between ~20s and a minute (floored)", () => {
    expect(formatUploadedDate(ago(20_000), NOW)).toBe("20s ago");
    expect(formatUploadedDate(ago(30_000), NOW)).toBe("30s ago");
    expect(formatUploadedDate(ago(59_999), NOW)).toBe("59s ago");
  });

  it("shows minutes within the hour (floored)", () => {
    expect(formatUploadedDate(ago(5 * 60_000 + 59_000), NOW)).toBe("5m ago");
  });

  it("shows hours within the day (floored)", () => {
    expect(formatUploadedDate(ago(3 * 3_600_000), NOW)).toBe("3h ago");
  });

  it("shows days within the week (floored)", () => {
    expect(formatUploadedDate(ago(2 * 86_400_000), NOW)).toBe("2d ago");
  });

  it("falls back to a short date (no year) within the current year", () => {
    // ~10 days earlier → 2026-06-05, same year as NOW.
    const tenDaysAgo = new Date(2026, 5, 5, 9, 0, 0).getTime();
    expect(formatUploadedDate(tenDaysAgo, NOW)).toBe("5 Jun");
  });

  it("includes the year for dates in a different year", () => {
    const lastYear = new Date(2025, 0, 5, 9, 0, 0).getTime();
    expect(formatUploadedDate(lastYear, NOW)).toBe("5 Jan 2025");
  });

  it("uses the absolute form for future timestamps (clock skew)", () => {
    const future = new Date(2026, 7, 1, 9, 0, 0).getTime();
    expect(formatUploadedDate(future, NOW)).toBe("1 Aug");
  });
});
