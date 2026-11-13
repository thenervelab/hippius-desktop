// Runs one move through `move_entries`, asking about name clashes in
// between. Kept free of React and toasts so the flow is testable on its
// own; `useDriveMove` adds the words and the Undo.

import { invoke } from "@tauri-apps/api/core";
import type { ClashChoice, MoveItem, MoveItemResult } from "./moveLogic";

/** Where a move happens: the drive, and whether it is only browsed here. */
export interface MoveDrive {
  label: string;
  remote: boolean;
}

export interface MoveRequestItem {
  path: string;
  isFolder: boolean;
  /** A target name; Undo uses it to bring "a (1).txt" back as "a.txt". */
  name?: string;
  onClash?: ClashChoice;
}

/** One clash the user is asked about. */
export interface Clash {
  item: MoveItem;
  /** The name is taken by a folder, so Replace is not offered. */
  takenByFolder: boolean;
}

/** The answer to the clashes: one choice per item path. */
export type ClashAnswers = Map<string, Exclude<ClashChoice, "ask">>;

export function moveEntries(
  accountId: string,
  drive: MoveDrive,
  destination: string,
  items: MoveRequestItem[],
): Promise<MoveItemResult[]> {
  return invoke<{ results: MoveItemResult[] }>("move_entries", {
    accountId,
    request: {
      label: drive.label,
      remote: drive.remote,
      destination,
      items: items.map((item) => ({
        path: item.path,
        isFolder: item.isFolder,
        name: item.name ?? null,
        onClash: item.onClash ?? "ask",
      })),
    },
  }).then((r) => r.results);
}

/**
 * Move `items`, then ask about the ones whose name is taken and move those
 * as answered. Nothing clashing moves before the user answers, and an
 * unanswered clash (the dialog closed) is a skip.
 */
export async function runMove(
  accountId: string,
  drive: MoveDrive,
  destination: string,
  items: MoveItem[],
  askClashes: (clashes: Clash[]) => Promise<ClashAnswers | null>,
  send: typeof moveEntries = moveEntries,
): Promise<MoveItemResult[]> {
  const first = await send(accountId, drive, destination, items);
  const clashes: Clash[] = first
    .filter((r) => r.status === "clash")
    .map((r) => ({
      item: items.find((i) => i.path === r.path) ?? { path: r.path, isFolder: r.isFolder, name: r.path },
      takenByFolder: r.clashIsFolder,
    }));
  if (clashes.length === 0) return first;

  const answers = await askClashes(clashes);
  const retry = clashes
    .map((c) => ({ path: c.item.path, isFolder: c.item.isFolder, onClash: answers?.get(c.item.path) ?? "skip" }))
    .filter((item) => item.onClash !== "skip");
  const second = retry.length > 0 ? await send(accountId, drive, destination, retry) : [];

  return first.map((r) => {
    if (r.status !== "clash") return r;
    return second.find((s) => s.path === r.path) ?? { ...r, status: "skipped" as const };
  });
}
