import { atomWithStorage } from "jotai/utils";
import { atom } from "jotai";

export const sidebarCollapsedAtom = atomWithStorage("sidebar-collapsed", false);
export const settingsDialogOpenAtom = atom(false);
export const activeSettingsTabAtom = atom("Change Passcode"); // Default tab
