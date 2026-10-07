import type { StorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import type { CaptureDriveStatus } from "@/app/lib/tauri/capture";

/**
 * The tray popover's ⋮ menu: what it says and where each item goes. Pure,
 * so the wording and the routing are tested without a webview.
 */

/**
 * Backend event the popover emits with `{ page }` to send the main window
 * somewhere. `TrayNavigationListener` routes it. The popover never names a
 * route or a URL itself: the payload crosses a webview, so the main window
 * maps a closed set of names to its own routes and drops anything else.
 */
export const TRAY_OPEN_PAGE_EVENT = "hippius:tray-open-page";

export type TrayPage = "plans" | "settings" | "support" | "captures" | "top-up";

const PAGES: ReadonlySet<TrayPage> = new Set(["plans", "settings", "support", "captures", "top-up"]);

/** The `{ page }` payload, or null when it is not one we know. */
export function parseTrayPagePayload(payload: unknown): TrayPage | null {
  if (!payload || typeof payload !== "object") return null;
  const page = (payload as { page?: unknown }).page;
  return typeof page === "string" && PAGES.has(page as TrayPage) ? (page as TrayPage) : null;
}

/**
 * Where a page lives in the main window. `top-up` is not a page of the app:
 * credits are bought on the console (`openLinkByKey("CREDITS")`, as every
 * other Top up does), so it has no route.
 */
export function trayPageRoute(page: TrayPage): string | null {
  switch (page) {
    case "plans":
      return "/drive-plans";
    case "settings":
      return "/settings";
    case "support":
      return "/support";
    case "captures":
      return "/captures";
    case "top-up":
      return null;
  }
}

/**
 * The Plan row: "Plus · 640 GB / 2 TB", "Free · 0.3 GB / 10 GB". Every
 * figure is Rust's own display string from `get_storage_overview` (a plan
 * quotes its marketed size, the free tier its effective total), so the
 * popover cannot round a number differently from the Plans page. Null while
 * the overview is not known.
 */
export function trayPlanLine(overview: StorageOverview | null): string | null {
  if (!overview) return null;
  let name: string;
  let total: string;
  if (overview.source === "subscription") {
    name = overview.plan?.name || "Plan";
    total = overview.plan?.storageDisplay || overview.totalDisplay;
  } else if (overview.source === "free") {
    name = "Free";
    total = overview.totalDisplay;
  } else {
    return "No storage plan";
  }
  // Rust says when its count is still catching up; a confident "0 B" then
  // would be wrong.
  if (overview.usedPending) return `${name} · Updating…`;
  return `${name} · ${overview.usedDisplay} / ${total}`;
}

/** The keys the menu answers while the popover has the keyboard. */
export type TrayMenuShortcut = "open" | "settings" | "quit";

const SHORTCUT_KEYS: Record<TrayMenuShortcut, string> = {
  open: "o",
  settings: ",",
  quit: "q",
};

/**
 * Which item a key press is: ⌘ on a Mac, Ctrl elsewhere, with no other
 * modifier, so ⇧⌘O and the like stay free.
 */
export function trayMenuShortcutFor(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  isMac: boolean,
): TrayMenuShortcut | null {
  const command = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!command || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  for (const id of Object.keys(SHORTCUT_KEYS) as TrayMenuShortcut[]) {
    if (SHORTCUT_KEYS[id] === key) return id;
  }
  return null;
}

/** "⌘O" on a Mac, "Ctrl+O" elsewhere. */
export function trayShortcutLabel(id: TrayMenuShortcut, isMac: boolean): string {
  const key = SHORTCUT_KEYS[id].toUpperCase();
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}

/**
 * "Open captures folder": the captures drive's folder on this computer when
 * it is synced here (revealed in Finder or Explorer), else the Captures page
 * in the main window, which shows a drive that is only on the server and
 * offers to set one up when there is none yet. Rust says which
 * (`capture_drive_status`).
 */
export function capturesFolderTarget(
  status: CaptureDriveStatus | null,
): { kind: "reveal"; label: string } | { kind: "page" } {
  if (status?.state === "ready" && status.location && !status.remote) {
    return { kind: "reveal", label: status.label };
  }
  return { kind: "page" };
}
