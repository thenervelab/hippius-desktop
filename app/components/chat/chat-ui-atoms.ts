import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { chatConfigAtom } from "@/app/lib/global-atoms/chatAtoms";

/**
 * Chat surface UI state: which room is open, what the right panel shows,
 * which composer mode is active. Feature-local presentation state; only
 * `autoplayGifsAtom` is persisted (a display preference, like the theme).
 *
 * The feature gate and the Rust-decided configuration live in
 * `app/lib/global-atoms/chatAtoms.ts`; this file never decides anything
 * Rust owns.
 */

export type RightPanelState =
  | null
  | { kind: "thread"; roomId: string; rootEventId: string }
  | { kind: "details"; roomId: string }
  | { kind: "member"; roomId: string; userId: string };

export const selectedRoomIdAtom = atom<string | null>(null);
export const rightPanelAtom = atom<RightPanelState>(null);
/** Sidebar drawer when the window is too narrow for a static column. */
export const sidebarDrawerOpenAtom = atom(false);
/** The "New message" (start a DM) dialog. */
export const newMessageOpenAtom = atom(false);
/** Event to scroll to and flash once the timeline has it (switches room if needed). */
export const jumpToEventAtom = atom<{ roomId: string; eventId: string } | null>(null);
/** Event currently being edited in the composer (main timeline or thread). */
export const editingEventIdAtom = atom<string | null>(null);
/** Event being replied to (quote-reply outside a thread). */
export const replyToEventIdAtom = atom<string | null>(null);

/**
 * Whether animated images play without hovering. Presentation only, so it
 * stays in the webview's localStorage rather than the Rust preference
 * table (which holds the notification policy).
 */
export const autoplayGifsAtom = atomWithStorage<boolean>("hippius.chat.autoplayGifs", true);

/**
 * The Matrix server name (`hippius.com`), read from the Rust-provided
 * config. Falls back to the empty string before the config lands; callers
 * that build user ids must treat that as "not ready", never as a domain.
 */
export const chatServerNameAtom = atom((get) => get(chatConfigAtom)?.serverName ?? "");
