// "This computer was unlinked": Rust signed the account out because another
// device removed this computer from it (`this_device_unlinked`), and the
// sign-in screen says so once. The atom carries it across the navigation to
// `/login`; localStorage carries it across a reload or a restart, so a person
// who quit before reading it still learns why they are signed out. Both are
// cleared by the dialog's OK. Storage can be unavailable; the atom alone then
// still shows it in this session.

import { atom } from "jotai";

import { appStore } from "@/app/lib/store/jotaiStore";

export const DEVICE_UNLINKED_NOTICE_KEY = "hippius:device-unlinked-notice";

export const deviceUnlinkedNoticeAtom = atom(false);

/** Show the notice on the sign-in screen (now, and after a reload until OK). */
export function rememberDeviceUnlinkedNotice(): void {
  appStore.set(deviceUnlinkedNoticeAtom, true);
  try {
    window.localStorage.setItem(DEVICE_UNLINKED_NOTICE_KEY, "1");
  } catch {
    // No storage: the atom still shows it until the app closes.
  }
}

/** Whether a notice is waiting from an earlier session or reload. */
export function storedDeviceUnlinkedNotice(): boolean {
  try {
    return window.localStorage.getItem(DEVICE_UNLINKED_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

/** The notice was read. */
export function forgetDeviceUnlinkedNotice(): void {
  appStore.set(deviceUnlinkedNoticeAtom, false);
  try {
    window.localStorage.removeItem(DEVICE_UNLINKED_NOTICE_KEY);
  } catch {
    // Nothing stored to clear.
  }
}
