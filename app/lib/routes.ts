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
export function driveFolderRoute(label: string, remote: boolean, subfolder?: string, openFile?: string): string {
  const params = new URLSearchParams({ openLabel: label });
  if (remote) params.set("openRemote", "1");
  // Into the drive, e.g. a capture's "Show in folder" → Captures.
  if (subfolder) params.set("openSubfolder", subfolder);
  // The file to point out once that folder is listed ("Show in folder" from
  // a capture's card or the sync queue): its row is paged to, scrolled into
  // view and highlighted.
  if (openFile) params.set("openFile", openFile);
  return `/files?${params.toString()}`;
}

/** The Captures page, which shows the captures drive. */
export const CAPTURES_ROUTE = "/captures";

/**
 * The Captures page pointing out one capture ("Show in folder" on a capture's
 * card). The same params as `driveFolderRoute`, read by the same Drive
 * container, which the Captures page pins to the captures drive.
 */
export function capturesRoute(label: string, remote: boolean, openFile?: string): string {
  const params = new URLSearchParams({ openLabel: label });
  if (remote) params.set("openRemote", "1");
  if (openFile) params.set("openFile", openFile);
  return `${CAPTURES_ROUTE}?${params.toString()}`;
}
