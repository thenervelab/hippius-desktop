/**
 * The tray popover's two lists: the captures (what the Captures page shows,
 * decided by Rust's `get_recent_captures`) and every upload (the Recent
 * Files feed). Which one is open is presentation state, kept per viewer in
 * localStorage like the theme, never in Rust.
 */
export type TrayTab = "captures" | "all";

export const TRAY_TAB_STORAGE_KEY = "hippius-tray-tab";

/** The tab opened when nothing was remembered: the captures. */
export const DEFAULT_TRAY_TAB: TrayTab = "captures";

/**
 * The tab the viewer last chose. Storage can throw (a private window,
 * blocked site data); the popover must still open, on the default tab.
 */
export function readTrayTab(): TrayTab {
  try {
    const stored = window.localStorage.getItem(TRAY_TAB_STORAGE_KEY);
    return stored === "all" || stored === "captures" ? stored : DEFAULT_TRAY_TAB;
  } catch {
    return DEFAULT_TRAY_TAB;
  }
}

/** Remember the tab; a storage that refuses only costs the memory. */
export function saveTrayTab(tab: TrayTab): void {
  try {
    window.localStorage.setItem(TRAY_TAB_STORAGE_KEY, tab);
  } catch {
    // Nothing to do: the tab still switches, it is just not remembered.
  }
}
