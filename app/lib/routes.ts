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

/** The Shared Drives page: drives shared with this account, and the ones it shared. */
export const SHARED_DRIVES_ROUTE = "/shared-drives";

/**
 * Open a drive somebody shared with this account, or a folder of one, on the
 * Drive page without syncing it here. `label` is its browse label
 * (`makeSharedDriveLabel` / `makeFolderGrantLabel`), which browses like any
 * server-only drive; `name` is what the breadcrumb shows instead of that
 * label, which names the owner and a hash rather than anything a person
 * would recognise.
 */
export function sharedDriveRoute(label: string, name: string): string {
  return openDriveHref("/files", { label, remote: true, name });
}

/** A drive to open at its root: the fields `driveFolderRoute` and `sharedDriveRoute` carry. */
export interface DriveToOpen {
  label: string;
  /** Not synced on this computer: browsed from the server. */
  remote: boolean;
  /** What the breadcrumb shows for a shared drive's browse label. */
  name?: string | null;
}

/**
 * `basePath` with one drive open at its root. The Drive page clears these
 * params once the drive is open; the Shared Drives page keeps them, since
 * there they are the only record of which drive is on screen.
 */
export function openDriveHref(basePath: string, drive: DriveToOpen): string {
  const params = new URLSearchParams({ openLabel: drive.label });
  if (drive.remote) params.set("openRemote", "1");
  if (drive.name) params.set("openName", drive.name);
  return `${basePath}?${params.toString()}`;
}

/**
 * Open a drive from the Shared Drives page on that page, rather than on the
 * Drive page: the breadcrumb then reads "Shared Drives › drive", Back from
 * the drive's root returns to the list, and the sidebar keeps Shared Drives
 * selected.
 */
export function sharedDrivesDriveRoute(drive: DriveToOpen): string {
  return openDriveHref(SHARED_DRIVES_ROUTE, drive);
}
