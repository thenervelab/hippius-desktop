import { atomWithStorage } from "jotai/utils";
import { atom } from "jotai";

export const sidebarCollapsedAtom = atomWithStorage("sidebar-collapsed", false);
export const activeSubMenuItemAtom = atom("");
export const isViewingRecentFilesAtom = atom(false);
