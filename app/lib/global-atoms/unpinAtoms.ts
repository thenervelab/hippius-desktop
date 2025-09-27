import { atom } from "jotai";

// Atom to trigger unpinned files refetch
export const triggerUnpinnedFilesRefetchAtom = atom<number>(0);

// Atom to trigger sync path updates refresh
export const triggerSyncPathRefreshAtom = atom<number>(0);
