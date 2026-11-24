// Which delete a Delete click runs, and the state the drive views share to
// run it from anywhere (row menus, the right-click menu, the viewer, the
// keyboard).

import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { driveTrashEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { getUserPreference, saveUserPreference } from "@/app/lib/utils/userPreferencesDb";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * - `legacy`: the server has no Trash. Today's delete and its words, exactly.
 * - `trash`: Move to Trash, no confirm, Undo.
 * - `forever`: delete for good, always confirmed.
 */
export type DeleteMode = "legacy" | "trash" | "forever";

/** Pure: the mode a Delete runs in. */
export function resolveDeleteMode(trashEnabled: boolean, skipTrash: boolean, optionHeld: boolean): DeleteMode {
  if (!trashEnabled) return "legacy";
  return skipTrash || optionHeld ? "forever" : "trash";
}

/** The menu and button label for a mode. */
export function deleteLabel(mode: DeleteMode): string {
  if (mode === "trash") return "Move to Trash";
  if (mode === "forever") return "Delete forever";
  return "Delete";
}

/** The preference key, per account: the setting follows the account. */
export function skipTrashKey(address: string): string {
  return `drive_skip_trash:${address}`;
}

/**
 * The signed-in address, or null where no account provider is mounted (a
 * surface rendered alone). `useWalletAuth` reads its context before it
 * throws, so the hook order is the same either way.
 */
function useAccountAddress(): string | null {
  try {
    return useWalletAuth().polkadotAddress;
  } catch {
    return null;
  }
}

/** "Skip Trash when deleting", per account. `null` until read. */
export const skipTrashAtom = atom<{ address: string; value: boolean } | null>(null);

/** Read once per account, saved on change. Off by default. */
export function useSkipTrash(): { skipTrash: boolean; loaded: boolean; setSkipTrash: (value: boolean) => Promise<void> } {
  const polkadotAddress = useAccountAddress();
  const [state, setState] = useAtom(skipTrashAtom);
  const current = state && state.address === polkadotAddress ? state : null;
  useEffect(() => {
    if (!polkadotAddress || current) return;
    let alive = true;
    void getUserPreference<boolean>(skipTrashKey(polkadotAddress)).then((value) => {
      if (alive) setState({ address: polkadotAddress, value: value === true });
    });
    return () => {
      alive = false;
    };
  }, [polkadotAddress, current, setState]);
  const setSkipTrash = useCallback(
    async (value: boolean) => {
      if (!polkadotAddress) return;
      setState({ address: polkadotAddress, value });
      await saveUserPreference(skipTrashKey(polkadotAddress), value);
    },
    [polkadotAddress, setState],
  );
  return { skipTrash: current?.value === true, loaded: current !== null, setSkipTrash };
}

/**
 * Whether Option (Alt) is held now: Finder's convention for turning Move to
 * Trash into Delete forever. Released on blur, so a held key that never
 * reported its release cannot stick.
 */
export function useOptionKeyHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => setHeld(e.altKey);
    const up = (e: KeyboardEvent) => setHeld(e.altKey);
    const reset = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", reset);
    };
  }, []);
  return held;
}

/** The mode a Delete click runs in right now. */
export function useDeleteMode(): DeleteMode {
  const trashEnabled = useAtomValue(driveTrashEnabledAtom);
  const { skipTrash } = useSkipTrash();
  const optionHeld = useOptionKeyHeld();
  return resolveDeleteMode(trashEnabled, skipTrash, optionHeld);
}

/**
 * A Move to Trash asked for outside the view that runs deletes (the
 * right-click menu, the viewer). The drive view's `TrashRequestRunner`
 * carries it out.
 */
export const trashRequestAtom = atom<{ id: number; files: FormattedUserFile[] } | null>(null);

/**
 * Set by a "Delete forever" chosen from a menu after it selected the row:
 * the selection bar opens its Delete forever confirmation and clears it.
 */
export const deleteForeverPromptAtom = atom(false);

/**
 * The Delete item every drive menu shows: its label for the mode, and what
 * it does. `selectForDelete` is the view's own path into the selection bar
 * (today's Delete); Move to Trash skips it and runs at once.
 */
export function useDeleteMenuAction(): {
  mode: DeleteMode;
  label: string;
  run: (file: FormattedUserFile, selectForDelete: () => void) => void;
} {
  const mode = useDeleteMode();
  const setTrash = useSetAtom(trashRequestAtom);
  const setPrompt = useSetAtom(deleteForeverPromptAtom);
  const run = useCallback(
    (file: FormattedUserFile, selectForDelete: () => void) => {
      if (mode === "trash") {
        setTrash({ id: Date.now() + Math.random(), files: [file] });
        return;
      }
      selectForDelete();
      if (mode === "forever") setPrompt(true);
    },
    [mode, setTrash, setPrompt],
  );
  return { mode, label: deleteLabel(mode), run };
}

/** Carries out Move to Trash requests from outside the view (menus, viewer). */
export function TrashRequestRunner({ onTrash }: { onTrash: (files: FormattedUserFile[]) => void }): null {
  const [request, setRequest] = useAtom(trashRequestAtom);
  useEffect(() => {
    if (!request) return;
    setRequest(null);
    onTrash(request.files);
  }, [request, setRequest, onTrash]);
  return null;
}
