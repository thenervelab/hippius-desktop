import { atom } from "jotai";

/**
 * Where a new folder should be created.
 *
 * `local` makes a directory inside a drive this device syncs; `remote`
 * registers a folder entity on a drive that is only browsed. Two commands
 * because they are genuinely different operations, not one with a flag —
 * see `files/new_folder.rs`.
 *
 * `label` absent means the default drive, and `parentPath` absent means
 * that drive's root. Both are the right answer on the surfaces with no
 * folder open — Overview and the drive list — where "here" is the main
 * drive.
 */
export interface NewFolderTarget {
  kind: "local" | "remote";
  label?: string;
  parentPath?: string;
}

/** Open the shared New Folder dialog for this target; `null` is closed. */
export const newFolderTargetAtom = atom<NewFolderTarget | null>(null);

/**
 * What the right-click menu should offer on the surface currently shown.
 *
 * Registered by the page rather than sniffed from the DOM: the menu items
 * are the same actions the page's own toolbar runs, and routing both
 * through one set is what stops the menu offering something the toolbar
 * does not — or doing it to a different folder.
 *
 * Every field is optional. An action that is absent is simply not listed,
 * which is how the drive list drops "New Folder in this folder" and how
 * Overview drops "Sync a Folder".
 */
export interface PageContextActions {
  onUploadFile?: () => void;
  onUploadFolder?: () => void;
  onSyncFolder?: () => void;
  /** Where New Folder creates. Defaults to the main drive's root. */
  newFolderTarget?: NewFolderTarget;
}

export const pageContextActionsAtom = atom<PageContextActions>({});
