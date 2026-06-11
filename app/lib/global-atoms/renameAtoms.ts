// Jotai atom for the file/folder rename feature.
//
// Mirrors `sharesAtoms.shareModalFileAtom`: every action surface (files
// table, card view, right-click context menu, expanded folder rows) sets
// this atom and the single `RenameDialog` mounted in the pages layout
// reads it — no per-surface dialog instances.

import { atom } from "jotai";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * Open `RenameDialog` for this file or folder. `null` means closed.
 *
 * Storing the whole file lets the dialog derive the current basename and
 * the IPC payload (`name`/`source`/`label`) without a second lookup.
 */
export const renameModalFileAtom = atom<FormattedUserFile | null>(null);
