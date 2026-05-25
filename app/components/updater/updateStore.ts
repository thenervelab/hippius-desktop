import { atom, createStore } from "jotai";

// Create a dedicated store for update-related state
export const updateStore = createStore();

// Update dialog atoms
export const updateDialogOpenAtom = atom(false);
export const updateInfoAtom = atom<{
  version: string;
  body: string;
  size?: number;
} | null>(null);
export const updateConfirmedAtom = atom<boolean | null>(null);

// Update check completion status
export const updateCheckCompleteAtom = atom(false);

/* --- Dev-only overrides --- *
 * When non-null, UpdateDialog renders the forced state instead of the
 * one driven by tauri's check() / downloadAndInstall lifecycle. The
 * dialog only reads these atoms inside a process.env.NODE_ENV check, so
 * the override path is dead-code-eliminated from production bundles —
 * the atoms themselves are tiny so we don't bother gating their export.
 */
export type ForcedUpdateStatus =
  | "checking"
  | "available"
  | "no-update"
  | "downloading"
  | "installing"
  | "complete"
  | "error";

export const forcedStatusAtom = atom<ForcedUpdateStatus | null>(null);
export const forcedProgressAtom = atom<number>(40);

// Helper functions to interact with the store
export function openUpdateDialog(updateInfo: { version: string; body: string; size?: number }) {
  updateStore.set(updateInfoAtom, updateInfo);
  updateStore.set(updateConfirmedAtom, null);
  updateStore.set(updateDialogOpenAtom, true);
}

export function closeUpdateDialog() {
  updateStore.set(updateDialogOpenAtom, false);
}

export function confirmUpdate(confirmed: boolean) {
  updateStore.set(updateConfirmedAtom, confirmed);
}

export function getUpdateConfirmation(): boolean | null {
  return updateStore.get(updateConfirmedAtom);
}
