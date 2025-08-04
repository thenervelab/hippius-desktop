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
