import { atom } from "jotai";

import { updateStore } from "@/app/components/updater/updateStore";

/**
 * Whether the Explore Beta / Leave Beta dialog is open.
 *
 * Shares `updateStore` with the update dialog rather than creating a second
 * store: both are opened from the same address menu, both are about installing
 * a build, and one store means they cannot end up on screen together through a
 * race between two independent stores.
 */
export const channelDialogOpenAtom = atom(false);

export function openChannelDialog() {
  updateStore.set(channelDialogOpenAtom, true);
}

export function closeChannelDialog() {
  updateStore.set(channelDialogOpenAtom, false);
}
