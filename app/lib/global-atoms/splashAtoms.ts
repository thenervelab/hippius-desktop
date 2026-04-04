import { atom } from "jotai";

/** Set to true when the splash screen setup is fully complete.
 *  Used by wallet-auth-context to defer sync init until the main screen is ready. */
export const splashCompleteAtom = atom<boolean>(false);
