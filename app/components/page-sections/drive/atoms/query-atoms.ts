import { atom } from "jotai";

export const uploadProgressAtom = atom(0);
/** Reason the insufficient-credits dialog was opened, or `false` when closed. */
export type InsufficientCreditsReason = "file-upload" | "folder-upload" | "folder-sync" | "vm-creation";
export const insufficientCreditsDialogOpenAtom = atom<InsufficientCreditsReason | false>(false);

export const uploadToIpfsAndSubmitToBlockcahinRequestStateAtom = atom<
  "uploading" | "submitting" | "idle"
>("idle");
