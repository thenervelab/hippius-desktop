// Link activity across windows: Rust's events and the route that opens a
// link's Insights. Provider-free, so the tray popover can import it.

/** Rust (a notification's click) and the tray popover: open a link's Insights. */
export const OPEN_LINK_INSIGHTS_EVENT = "hippius:open-link-insights";
/** Rust saved a new link activity row. */
export const LINK_ACTIVITY_CHANGED_EVENT = "hippius:link-activity-changed";
/** The Shared Links page's parameter naming the link whose Insights to open. */
export const SHARES_INSIGHTS_PARAM = "insights";

/** One recent event, as `link_activity_recent` sends it. */
export interface RecentLinkActivity {
  id: number;
  /** `null` for one event about many links. */
  shareToken: string | null;
  line: string;
  /** Milliseconds since the epoch. */
  at: number;
}

/** The server's tokens are URL-safe; anything else is not one. */
function isToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/**
 * Where an open request goes: Shared Links with the link's Insights open, or
 * Shared Links alone. Rust writes the same route on each row (`insights_route`).
 */
export function linkInsightsRoute(shareToken: string | null): string {
  return isToken(shareToken) ? `/shares?${SHARES_INSIGHTS_PARAM}=${shareToken}` : "/shares";
}

/** The `{ shareToken }` payload, as a route; `null` when it is not one. */
export function routeFromOpenPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("shareToken" in payload)) return null;
  const token = (payload as { shareToken: unknown }).shareToken;
  if (token === null) return linkInsightsRoute(null);
  return isToken(token) ? linkInsightsRoute(token) : null;
}

/** "now", "12 min ago", "3 h ago", "Yesterday", then a date. */
export function activityAgo(at: number, now: number): string {
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
