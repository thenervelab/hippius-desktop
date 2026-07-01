// Jotai atoms for the file-sharing feature.
//
// We keep these split out from `unpinAtoms.ts` because the share
// lifecycle is independent of sync drive state — old code paths
// shouldn't accidentally couple to the share UI.

import { atom } from "jotai";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type {
  FinderShareCreated,
  ServerCapabilities,
} from "@/app/lib/tauri/shares";

/**
 * Cached server capabilities. Populated once after login by
 * `useServerCapabilities` and refreshed on reconnect; `null` means
 * "not yet known" — consumers should treat that as "hide the feature
 * until we know" rather than "feature available".
 */
export const serverCapabilitiesAtom = atom<ServerCapabilities | null>(null);

/**
 * Derived: should the share UI surfaces (context-menu item, "My Shares"
 * page link) render at all?
 *
 * TEMPORARY (2026-05-06): hard-coded to `false` to ship a release
 * without the share-via-link feature. Every share entry point in the
 * app reads this atom, so flipping it here hides the whole surface
 * (sidebar nav, context menu, files header, card/table affordances,
 * `useSharedFiles` query, and the `/shares` page's unavailable state).
 *
 * To re-enable next release, restore the original derivation:
 *
 *   export const shareFeatureEnabledAtom = atom((get) => {
 *     const caps = get(serverCapabilitiesAtom);
 *     return caps?.shares === true;
 *   });
 *
 * The capability fetch in `useServerCapabilities` is intentionally
 * left running — its result is ignored while disabled, but keeping it
 * means the re-enable PR is a single-line revert with no behavioural
 * coupling to untangle.
 */
export const shareFeatureEnabledAtom = atom(() => true);

/**
 * Open `ShareFileModal` for this file. `null` means closed.
 *
 * Storing the file (rather than just `(label, name)`) lets the modal
 * render `<filename>` while the share is in flight without a second
 * IPC round-trip to fetch metadata.
 */
export const shareModalFileAtom = atom<FormattedUserFile | null>(null);

/**
 * The lifecycle of a share minted from the macOS Finder right-click flow, as
 * seen by `ShareFileModal`. `null` means the modal is closed.
 *
 * Unlike an in-app share (driven by {@link shareModalFileAtom} through a
 * `running → done` `createShare` call), a Finder share is minted entirely in
 * Rust. But the mint can take many seconds for a big file or a folder-zip, so
 * the backend brackets it with three events the modal maps here:
 *
 *   - `finder:share-started` → `pending`: opens the modal into a spinner
 *     immediately, before the finished link exists, so the click is never
 *     silent.
 *   - `finder:share-created` → `done`: the ready link (public `#k=`, or a
 *     private `#p=` link carrying its generated `password`).
 *   - `finder:share-failed` → `failed`: the mint errored; show a message
 *     instead of a spinner that never resolves.
 *
 * Keeping this separate from the in-app driver means neither flow has to
 * special-case the other's states.
 */
export type FinderShareState =
  | { kind: "pending"; name: string; private: boolean }
  | { kind: "done"; share: FinderShareCreated }
  | { kind: "failed"; name: string; message: string };

export const finderShareAtom = atom<FinderShareState | null>(null);
