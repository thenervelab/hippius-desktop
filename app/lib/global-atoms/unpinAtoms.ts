import { atom } from "jotai";

// Atom to trigger unpinned files refetch
export const triggerUnpinnedFilesRefetchAtom = atom<number>(0);
