// Words and dates for Settings › Devices. Pure, so the wording and the
// calendar-day arithmetic are pinned without rendering anything. The labels
// themselves (model, name, " (2)") come from Rust, which also labels the
// file details' "Uploaded from", so the two always agree.

import type { AccountDevice } from "@/app/lib/tauri/devices";

export const DEVICES_TITLE = "Devices";
export const DEVICES_DESCRIPTION = "Phones and computers linked to your account.";
export const DEVICES_EMPTY = "No devices yet. A phone or computer shows here once it signs in.";
export const DEVICES_LOAD_ERROR = "Couldn't load your devices.";
export const DEVICES_UNAVAILABLE = "Devices aren't available on this account yet.";
export const THIS_DEVICE_PILL = "This device";
export const UNLINK_BUTTON = "Unlink";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/** Local midnight of the day `ms` falls on. */
function localDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * When a device was last active, in calendar days of the reader's own time
 * zone: a device active at 23:50 yesterday is "yesterday" at 00:10 today,
 * however few minutes ago that was.
 *
 * `lastActiveAt` falls back to `createdAt` when the server has no activity
 * (0). A date in the future (another clock running ahead) reads as today.
 */
export function deviceActivityText(lastActiveAt: number, createdAt: number, nowMs: number = Date.now()): string {
  const seconds = lastActiveAt > 0 ? lastActiveAt : createdAt;
  const ms = seconds * 1000;
  // `Math.round`: a day across a daylight-saving change is 23 or 25 hours.
  const days = Math.round((localDay(nowMs) - localDay(ms)) / DAY_MS);
  if (days <= 0) return "Active today";
  if (days === 1) return "Active yesterday";
  if (days < 7) return `Active ${days} days ago`;
  const d = new Date(ms);
  return `Active ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** The row's second line: "iPhone · Active today". */
export function deviceSubtitle(device: AccountDevice, nowMs: number = Date.now()): string {
  return `${device.platformName} · ${deviceActivityText(device.lastActiveAt, device.createdAt, nowMs)}`;
}

/** A name in a message, in straight quotes as the app's other toasts quote one. */
export function quoted(name: string): string {
  return `"${name}"`;
}

export function unlinkTitle(label: string): string {
  // Unquoted, as the phone app and the web Drive title it.
  return `Unlink ${label}?`;
}

export function unlinkedToast(label: string): string {
  return `${quoted(label)} unlinked`;
}

export function unlinkFailedToast(label: string): string {
  return `Couldn't unlink ${quoted(label)}. Try again.`;
}

/**
 * What unlinking does, in the confirm dialog: a phone and a computer lose
 * different things, and a platform this app does not know only leaves the
 * list. The same wording as the phone app and the web Drive.
 */
export interface UnlinkBody {
  /** One line each, shown as a bulleted list; empty for an unknown platform. */
  bullets: string[];
  /** The line under them (the whole message when there are none). */
  closing: string;
}

export function unlinkBody(kind: AccountDevice["kind"]): UnlinkBody {
  if (kind === "phone") {
    return {
      bullets: ["Files kept offline on it are deleted from it.", "Camera Uploads stops on it."],
      closing:
        "Everything it uploaded stays in your drive. Sign in on it again anytime, and its backup continues where it left off.",
    };
  }
  if (kind === "computer") {
    return {
      bullets: ["It's signed out the next time it's open and online, and stops syncing."],
      closing: "Everything it uploaded stays in your drive. Sign in on it again anytime to link it back.",
    };
  }
  return {
    bullets: [],
    closing: "It's removed from your devices. Everything it uploaded stays in your drive.",
  };
}
