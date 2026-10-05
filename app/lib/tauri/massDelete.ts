// Typed wrappers around the large-delete prompt's IPC commands and events.
//
// Rust (`src-tauri/src/sync/drive/mass_delete.rs`, `sync/mass_delete_hold.rs`)
// decides everything: which hold stands, its count, whether this account may
// restore it, and whether an answer is still valid. This module only moves
// those decisions across the boundary and names the refusals so the prompt can
// branch on them. Payload keys are pinned on the Rust side
// (`mass_delete_payloads_pin_their_wire_keys` in `sync/projection/events.rs`).

import { invoke } from "@tauri-apps/api/core";
import { isNotReady } from "@/app/lib/utils/dispatchTauriError";

/** Which copies the held deletes would remove: `server` = files missing on
 *  this device (Hippius keeps them), `local` = files missing from Hippius
 *  (this device keeps them). */
export type MassDeleteSide = "server" | "local";

/** Rust's `MassDeleteHoldPayload`: one drive side's held mass delete. */
export interface MassDeleteHold {
  label: string;
  side: MassDeleteSide;
  /** `held`: waiting for the user. `restoring`: the last cycle restored it. */
  state: "held" | "restoring";
  /** The count every answer must be sent with. */
  count: number;
  /** The synced baseline `count` was measured against. */
  syncedCount: number;
  /** The drive folder looks disconnected (server side only). */
  emptyRoot: boolean;
  /** False for a local-side hold on a shared drive this account is a member
   *  of: only the owner can put those files back. */
  canRestore: boolean;
}

/** Rust's `MassDeleteSidePayload` (`hcfs_mass_delete_cleared`). */
export interface MassDeleteSidePayload {
  label: string;
  side: MassDeleteSide;
}

/** Rust's `MassDeleteRestoredPayload` (`hcfs_mass_delete_restored`). */
export interface MassDeleteRestoredPayload extends MassDeleteSidePayload {
  restored: number;
  pending: number;
  skipped: number;
}

/** Rust's `MassDeleteRestoreRefusedPayload`. */
export interface MassDeleteRestoreRefusedPayload extends MassDeleteSidePayload {
  /** hcfs's stable reason name; `insufficient_space` today. */
  reason: string;
  neededBytes: number | null;
}

/** Rust's `MassDeleteNotifyPayload`: the episode's notification, written by Rust. */
export interface MassDeleteNotifyPayload extends MassDeleteSidePayload {
  description: string;
}

export const MASS_DELETE_EVENTS = {
  held: "hcfs_mass_delete_held",
  heldNotify: "hcfs_mass_delete_held_notify",
  cleared: "hcfs_mass_delete_cleared",
  restored: "hcfs_mass_delete_restored",
  restoreRefused: "hcfs_mass_delete_restore_refused",
} as const;

/** Every drive's current hold, for hydration on start or reload. */
export function getMassDeleteHolds(): Promise<MassDeleteHold[]> {
  return invoke<MassDeleteHold[]>("get_mass_delete_holds");
}

/** Put the held files back on the side that lost them. `count` is the count
 *  the prompt showed; Rust refuses any other. */
export function restoreMassDelete(
  label: string,
  side: MassDeleteSide,
  count: number,
): Promise<void> {
  return invoke<void>("restore_mass_delete", { label, side, count });
}

/** Let the held deletes go ahead. Same validation as {@link restoreMassDelete}. */
export function confirmMassDelete(
  label: string,
  side: MassDeleteSide,
  count: number,
): Promise<void> {
  return invoke<void>("confirm_mass_delete", { label, side, count });
}

/** Why Rust refused an answer, by structured `subkind` (never by message). */
export type MassDeleteAnswerError =
  /** The hold is gone (a cycle cleared it): refresh the prompt. */
  | { type: "nothingHeld" }
  /** The hold changed since it was shown: show `held` and ask again. */
  | { type: "holdChanged"; held: number }
  | { type: "restoreInProgress" }
  /** A shared-drive member cannot restore this side: hide Restore. */
  | { type: "memberCannotRestore" }
  | { type: "other" };

/** Classify a rejection from {@link restoreMassDelete} / {@link confirmMassDelete}. */
export function classifyMassDeleteError(error: unknown): MassDeleteAnswerError {
  if (isNotReady(error, "MASS_DELETE_NOTHING_HELD")) return { type: "nothingHeld" };
  if (isNotReady(error, "MASS_DELETE_HOLD_CHANGED")) {
    const held = (error as { held?: unknown }).held;
    // Rust always sends `held` with this subkind; without it there is no
    // count to ask again with, so the prompt refreshes instead.
    return typeof held === "number" ? { type: "holdChanged", held } : { type: "nothingHeld" };
  }
  if (isNotReady(error, "MASS_DELETE_RESTORE_IN_PROGRESS")) return { type: "restoreInProgress" };
  if (isNotReady(error, "MASS_DELETE_MEMBER_CANNOT_RESTORE")) {
    return { type: "memberCannotRestore" };
  }
  return { type: "other" };
}
