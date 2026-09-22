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

/**
 * The workspace (Space) the sidebar is scoped to. `null` until resolved from
 * the remembered value / the first joined Space, or when there is none
 * (onboarding). `useWorkspaces` owns the reconciliation and persistence.
 */
export const activeWorkspaceIdAtom = atom<string | null>(null);
export const createWorkspaceOpenAtom = atom(false);
export const joinWorkspaceOpenAtom = atom(false);
/** "Invite people to <workspace>": by handle, or an invite link minted through Rust. */
export const invitePeopleOpenAtom = atom(false);

/** Sections of the chat Preferences dialog. */
export type ChatSettingsTab = "account" | "notifications" | "encryption" | "devices";
/** The Preferences dialog: the section to open on, or `false` when closed. */
export const chatSettingsOpenAtom = atom<ChatSettingsTab | false>(false);

/** Sidebar drawer when the window is too narrow for a static column. */
export const sidebarDrawerOpenAtom = atom(false);
/** The "New message" (start a DM) dialog. */
export const newMessageOpenAtom = atom(false);
export const createChannelOpenAtom = atom(false);
/** Category preselected in the "New channel" dialog (the one whose "+" was clicked); null = uncategorised. */
export const createChannelCategoryAtom = atom<string | null>(null);
/** "Move to…" dialog: the channel being moved, or null when closed. */
export const moveChannelAtom = atom<string | null>(null);
/** Event to scroll to and flash once the timeline has it (switches room if needed). */
export const jumpToEventAtom = atom<{ roomId: string; eventId: string } | null>(null);
/**
 * Which composer a message action belongs to: a room's main composer
 * (`threadRootId: null`) or the composer of one thread panel. A room can
 * show both at once, so edit / reply state is keyed by scope and each
 * composer only acts on a target minted for its own scope. Before this, a
 * single event id was shared: an edit started on a thread's root from the
 * thread panel was picked up by the main composer too, whose next send
 * silently replaced that root message instead of posting a new one.
 */
export interface ComposerScope {
  roomId: string;
  threadRootId: string | null;
}

/** An event a composer is editing or replying to, with the composer it was chosen from. */
export interface ComposerTarget extends ComposerScope {
  eventId: string;
}

/** `target.eventId` when `target` was minted for `scope`; otherwise `null`. */
export function targetEventIdFor(target: ComposerTarget | null, scope: ComposerScope): string | null {
  if (!target) return null;
  return target.roomId === scope.roomId && target.threadRootId === scope.threadRootId ? target.eventId : null;
}

/** Event currently being edited, scoped to the composer the edit began in. */
export const editingTargetAtom = atom<ComposerTarget | null>(null);
/** Event being replied to (quote-reply), scoped to the composer the reply began in. */
export const replyTargetAtom = atom<ComposerTarget | null>(null);

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

/**
 * The public community Space's alias (`#hippius:hippius.com`), decided by
 * Rust. Empty before the config lands: `spaces.ts` then marks no workspace
 * as the community and `joinCommunity` has nothing to join, which the UI
 * treats as "not ready" (the config is loaded before chat renders anyway).
 */
export const chatCommunitySpaceAliasAtom = atom((get) => get(chatConfigAtom)?.communitySpaceAlias ?? "");
