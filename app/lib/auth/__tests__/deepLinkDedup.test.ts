import { describe, expect, it } from "vitest";

import {
  DEEP_LINK_DEDUP_TTL_MS,
  isDeepLinkAlreadyProcessed,
} from "../deepLinkDedup";

const URL = "hippiusapp:///auth/callback?code=abc&username=u&id=1";
// Shape of the Rust-computed key: hex SHA-256 of the URL (value itself
// is opaque to the FE — only equality matters).
const KEY = "a".repeat(64);
const NOW = 1_700_000_000_000;
// A marker written moments ago — well inside the TTL.
const FRESH = NOW - 1_000;

describe("isDeepLinkAlreadyProcessed", () => {
  it("processes a link when nothing was stored", () => {
    expect(isDeepLinkAlreadyProcessed(null, null, NOW, URL, KEY)).toBe(false);
    expect(isDeepLinkAlreadyProcessed("", FRESH, NOW, URL, KEY)).toBe(false);
  });

  it("skips a recent redelivery whose dedup key matches the stored marker", () => {
    expect(isDeepLinkAlreadyProcessed(KEY, FRESH, NOW, URL, KEY)).toBe(true);
  });

  it("skips a recent redelivery matching a legacy raw-URL marker from a pre-fix build", () => {
    // An old build stored the raw URL; the updated build must still
    // recognize it once so the OS's initial-link redelivery is not
    // re-fired into complete_oauth_flow (which would reject it).
    expect(isDeepLinkAlreadyProcessed(URL, FRESH, NOW, URL, KEY)).toBe(true);
  });

  it("processes a genuinely new callback", () => {
    const otherKey = "b".repeat(64);
    expect(isDeepLinkAlreadyProcessed(KEY, FRESH, NOW, URL, otherKey)).toBe(false);
    expect(
      isDeepLinkAlreadyProcessed(
        "hippiusapp:///auth/callback?code=OLD",
        FRESH,
        NOW,
        URL,
        otherKey,
      ),
    ).toBe(false);
  });

  it("falls back to raw-URL comparison when Rust supplied no key", () => {
    expect(isDeepLinkAlreadyProcessed(URL, FRESH, NOW, URL, null)).toBe(true);
    expect(isDeepLinkAlreadyProcessed(KEY, FRESH, NOW, URL, null)).toBe(false);
  });

  // M-4: the marker must EXPIRE. A permanently latched marker made
  // re-clicking the console's "Open Hippius" button after a failed
  // attempt a silent no-op for the life of the install.
  it("stops suppressing once the marker is older than the TTL", () => {
    const stale = NOW - DEEP_LINK_DEDUP_TTL_MS - 1;
    expect(isDeepLinkAlreadyProcessed(KEY, stale, NOW, URL, KEY)).toBe(false);
    // Boundary: exactly at the TTL still suppresses.
    const atTtl = NOW - DEEP_LINK_DEDUP_TTL_MS;
    expect(isDeepLinkAlreadyProcessed(KEY, atTtl, NOW, URL, KEY)).toBe(true);
  });

  it("treats a marker with no recorded time as stale", () => {
    expect(isDeepLinkAlreadyProcessed(KEY, null, NOW, URL, KEY)).toBe(false);
    expect(isDeepLinkAlreadyProcessed(KEY, Number.NaN, NOW, URL, KEY)).toBe(false);
  });
});
