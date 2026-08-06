import { describe, expect, it } from "vitest";

import { isDeepLinkAlreadyProcessed } from "../deepLinkDedup";

const URL = "hippiusapp:///auth/callback?code=abc&username=u&id=1";
// Shape of the Rust-computed key: hex SHA-256 of the URL (value itself
// is opaque to the FE — only equality matters).
const KEY = "a".repeat(64);

describe("isDeepLinkAlreadyProcessed", () => {
  it("processes a link when nothing was stored", () => {
    expect(isDeepLinkAlreadyProcessed(null, URL, KEY)).toBe(false);
    expect(isDeepLinkAlreadyProcessed("", URL, KEY)).toBe(false);
  });

  it("skips a redelivery whose dedup key matches the stored marker", () => {
    expect(isDeepLinkAlreadyProcessed(KEY, URL, KEY)).toBe(true);
  });

  it("skips a redelivery matching a legacy raw-URL marker from a pre-fix build", () => {
    // An old build stored the raw URL; the updated build must still
    // recognize it once so the OS's initial-link redelivery is not
    // re-fired into complete_oauth_flow (which would reject it).
    expect(isDeepLinkAlreadyProcessed(URL, URL, KEY)).toBe(true);
  });

  it("processes a genuinely new callback", () => {
    const otherKey = "b".repeat(64);
    expect(isDeepLinkAlreadyProcessed(KEY, URL, otherKey)).toBe(false);
    expect(
      isDeepLinkAlreadyProcessed(
        "hippiusapp:///auth/callback?code=OLD",
        URL,
        otherKey,
      ),
    ).toBe(false);
  });

  it("falls back to raw-URL comparison when Rust supplied no key", () => {
    expect(isDeepLinkAlreadyProcessed(URL, URL, null)).toBe(true);
    expect(isDeepLinkAlreadyProcessed(KEY, URL, null)).toBe(false);
  });
});
