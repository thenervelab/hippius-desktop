// Which of the Drive page's two views is on screen.
//
// The page renders the plan card in its header, above <Drive />, but only
// the Drive knows which view it is in. The obvious source, the URL, does not
// answer it: opening a synced drive from the folder list is a state change,
// not a navigation, so `/files` stays `/files` all the way into a drive and
// a URL-based check reports the folder list while a drive's contents are on
// screen.

import { atom } from "jotai";

/**
 * True while the Drive is showing its list of folders — the drive root.
 *
 * False inside a drive, at any depth, local or remote.
 *
 * Starts true because that is where the page opens, and `DriveContainer`
 * corrects it on mount. The page reads it to decide whether to draw the plan
 * card: that card is about the account's drive as a whole, so it belongs on
 * the view that is about the drive as a whole and nowhere below it.
 */
export const driveAtFolderListAtom = atom(true);
