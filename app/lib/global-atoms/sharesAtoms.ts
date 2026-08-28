// Jotai atoms for the file-sharing feature.
//
// We keep these split out from `unpinAtoms.ts` because the share
// lifecycle is independent of sync drive state — old code paths
// shouldn't accidentally couple to the share UI.

import { atom } from "jotai";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { ServerCapabilities } from "@/app/lib/tauri/shares";

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
 * Derived: does the connected server support browsable folder shares
 * (`/v1/folder-shares`)? Unlike file shares this is NOT hard-coded on: the
 * endpoint only exists on new servers, so the folder "Share via link" items
 * disable (with a tooltip) until the capability is confirmed. `null`
 * capabilities (not yet fetched) collapse to `false` — disabled until known.
 */
export const folderShareFeatureEnabledAtom = atom((get) => {
  const caps = get(serverCapabilitiesAtom);
  return caps?.folder_shares === true;
});

/**
 * What `ShareFileModal` is currently sharing. `null` means closed.
 *
 * Storing the file (rather than just `(label, name)`) lets the modal render
 * `<filename>` while the share is in flight without a second IPC round-trip to
 * fetch metadata.
 *
 * `relativePath` is resolved by the surface that OPENS the modal, not derived
 * inside it. A nested folder row's `actualFileName` holds only the basename —
 * the containing path lives in `parentRelativePath` or in the table's
 * `currentSubfolderPath` — so the modal has no way to work it out on its own,
 * and guessing would mint a share for a different folder of the same name at
 * the drive root. See `folderShareRelativePath`.
 */
export type ShareModalTarget = {
  file: FormattedUserFile;
  relativePath: string;
};

export const shareModalFileAtom = atom<ShareModalTarget | null>(null);

/**
 * A pending "Share with Hippius" request from the macOS Finder right-click, as
 * seen by `ShareFileModal`. `null` means no Finder share is open.
 *
 * The redesign moved the public/private decision into the app (Google-Drive
 * model): the backend no longer mints on click — it emits `finder:share-choosing`
 * with the parked request's `id` + display `name`, and the modal opens its
 * chooser. So this atom carries exactly ONE state, `choosing`; the subsequent
 * `running → done`/`error` lifecycle is local `ShareFileModal` state driven by
 * the {@link confirmFinderShare} call (symmetric with the in-app
 * {@link shareModalFileAtom} → `createShare` flow). The `id` is echoed back to
 * the confirm/cancel IPC so the backend mints the file it resolved, never one
 * the renderer names.
 */
export type FinderShareState = { kind: "choosing"; id: string; name: string };

export const finderShareAtom = atom<FinderShareState | null>(null);

/**
 * What `ShareDriveModal` (invite + members management for an OWN shared
 * drive) is currently open on. `null` means closed. Same singleton-atom
 * pattern as {@link shareModalFileAtom}: the modal is mounted once in the
 * pages layout and any surface opens it by setting this atom.
 *
 * `label` is the local drive label (the IPC key); `folderName` is the
 * user-facing basename shown in the modal header. Only own drives may be
 * set here — the "Share drive…" menu item is hidden for member rows
 * (`folderMenuGating.ts`), and the backend refuses a member label anyway.
 */
export type ShareDriveModalTarget = {
  label: string;
  folderName: string;
};

export const shareDriveModalAtom = atom<ShareDriveModalTarget | null>(null);
