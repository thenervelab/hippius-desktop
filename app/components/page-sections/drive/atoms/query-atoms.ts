import { atom } from "jotai";

export const uploadProgressAtom = atom(0);
/** Reason the insufficient-credits dialog was opened, or `false` when closed. */
/**
 * Why the blocking dialog is open. Drive actions are refused for storage;
 * VM creation is the one action still refused for credits, so it keeps its
 * own reason and its own copy.
 */
export type InsufficientCreditsReason =
  "file-upload" | "folder-upload" | "folder-sync" | "vm-creation";
export const insufficientCreditsDialogOpenAtom = atom<
  InsufficientCreditsReason | false
>(false);

export const uploadToIpfsAndSubmitToBlockcahinRequestStateAtom = atom<
  "uploading" | "submitting" | "idle"
>("idle");
