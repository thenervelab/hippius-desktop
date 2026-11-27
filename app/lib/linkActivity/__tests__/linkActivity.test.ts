import { describe, expect, it } from "vitest";

import { activityAgo, linkInsightsRoute, routeFromOpenPayload } from "../linkActivity";

describe("link activity routes", () => {
  it("opens a link's Insights from Shared Links, the route Rust writes on each row", () => {
    // Rust's `insights_route` writes "/shares?insights=<token>".
    expect(linkInsightsRoute("tok_A-1")).toBe("/shares?insights=tok_A-1");
    expect(linkInsightsRoute(null)).toBe("/shares");
  });

  it("takes only a token from another window, never a route", () => {
    expect(routeFromOpenPayload({ shareToken: "abc" })).toBe("/shares?insights=abc");
    expect(routeFromOpenPayload({ shareToken: null })).toBe("/shares");
    expect(routeFromOpenPayload({ shareToken: "/settings" })).toBeNull();
    expect(routeFromOpenPayload({ shareToken: "a&b=c" })).toBeNull();
    expect(routeFromOpenPayload({})).toBeNull();
    expect(routeFromOpenPayload("abc")).toBeNull();
  });
});

describe("activityAgo", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  it("says how long ago, briefly", () => {
    expect(activityAgo(now - 20_000, now)).toBe("now");
    expect(activityAgo(now - 12 * 60_000, now)).toBe("12 min ago");
    expect(activityAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(activityAgo(now - 30 * 3_600_000, now)).toBe("Yesterday");
    expect(activityAgo(now - 5 * 86_400_000, now)).toBe(
      new Date(now - 5 * 86_400_000).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
  });
});
