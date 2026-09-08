/**
 * Where in-app links point for money-related destinations.
 *
 * Billing lives in Settings, and everything about a plan — the catalogue,
 * the current subscription, the credit balance — is on that one page. The
 * standalone Subscription Plans page is gone: it showed a subset of what
 * Billing shows, so an upgrade prompt and a top-up prompt sent the user to
 * two different screens for one subject.
 *
 * A constant rather than the literal at each call site because there were
 * eight of them pointing at two different routes, which is how they came
 * to disagree in the first place.
 */
export const BILLING_ROUTE = "/settings?section=billing";
