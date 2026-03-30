import { atomWithStorage } from "jotai/utils";
import { atom } from "jotai";

export const sidebarCollapsedAtom = atomWithStorage("sidebar-collapsed", false);
export const settingsDialogOpenAtom = atom(false);
export const settingsSidebarCollapsedAtom = atom(false);
export const activeSettingsTabAtom = atom("Sync & Storage"); // Default tab
export const activeSubMenuItemAtom = atom("");
export const isViewingRecentFilesAtom = atom(false);
