import { atom } from "jotai";

export const uploadProgressAtom = atom(0);
export const insufficientCreditsDialogOpenAtom = atom(false);

export const uploadToIpfsAndSubmitToBlockcahinRequestStateAtom = atom<
  "uploading" | "submitting" | "idle"
>("idle");
