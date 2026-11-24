// Typed calls to Rust's Devices commands (`src-tauri/src/devices`), and the
// file details' extra fields. Rust owns the server calls, the labels and every
// sentence; these only carry the arguments.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** One phone or computer linked to the account. */
export interface AccountDevice {
  deviceId: string;
  /** The server's platform: `android`, `ios`, `macos`, `windows`, `linux`, or a later one. */
  platform: string;
  /** "iPhone", "Android", "Mac", "Windows", "Linux", else "Device". */
  platformName: string;
  /** Which icon: a phone, a computer, or a generic device. */
  kind: "phone" | "computer" | "other";
  /** `model_name`, else `name`, else "Device"; a repeated label gets " (2)", " (3)" by age. */
  label: string;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds. */
  lastActiveAt: number;
  /** The computer this app runs on. */
  isThisDevice: boolean;
}

export interface DeviceListing {
  /**
   * `false`: the server refuses devices for this account (a 404/403 that a
   * retry won't change). Show "Devices aren't available on this account yet."
   */
  available: boolean;
  /** This computer first, then the most recently active. */
  devices: AccountDevice[];
}

/** List the account's linked devices. Rejects with Rust's sentence when it can't. */
export function listAccountDevices(accountId: string): Promise<DeviceListing> {
  return invoke<DeviceListing>("list_account_devices", { accountId });
}

/** Unlink one device. Refuses this computer's own id (sign out removes it). */
export function unlinkAccountDevice(accountId: string, deviceId: string): Promise<void> {
  return invoke<void>("unlink_account_device", { accountId, deviceId });
}

/**
 * Rust signed the account out because this computer was unlinked from
 * another device. Already signed out on the Rust side when this arrives: the
 * webview clears its own state and shows the notice on the sign-in screen.
 */
export const THIS_DEVICE_UNLINKED_EVENT = "this_device_unlinked";

export interface ThisDeviceUnlinked {
  accountId: string;
}

export function onThisDeviceUnlinked(handler: (payload: ThisDeviceUnlinked) => void): Promise<UnlistenFn> {
  return listen<ThisDeviceUnlinked>(THIS_DEVICE_UNLINKED_EVENT, (event) => handler(event.payload));
}

/** The file details' extra rows; each is `null` when there is nothing to show. */
export interface FileSourceDetails {
  /** Unix seconds, already checked to be a believable date. */
  takenAt: number | null;
  modifiedAt: number | null;
  /** "Canon EOS R5", "Apple iPhone 15 Pro Max". */
  camera: string | null;
  /** The label of the device that uploaded it (as in Settings › Devices). */
  uploadedFrom: string | null;
}

export interface FileSourceTarget {
  /** The label the row was listed under (drive, or a `shared:`/`grant:` browse label). */
  label?: string | null;
  /** Explicit drive identity, both or neither (the Starred page's rows). */
  ownerSs58?: string | null;
  folderHash?: string | null;
  /** 64-hex path hash. */
  fileId: string;
}

/** The file's capture dates, camera and uploading device. Never rejects for a missing answer: all `null`. */
export function getFileSourceDetails(accountId: string, target: FileSourceTarget): Promise<FileSourceDetails> {
  return invoke<FileSourceDetails>("get_file_source_details", { accountId, target });
}
