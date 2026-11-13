// Moving files and folders to ANOTHER drive. Rust (`sync::drive_move`)
// owns every rule and every sentence; this only calls it, asks the person
// what Rust asks, and reports. Kept free of React and toasts so the flow is
// testable on its own (`__tests__/driveMoves.test.ts`).

import { invoke } from "@tauri-apps/api/core";
import type { ClashChoice, MoveItem, MoveItemResult } from "./moveLogic";
import type { Clash, ClashAnswers } from "./runMove";

/** A drive the person can move things into, as Rust lists it. */
export interface MoveDestination {
  label: string;
  name: string;
  /** Not synced on this computer. */
  remote: boolean;
  syncPath: string | null;
  /** Somebody else's drive, shared with this account. */
  shared: boolean;
}

export interface DriveMoveOutcome {
  results: MoveItemResult[];
  /** A moved folder is shared: confirm this sentence before it moves. */
  confirm: string | null;
  /** What the commit turned off, for the success message. */
  revoked: string | null;
  cancelled: boolean;
  /** A preflight found nothing more to ask: the move can start. */
  ready: boolean;
}

export interface DriveMoveRequest {
  jobId: string;
  sourceLabel: string;
  destLabel: string;
  destination: string;
  items: { path: string; isFolder: boolean; onClash: ClashChoice }[];
  confirmSharing: boolean;
  /** Ask only: Rust answers clashes, the confirmation or `ready`, and moves nothing. */
  preflight: boolean;
  /** The destination's name, for the widget's rows. */
  destName?: string;
}

/** Drives the person can move into, leaving out the one `currentLabel` names. */
export function listMoveDestinations(accountId: string, currentLabel: string): Promise<MoveDestination[]> {
  return invoke<MoveDestination[]>("list_move_destinations", { accountId, currentLabel });
}

export function moveBetweenDrives(accountId: string, request: DriveMoveRequest): Promise<DriveMoveOutcome> {
  return invoke<DriveMoveOutcome>("move_between_drives", { accountId, request });
}

export function cancelDriveMove(jobId: string): Promise<boolean> {
  return invoke<boolean>("cancel_drive_move", { jobId });
}

/** What the flow asks the person, and when the long part starts. */
export interface DriveMoveHooks {
  /** Names taken in the destination: Keep both or Skip for each. */
  askClashes: (clashes: Clash[]) => Promise<ClashAnswers | null>;
  /** A moved folder is shared: go ahead? */
  confirmSharing: (sentence: string) => Promise<boolean>;
  /** The move itself begins (copies are being made). */
  onStart: () => void;
}

/**
 * Run a move between drives. A preflight asks Rust, changing nothing, for
 * the names already taken and then for what moving a shared folder turns
 * off; the person answers each, and only then does the move itself start.
 * An unanswered clash is a skip; a declined confirmation moves nothing.
 */
export async function runDriveMove(
  accountId: string,
  base: { jobId: string; sourceLabel: string; destLabel: string; destination: string; destName?: string },
  items: MoveItem[],
  hooks: DriveMoveHooks,
  send: typeof moveBetweenDrives = moveBetweenDrives,
): Promise<DriveMoveOutcome> {
  const choices = new Map<string, ClashChoice>(items.map((i) => [i.path, "ask"]));
  const request = (preflight: boolean, confirmSharing: boolean): DriveMoveRequest => ({
    ...base,
    preflight,
    confirmSharing,
    items: items
      .filter((i) => choices.get(i.path) !== "skip")
      .map((i) => ({ path: i.path, isFolder: i.isFolder, onClash: choices.get(i.path) ?? "ask" })),
  });
  const nothingMoved = (cancelled: boolean): DriveMoveOutcome => ({
    results: items.map((i) => ({
      path: i.path,
      isFolder: i.isFolder,
      status: "skipped",
      newPath: null,
      message: null,
      clashIsFolder: false,
      replaced: false,
    })),
    confirm: null,
    revoked: null,
    cancelled,
    ready: false,
  });

  let check = await send(accountId, request(true, false));
  const clashes: Clash[] = check.results
    .filter((r) => r.status === "clash")
    .map((r) => ({
      item: items.find((i) => i.path === r.path) ?? { path: r.path, isFolder: r.isFolder, name: r.path },
      takenByFolder: r.clashIsFolder,
    }));
  if (clashes.length > 0) {
    const answers = await hooks.askClashes(clashes);
    for (const c of clashes) {
      // Replace is never offered between drives.
      choices.set(c.item.path, answers?.get(c.item.path) === "keepBoth" ? "keepBoth" : "skip");
    }
    if (request(true, false).items.length === 0) return nothingMoved(false);
    check = await send(accountId, request(true, false));
  }
  let confirmed = false;
  if (check.confirm) {
    if (!(await hooks.confirmSharing(check.confirm))) return nothingMoved(true);
    confirmed = true;
    check = await send(accountId, request(true, true));
  }
  // Nothing to move (every item skipped or failed), or a new clash.
  if (!check.ready) return check;

  hooks.onStart();
  return send(accountId, request(false, confirmed));
}

/** "Moved to Photos in Team", or "Moved to Team" at the drive's top level. */
export function movedToDriveMessage(moved: number, destination: string, destinationName: string, driveName: string): string | null {
  if (moved === 0) return null;
  return destination ? `Moved to ${destinationName} in ${driveName}` : `Moved to ${driveName}`;
}
