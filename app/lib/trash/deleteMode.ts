// Which delete a Delete click runs, and the state the drive views share to
// run it from anywhere (row menus, the right-click menu, the viewer, the
// keyboard).

import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { driveTrashEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import {
  getTrashDeleteRules,
  setSkipTrash as saveSkipTrash,
  type DriveDeleteRule as TauriDriveDeleteRule,
  type TrashDeleteRules,
} from "@/app/lib/tauri/trash";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { isCloudOnlyRow } from "@/app/lib/utils/cloudOnly";

/**
 * - `legacy`: the server has no Trash. Today's delete and its words, exactly.
 * - `trash`: Move to Trash, no confirm, Undo.
 * - `forever`: delete for good, always confirmed.
 */
export type DeleteMode = "legacy" | "trash" | "forever";

/**
 * Pure: the mode a Delete runs in. `skipsTrash`: "Skip Trash when deleting"
 * applies to every item (it does on the account's own drives only).
 * `canDeleteForever`: every item is in a drive this account owns or
 * manages; where it is not, Delete always moves to Trash, Option or not.
 * Both come from Rust (`get_trash_delete_rules`).
 */
export function resolveDeleteMode(
  trashEnabled: boolean,
  skipsTrash: boolean,
  optionHeld: boolean,
  canDeleteForever: boolean = true,
): DeleteMode {
  if (!trashEnabled) return "legacy";
  if (!canDeleteForever) return "trash";
  return skipsTrash || optionHeld ? "forever" : "trash";
}

/**
 * Pure: whether a row's menus offer its Delete item at all.
 *
 * A row with a copy on this computer always does (today's Delete, or Move
 * to Trash). A row with none (browsed from the server, or not downloaded
 * here) does only while the server has Trash, since Rust then trashes it
 * on Hippius, and only where this account can write (`canWrite`, from
 * `offersWriteAction`). With Trash off such a row has no delete: today's
 * delete removes the local copy, which it does not have. A whole drive is
 * never a row here: drives do not go to Trash.
 */
export function offersDeleteOnRow(
  file: FormattedUserFile,
  trashEnabled: boolean,
  canWrite: boolean,
): boolean {
  if (!isCloudOnlyRow(file)) return true;
  return trashEnabled && canWrite && !file.isDriveRoot;
}

/** The menu and button label for a mode. */
export function deleteLabel(mode: DeleteMode): string {
  if (mode === "trash") return "Move to Trash";
  if (mode === "forever") return "Delete forever";
  return "Delete";
}

/** Rust's delete rules for one synced drive (`DriveDeleteRule`). */
export type DriveDeleteRule = TauriDriveDeleteRule;

/** The drive a row's delete goes to: its label, else the default drive. */
export function rowDriveLabel(file: Pick<FormattedUserFile, "label">): string {
  return file.label || "default";
}

/**
 * Pure: what the rules allow for some rows. A drive the rules do not list
 * (still loading, or added since) allows nothing beyond Move to Trash,
 * which can always be undone.
 */
export function deleteScope(
  drives: DriveDeleteRule[] | null | undefined,
  labels: string[],
): { skipsTrash: boolean; canDeleteForever: boolean } {
  if (!drives || labels.length === 0) return { skipsTrash: false, canDeleteForever: false };
  const rules = labels.map((label) => drives.find((d) => d.label === label));
  return {
    skipsTrash: rules.every((r) => r?.skipsTrash === true),
    canDeleteForever: rules.every((r) => r?.canDeleteForever === true),
  };
}

/**
 * Pure: whether the sync engine sends a drive's released deletes to
 * Hippius Trash: the server has Trash and the drive does not skip it. An
 * unknown drive says no, so the words never promise a Trash that is not.
 */
export function engineSendsDeletesToTrash(trashEnabled: boolean, drives: DriveDeleteRule[] | null | undefined, label: string): boolean {
  const rule = drives?.find((d) => d.label === label);
  return trashEnabled && rule !== undefined && !rule.skipsTrash;
}

/** "Skip Trash when deleting" and the drives' rules, per account. `null` until read. */
export const deleteRulesAtom = atom<{ address: string; skipTrash: boolean; drives: DriveDeleteRule[]; at: number } | null>(null);

/** Rules older than this are read again by the next surface that needs them (a drive added since). */
const RULES_FRESH_MS = 60_000;

const inFlight = new Map<string, Promise<TrashDeleteRules>>();

function fetchRules(address: string): Promise<TrashDeleteRules> {
  const running = inFlight.get(address);
  if (running) return running;
  const next = getTrashDeleteRules(address).finally(() => inFlight.delete(address));
  inFlight.set(address, next);
  return next;
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

/** Rust's delete rules, read once per account while the server has Trash. */
export function useDeleteRules(): {
  rules: { skipTrash: boolean; drives: DriveDeleteRule[] } | null;
  reload: () => Promise<void>;
} {
  const polkadotAddress = useAccountAddress();
  const trashEnabled = useAtomValue(driveTrashEnabledAtom);
  const [state, setState] = useAtom(deleteRulesAtom);
  const current = state && state.address === polkadotAddress ? state : null;
  const reload = useCallback(async () => {
    if (!polkadotAddress) return;
    try {
      const rules = await fetchRules(polkadotAddress);
      setState({ address: polkadotAddress, skipTrash: rules.skipTrash, drives: rules.drives, at: Date.now() });
    } catch {
      // Unread rules list no drive, which allows only Move to Trash (it can
      // be undone); they are read again once stale.
      setState((prev) =>
        prev && prev.address === polkadotAddress ? prev : { address: polkadotAddress, skipTrash: false, drives: [], at: Date.now() },
      );
    }
  }, [polkadotAddress, setState]);
  useEffect(() => {
    if (!trashEnabled || !polkadotAddress) return;
    if (current && Date.now() - current.at < RULES_FRESH_MS) return;
    void reload();
    // Read on mount, and when the account or the server's Trash changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trashEnabled, polkadotAddress, reload, current === null]);
  return { rules: current, reload };
}

/** "Skip Trash when deleting", per account, kept by Rust. Off by default. */
export function useSkipTrash(): { skipTrash: boolean; loaded: boolean; setSkipTrash: (value: boolean) => Promise<void> } {
  const polkadotAddress = useAccountAddress();
  const { rules, reload } = useDeleteRules();
  const setState = useSetAtom(deleteRulesAtom);
  const setSkipTrash = useCallback(
    async (value: boolean) => {
      if (!polkadotAddress) return;
      setState((prev) => (prev && prev.address === polkadotAddress ? { ...prev, skipTrash: value } : prev));
      try {
        await saveSkipTrash(polkadotAddress, value);
      } finally {
        // The drives' rules follow the setting, and a refusal puts it back.
        await reload();
      }
    },
    [polkadotAddress, setState, reload],
  );
  return { skipTrash: rules?.skipTrash === true, loaded: rules !== null, setSkipTrash };
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

/** The mode a Delete of `files` runs in right now. */
export function useDeleteMode(files: Array<Pick<FormattedUserFile, "label">>): DeleteMode {
  const trashEnabled = useAtomValue(driveTrashEnabledAtom);
  const { rules } = useDeleteRules();
  const optionHeld = useOptionKeyHeld();
  const scope = deleteScope(rules?.drives, files.map(rowDriveLabel));
  return resolveDeleteMode(trashEnabled, scope.skipsTrash, optionHeld, scope.canDeleteForever);
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
  modeFor: (file: Pick<FormattedUserFile, "label">) => DeleteMode;
  labelFor: (file: Pick<FormattedUserFile, "label">) => string;
  run: (file: FormattedUserFile, selectForDelete: () => void) => void;
} {
  const trashEnabled = useAtomValue(driveTrashEnabledAtom);
  const { rules } = useDeleteRules();
  const optionHeld = useOptionKeyHeld();
  const setTrash = useSetAtom(trashRequestAtom);
  const setPrompt = useSetAtom(deleteForeverPromptAtom);
  const modeFor = useCallback(
    (file: Pick<FormattedUserFile, "label">) => {
      const scope = deleteScope(rules?.drives, [rowDriveLabel(file)]);
      return resolveDeleteMode(trashEnabled, scope.skipsTrash, optionHeld, scope.canDeleteForever);
    },
    [rules, trashEnabled, optionHeld],
  );
  const labelFor = useCallback((file: Pick<FormattedUserFile, "label">) => deleteLabel(modeFor(file)), [modeFor]);
  const run = useCallback(
    (file: FormattedUserFile, selectForDelete: () => void) => {
      const mode = modeFor(file);
      if (mode === "trash") {
        setTrash({ id: Date.now() + Math.random(), files: [file] });
        return;
      }
      selectForDelete();
      if (mode === "forever") setPrompt(true);
    },
    [modeFor, setTrash, setPrompt],
  );
  return { modeFor, labelFor, run };
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
