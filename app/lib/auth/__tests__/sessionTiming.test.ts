import { describe, it, expect } from "vitest";
import {
  computeLogoutChunk,
  parseOAuthExpiryMs,
  MAX_LOGOUT_DELAY_MS,
} from "@/app/lib/auth/sessionTiming";

describe("computeLogoutChunk", () => {
  it("never fires for an Infinity ('keep me logged in') budget", () => {
    expect(computeLogoutChunk(Infinity)).toEqual({ kind: "never" });
  });

  it("fires after the exact delay for a sub-cap budget", () => {
    expect(computeLogoutChunk(1000)).toEqual({ kind: "fire", delayMs: 1000 });
  });

  it("fires immediately (clamped to 0) for a non-positive budget", () => {
    expect(computeLogoutChunk(0)).toEqual({ kind: "fire", delayMs: 0 });
    expect(computeLogoutChunk(-5000)).toEqual({ kind: "fire", delayMs: 0 });
  });

  it("fires (not chunks) exactly at the cap", () => {
    expect(computeLogoutChunk(MAX_LOGOUT_DELAY_MS)).toEqual({
      kind: "fire",
      delayMs: MAX_LOGOUT_DELAY_MS,
    });
  });

  it("chunks one past the cap, leaving the remainder", () => {
    expect(computeLogoutChunk(MAX_LOGOUT_DELAY_MS + 1)).toEqual({
      kind: "chunk",
      delayMs: MAX_LOGOUT_DELAY_MS,
      nextMs: 1,
    });
  });

  it("chunks a multi-cap budget down to zero across repeated calls", () => {
    // Simulate the recursive scheduleLogout loop: keep feeding nextMs back in
    // and confirm the chained delays sum to the original budget and terminate.
    let remaining = MAX_LOGOUT_DELAY_MS * 2 + 500;
    let summed = 0;
    let guard = 0;
    for (;;) {
      const chunk = computeLogoutChunk(remaining);
      expect(chunk.kind).not.toBe("never");
      if (chunk.kind === "fire") {
        summed += chunk.delayMs;
        break;
      }
      if (chunk.kind === "chunk") {
        summed += chunk.delayMs;
        remaining = chunk.nextMs;
      }
      expect(++guard).toBeLessThan(10); // must terminate
    }
    expect(summed).toBe(MAX_LOGOUT_DELAY_MS * 2 + 500);
  });
});

describe("parseOAuthExpiryMs", () => {
  it("returns null for absent or empty input", () => {
    expect(parseOAuthExpiryMs(null)).toBeNull();
    expect(parseOAuthExpiryMs("")).toBeNull();
  });

  it("parses a numeric epoch-ms string", () => {
    expect(parseOAuthExpiryMs("1782320000000")).toBe(1782320000000);
  });

  it("parses an ISO-8601 date string to epoch ms", () => {
    expect(parseOAuthExpiryMs("2026-06-24T00:00:00.000Z")).toBe(
      Date.parse("2026-06-24T00:00:00.000Z")
    );
  });

  it("yields NaN for an unparseable date string (documented legacy behavior)", () => {
    // Preserved from the inline original — restore_session treats NaN as
    // "no client expiry". Pinned so a future change to this branch is explicit.
    expect(parseOAuthExpiryMs("not-a-date")).toBeNaN();
  });

  it("yields NaN for an all-whitespace value (Number(' ') is 0, then parseInt is NaN)", () => {
    // Whitespace is truthy so it passes the null guard, but parseInt(' ') is
    // NaN — the same "no client expiry" outcome. Pinned to document the branch.
    expect(parseOAuthExpiryMs("   ")).toBeNaN();
  });
});
