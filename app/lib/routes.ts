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

/**
 * Open one folder on the Drive page.
 *
 * Settings and Drive are separate routes, so "open this folder" has to
 * survive a navigation. It travels as a query param rather than an atom
 * because an atom is lost on a full page load, and this is also a
 * perfectly good deep link.
 *
 * `remote` distinguishes a folder synced on this machine from one that is
 * only on the server — the two open through different paths on the Drive
 * page, and guessing from the label alone is the H-077 mistake.
 */
export function driveFolderRoute(label: string, remote: boolean): string {
  const params = new URLSearchParams({ openLabel: label });
  if (remote) params.set("openRemote", "1");
  return `/files?${params.toString()}`;
}
