// Typed wrappers around the empty-drive prompt's IPC commands and events.
//
// Rust (`src-tauri/src/sync/drive/empty_remote_prompt.rs`,
// `sync/failure/empty_remote.rs`) decides everything: which drives hcfs is
// refusing an empty listing for, whether this account may confirm, and
// whether a confirmation is still valid. This module only moves those
// decisions across the boundary and names the refusals so the prompt can
// branch on them. Payload keys are pinned on the Rust side
// (`empty_remote_payload_pins_its_wire_keys` in `sync/projection/events.rs`).

import { invoke } from "@tauri-apps/api/core";
import { isNotReady, tauriErrorDetail } from "@/app/lib/utils/dispatchTauriError";

/** Rust's `EmptyRemotePayload`: one drive whose server listing came back
 *  empty while this device still has its files. */
export interface EmptyRemoteDrive {
  label: string;
  /** How many synced files this device still has for the drive. */
  syncedCount: number;
  /** False on a shared drive this account is a member of: only the owner
   *  can confirm the drive is empty. */
  canConfirm: boolean;
  /** The banner's title, written by Rust: the same words the notification
   *  opens with. */
  title: string;
  /** The banner's lines under the title, written by Rust. */
  body: string[];
}

/** Payload of `hcfs_empty_remote_cleared` and `hcfs_empty_remote_notify`. */
export interface EmptyRemoteLabelPayload {
  label: string;
}

export const EMPTY_REMOTE_EVENTS = {
  held: "hcfs_empty_remote_held",
  /** Rust saved the episode's notification: refresh the bell. */
  notify: "hcfs_empty_remote_notify",
  cleared: "hcfs_empty_remote_cleared",
} as const;

/** Every drive's current prompt, for hydration on start or reload. */
export function getEmptyRemoteDrives(): Promise<EmptyRemoteDrive[]> {
  return invoke<EmptyRemoteDrive[]>("get_empty_remote_drives");
}

/** Confirm the drive really is empty: the next sync removes this device's
 *  copies. Rust refuses a member, and a drive no longer waiting. */
export function confirmEmptyRemote(label: string): Promise<void> {
  return invoke<void>("confirm_empty_remote", { label });
}

/** Why Rust refused a confirmation, by structured `subkind` (never by
 *  message). `message` is Rust's sentence for it, shown as is. */
export type EmptyRemoteAnswerError =
  /** The drive is no longer waiting (a sync accepted a listing): refresh. */
  | { type: "nothingHeld"; message: string }
  /** A shared-drive member cannot confirm: hide the option. */
  | { type: "memberCannotConfirm"; message: string }
  | { type: "other" };

/** Classify a rejection from {@link confirmEmptyRemote}. */
export function classifyEmptyRemoteError(error: unknown): EmptyRemoteAnswerError {
  const message = tauriErrorDetail(error);
  if (isNotReady(error, "EMPTY_REMOTE_NOTHING_HELD")) return { type: "nothingHeld", message };
  if (isNotReady(error, "EMPTY_REMOTE_MEMBER_CANNOT_CONFIRM")) {
    return { type: "memberCannotConfirm", message };
  }
  return { type: "other" };
}
