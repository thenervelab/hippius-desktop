"use client";

import { useEffect, useRef } from "react";
import { useAtom, useSetAtom } from "jotai";

import {
  commandPaletteOpenAtom,
  rightPanelAtom,
  selectedRoomIdAtom,
} from "@/components/chat/chat-ui-atoms";
import type { RoomSummary } from "@/lib/chat/rooms";

export interface ChatShortcutRooms {
  /** Rooms in sidebar order (channels then DMs). */
  ordered: readonly RoomSummary[];
}

export interface ChatShortcutWorkspaces {
  /** Workspace ids in rail order; ⌘1 is the first. */
  ids: readonly string[];
  onSelect: (spaceId: string) => void;
}

/**
 * The workspace id for a ⌘/Ctrl+digit press, or null when the key is not a
 * digit 1–9 or there is no workspace at that position. Pure for testing.
 */
export function workspaceForDigitKey(
  key: string,
  ids: readonly string[],
): string | null {
  if (!/^[1-9]$/.test(key)) return null;
  return ids[Number(key) - 1] ?? null;
}

/** True when the key event started in a text field or contentEditable. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    // jsdom leaves this undefined; coerce so callers get a real boolean.
    target.isContentEditable === true
  );
}

/**
 * Pick the next room from `current` in `direction`; with `unreadOnly` skip
 * rooms with nothing unread. Wraps around. Pure for testing.
 */
export function nextRoomId(
  ordered: readonly RoomSummary[],
  current: string | null,
  direction: 1 | -1,
  unreadOnly: boolean,
): string | null {
  if (ordered.length === 0) return null;
  const found = ordered.findIndex((r) => r.id === current);
  // Nothing selected: Down starts at the top, Up at the bottom.
  const start = found === -1 ? (direction === 1 ? -1 : ordered.length) : found;
  for (let step = 1; step <= ordered.length; step++) {
    const idx =
      (((start + direction * step) % ordered.length) + ordered.length) %
      ordered.length;
    const room = ordered[idx];
    if (room.id === current) continue;
    if (unreadOnly && room.unread === 0) continue;
    return room.id;
  }
  return null;
}

/**
 * Slack's keyboard: Cmd/Ctrl+K opens the switcher, Cmd/Ctrl+1..9 switches
 * workspace, Alt+Up/Down moves between rooms, Alt+Shift+Up/Down between
 * unread rooms, Esc closes the right panel when nothing else owns it.
 * Ignored while typing (the composer and dialogs have their own handling).
 * Bound on `window` for the chat route only (`ChatShell` mounts it), so it
 * does not fight the app's own ⌘F (sidebar search) and zoom shortcuts.
 */
export function useChatShortcuts(
  rooms: ChatShortcutRooms,
  workspaces?: ChatShortcutWorkspaces,
): void {
  const setPaletteOpen = useSetAtom(commandPaletteOpenAtom);
  const [selectedRoomId, setSelectedRoomId] = useAtom(selectedRoomIdAtom);
  const [rightPanel, setRightPanel] = useAtom(rightPanelAtom);
  const latest = useRef({ rooms, selectedRoomId, rightPanel, workspaces });
  latest.current = { rooms, selectedRoomId, rightPanel, workspaces };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (
        mod &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // ⌘1..⌘9 (Slack): switch workspace. The webview has no tabs to
      // reserve these for, unlike the browser console.
      if (
        mod &&
        !event.shiftKey &&
        !event.altKey &&
        latest.current.workspaces
      ) {
        const { ids, onSelect } = latest.current.workspaces;
        const target = workspaceForDigitKey(event.key, ids);
        if (target) {
          event.preventDefault();
          onSelect(target);
          return;
        }
      }
      if (
        event.altKey &&
        !mod &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        const { rooms: r, selectedRoomId: cur } = latest.current;
        const next = nextRoomId(
          r.ordered,
          cur,
          event.key === "ArrowDown" ? 1 : -1,
          event.shiftKey,
        );
        if (next) {
          event.preventDefault();
          setSelectedRoomId(next);
        }
        return;
      }
      if (
        event.key === "Escape" &&
        !isTypingTarget(event.target) &&
        latest.current.rightPanel
      ) {
        // Radix dialogs stop propagation of their own Escape, so reaching
        // here means no overlay is open.
        setRightPanel(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setPaletteOpen, setSelectedRoomId, setRightPanel]);
}
