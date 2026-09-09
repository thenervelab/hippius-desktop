import { atomWithStorage } from "jotai/utils";
import { atom } from "jotai";
import type { NavReclick } from "./navReclick";

export const sidebarCollapsedAtom = atomWithStorage("sidebar-collapsed", false);
export const activeSubMenuItemAtom = atom("");
export const isViewingRecentFilesAtom = atom(false);

/**
 * The last sidebar item clicked while the user was ALREADY on its route,
 * as a monotonically increasing nonce.
 *
 * Next's `<Link>` to the current route does not remount the page, so a
 * page holding its own view state — the Drive page's open folder — has no
 * way to notice the click and keeps showing wherever the user had
 * navigated to. Clicking "Drive" from inside a folder therefore did
 * nothing, which reads as a broken link.
 *
 * The nonce, not a boolean: two clicks in a row must both register.
 * Consumers key on `href` so this stays a generic signal rather than one
 * page's private channel.
 */
export const navReclickAtom = atom<NavReclick | null>(null);
